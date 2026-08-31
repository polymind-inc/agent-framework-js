import {
  type Message as A2AMessage,
  type Artifact,
  type Part,
  Role,
  type StreamResponse,
  type Task,
  TaskState,
  type TaskStatusUpdateEvent,
  taskStateToJSON,
} from '@a2a-js/sdk';
import {
  type AgentResponseUpdate,
  agentResponseUpdate,
  type Content,
  dataContent,
  decodeBase64,
  type Message,
  textContent,
  unknownContent,
  uriContent,
} from '@polymind-inc/agent-framework-core';
import { a2aContinuationToken } from './continuation.js';
import { A2AAgentError } from './errors.js';

/** What a `raw` part is called when the agent did not say. */
const DEFAULT_BINARY_MEDIA_TYPE = 'application/octet-stream';

/** Stands in for an error content that carries no message of its own. */
const DEFAULT_ERROR_TEXT = 'An error occurred.';

/** A payload of a `StreamResponse`, which is also how a non-streaming result is handled. */
export type A2APayload = NonNullable<StreamResponse['payload']>;

/**
 * What a run learned about the remote conversation while its events went by.
 *
 * Every identity field is explicitly resettable: a turn that came back as a plain message ended on
 * no task, and the session has to record that rather than keep the previous turn's.
 */
export interface ObservedTaskState {
  contextId?: string | undefined;
  taskId?: string | undefined;
  /** The protocol spelling, e.g. `TASK_STATE_WORKING`. */
  taskState?: string | undefined;
  /**
   * Keys of artifacts already surfaced by streamed artifact-update events, so a terminal task
   * snapshot repeating them does not emit them twice. Per-run bookkeeping, never persisted: the
   * session writer copies the identity fields one by one and leaves this behind.
   */
  streamedArtifacts?: Set<string>;
}

/** An artifact id is only unique within its task, so the dedup key carries both. */
function artifactKey(taskId: string, artifactId: string): string {
  return `${taskId}\u0000${artifactId}`;
}

function omitEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

// region outbound: framework content -> A2A parts

function bytesFromDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  const prefix = comma === -1 ? uri : uri.slice(0, comma);
  if (!prefix.startsWith('data:') || !prefix.includes(';base64')) {
    // Only the prefix is quoted: the payload is the caller's data and does not belong in an error.
    throw new A2AAgentError(
      `Data content must carry a base64 data URI to be sent to an A2A agent; got '${prefix}'.`,
    );
  }
  return decodeBase64(uri.slice(comma + 1));
}

function makePart(
  content: NonNullable<Part['content']>,
  source: Content,
  extras?: { filename?: string; mediaType?: string },
): Part {
  return {
    content,
    metadata: source.additionalProperties,
    // Empty strings are how this SDK spells "absent"; both fields are dropped from the wire.
    filename: extras?.filename ?? '',
    mediaType: extras?.mediaType ?? '',
  };
}

function toA2APart(content: Content): Part | undefined {
  switch (content.type) {
    case 'text':
      // An empty text part carries nothing and some agents reject one.
      return content.text === '' ? undefined : makePart({ $case: 'text', value: content.text }, content);
    case 'error':
      return makePart({ $case: 'text', value: content.message ?? DEFAULT_ERROR_TEXT }, content);
    case 'uri':
      return makePart({ $case: 'url', value: content.uri }, content, {
        ...(content.mediaType === undefined ? {} : { mediaType: content.mediaType }),
        ...(content.name === undefined ? {} : { filename: content.name }),
      });
    case 'data':
      return makePart(
        // The SDK types raw bytes as a Node `Buffer`, but only reads them as a byte array: the
        // transport base64-encodes the value. Keeping a plain `Uint8Array` is what lets this
        // package stay free of Node-only APIs.
        { $case: 'raw', value: bytesFromDataUri(content.uri) } as NonNullable<Part['content']>,
        content,
        {
          mediaType: content.mediaType,
          ...(content.name === undefined ? {} : { filename: content.name }),
        },
      );
    case 'hosted_file':
      return makePart({ $case: 'url', value: content.fileId }, content, {
        ...(content.name === undefined ? {} : { filename: content.name }),
      });
    default:
      // Function calls, results, reasoning and usage have no place in the A2A content model.
      // Dropping them keeps a conversation that happens to hold one sendable rather than failing
      // on content the protocol simply does not carry.
      return undefined;
  }
}

/** Converts framework content to A2A parts, skipping anything the protocol cannot express. */
export function toA2AParts(contents: readonly Content[]): Part[] {
  const parts: Part[] = [];
  for (const content of contents) {
    const part = toA2APart(content);
    if (part !== undefined) {
      parts.push(part);
    }
  }
  return parts;
}

/**
 * Builds the single message a turn sends.
 *
 * Every input message is flattened into one A2A message, sent as `user`: A2A models a turn as one
 * message from the client, and the roles of a locally assembled conversation are not part of what
 * the remote agent is being asked.
 *
 * How the message links to the previous task decides whether this is an answer or a follow-up: a
 * task waiting for input is continued in place (`taskId`), any other task is referenced as prior
 * context (`referenceTaskIds`).
 */
export function toA2AMessage(
  messages: readonly Message[],
  link: { contextId?: string; taskId?: string; taskState?: string },
  messageId: string,
): A2AMessage {
  const parts = messages.flatMap((message) => toA2AParts(message.contents));
  const continuesTask =
    link.taskId !== undefined && link.taskState === taskStateToJSON(TaskState.TASK_STATE_INPUT_REQUIRED);
  return {
    messageId,
    contextId: link.contextId ?? '',
    taskId: continuesTask ? (link.taskId ?? '') : '',
    role: Role.ROLE_USER,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: !continuesTask && link.taskId !== undefined ? [link.taskId] : [],
  };
}

// endregion

// region inbound: A2A parts -> framework content

function fromA2APart(part: Part): Content {
  const base = {
    ...(part.metadata === undefined ? {} : { additionalProperties: part.metadata }),
    rawRepresentation: part,
  };
  const name = omitEmpty(part.filename);
  const named = { ...base, ...(name === undefined ? {} : { name }) };
  switch (part.content?.$case) {
    case 'text':
      return textContent(part.content.value, base);
    case 'url':
      return uriContent(part.content.value, omitEmpty(part.mediaType), named);
    case 'raw':
      return dataContent(
        new Uint8Array(part.content.value),
        omitEmpty(part.mediaType) ?? DEFAULT_BINARY_MEDIA_TYPE,
        named,
      );
    case 'data':
      // Structured data becomes its JSON text: the framework content model has no structured-value
      // kind, and text is what every consumer of a part can already read.
      return textContent(JSON.stringify(part.content.value), base);
    default:
      // A part whose content the SDK did not recognize. Kept rather than dropped so the rest of the
      // message still round-trips.
      return unknownContent(part);
  }
}

/** Converts A2A parts to framework content. */
export function fromA2AParts(parts: readonly Part[]): Content[] {
  return parts.map(fromA2APart);
}

// endregion

// region inbound: A2A events -> response updates

type Metadata = Record<string, unknown> | undefined;

/** Merges two metadata maps, the second winning, and keeps `undefined` rather than making `{}`. */
function mergeMetadata(base: Metadata, overlay: Metadata): Metadata {
  if (base === undefined) return overlay;
  if (overlay === undefined) return base;
  return { ...base, ...overlay };
}

function update(init: {
  contents: Content[];
  responseId?: string;
  messageId?: string;
  role?: 'assistant' | 'user';
  createdAt?: string;
  finishReason?: string;
  additionalProperties?: Metadata;
  continuationToken?: { taskId: string };
  rawRepresentation: unknown;
}): AgentResponseUpdate {
  const { responseId, messageId, createdAt, finishReason, additionalProperties, continuationToken } = init;
  return agentResponseUpdate({
    contents: init.contents,
    role: init.role ?? 'assistant',
    ...(omitEmpty(responseId) === undefined ? {} : { responseId }),
    ...(omitEmpty(messageId) === undefined ? {} : { messageId }),
    ...(omitEmpty(createdAt) === undefined ? {} : { createdAt }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(additionalProperties === undefined ? {} : { additionalProperties }),
    ...(continuationToken === undefined ? {} : { continuationToken }),
    rawRepresentation: init.rawRepresentation,
  });
}

/**
 * A task is only resumable while it is still going to produce something.
 *
 * A finished task has nothing left to subscribe to, and an interrupted one (`input-required`,
 * `auth-required`) is waiting for the *caller*, not for the agent: that is continued by sending
 * the next message, not by resuming the run.
 */
function tokenFor(taskId: string, state: TaskState | undefined): { taskId: string } | undefined {
  return state === TaskState.TASK_STATE_SUBMITTED || state === TaskState.TASK_STATE_WORKING
    ? a2aContinuationToken(taskId)
    : undefined;
}

function finishReasonFor(state: TaskState | undefined): string | undefined {
  return state === TaskState.TASK_STATE_COMPLETED ? 'stop' : undefined;
}

function artifactUpdate(
  artifact: Artifact,
  responseId: string,
  metadata: Metadata,
  raw: unknown,
): AgentResponseUpdate {
  return update({
    contents: fromA2AParts(artifact.parts),
    responseId,
    messageId: artifact.artifactId,
    additionalProperties: metadata,
    rawRepresentation: raw,
  });
}

/**
 * What a task status contributes to the transcript, which is nothing unless the task is waiting
 * for input.
 *
 * Only then is the status message part of the answer: it is the question addressed to the caller,
 * so it has to be readable for the caller to answer it. A status message in any other state — the
 * progress notes of a working task, the closing remark of a `completed` one, the reason a `failed`,
 * `canceled` or `rejected` one stopped, or the challenge of an `auth-required` one — describes the
 * run rather than answering it, and folding it in would put "working on it" or "done" where the
 * answer belongs. None of it is lost: every update carries the protocol object it came from in
 * `rawRepresentation`, and the task state is on the session.
 *
 * This is the single rule for both ways a run is consumed. A whole-task snapshot (an awaited run)
 * and a status-update event (a streamed one) describe the same remote task, so they must produce
 * the same transcript. An empty result therefore also has to be left unnamed by both: a message id
 * whose content was dropped would start an empty message during folding and split the surrounding
 * artifact in two.
 */
function statusContents(state: TaskState | undefined, statusMessage: A2AMessage | undefined): Content[] {
  return state === TaskState.TASK_STATE_INPUT_REQUIRED && statusMessage !== undefined
    ? fromA2AParts(statusMessage.parts)
    : [];
}

/**
 * Turns a whole task into updates: one per artifact, plus the question it is waiting on.
 *
 * A task's own `history` is never a source of updates: it is the conversation so far, not this
 * turn's output, and replaying it would answer with messages the caller already has.
 */
function updatesFromTask(task: Task, observed: ObservedTaskState): AgentResponseUpdate[] {
  const state = task.status?.state;
  const alreadyStreamed = observed.streamedArtifacts;
  const artifacts = task.artifacts ?? [];
  const updates: AgentResponseUpdate[] = artifacts
    .filter((artifact) => !alreadyStreamed?.has(artifactKey(task.id, artifact.artifactId)))
    .map((artifact) =>
      artifactUpdate(artifact, task.id, mergeMetadata(artifact.metadata, task.metadata), task),
    );

  const statusMessage = task.status?.message;
  const question = statusContents(state, statusMessage);
  if (question.length > 0 && statusMessage !== undefined) {
    updates.push(
      update({
        contents: question,
        responseId: task.id,
        messageId: statusMessage.messageId,
        additionalProperties: mergeMetadata(statusMessage.metadata, task.metadata),
        rawRepresentation: task,
      }),
    );
  }
  if (updates.length === 0) {
    // A task that produced nothing yet is still an answer about the run: it carries the state, and
    // with it the token that resumes it.
    updates.push(
      update({
        contents: [],
        responseId: task.id,
        additionalProperties: task.metadata,
        rawRepresentation: task,
      }),
    );
  }
  const last = updates[updates.length - 1] as AgentResponseUpdate;
  const finishReason = finishReasonFor(state);
  if (finishReason !== undefined) {
    last.finishReason = finishReason;
  }
  const token = tokenFor(task.id, state);
  if (token !== undefined) {
    last.continuationToken = token;
  }
  const timestamp = omitEmpty(task.status?.timestamp);
  if (timestamp !== undefined) {
    for (const item of updates) {
      item.createdAt = timestamp;
    }
  }
  return updates;
}

function updatesFromStatusUpdate(event: TaskStatusUpdateEvent): AgentResponseUpdate[] {
  const state = event.status?.state;
  const statusMessage = event.status?.message;
  const contents = statusContents(state, statusMessage);
  const createdAt = omitEmpty(event.status?.timestamp);
  const finishReason = finishReasonFor(state);
  return [
    update({
      contents,
      responseId: event.taskId,
      // Identified only when its content was taken. Naming a message whose content was dropped
      // would put an empty one in the transcript and split the artifact around it, since a change
      // of message id is what starts a new message during folding.
      ...(contents.length === 0 || statusMessage === undefined ? {} : { messageId: statusMessage.messageId }),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(finishReason === undefined ? {} : { finishReason }),
      additionalProperties: event.metadata,
      rawRepresentation: event,
    }),
  ];
}

function updatesFromMessage(message: A2AMessage): AgentResponseUpdate[] {
  return [
    update({
      contents: fromA2AParts(message.parts),
      // A message is the whole answer: nothing follows it, so the turn is over.
      finishReason: 'stop',
      responseId: message.messageId,
      messageId: message.messageId,
      role: message.role === Role.ROLE_AGENT ? 'assistant' : 'user',
      additionalProperties: message.metadata,
      rawRepresentation: message,
    }),
  ];
}

/** Records the remote conversation shared by every payload kind, ignoring its absent wire form. */
function observeContext(observed: ObservedTaskState, contextId: string | undefined): void {
  observed.contextId = omitEmpty(contextId) ?? observed.contextId;
}

/** Records a payload's task identity without changing a state that payload did not report. */
function observeTask(observed: ObservedTaskState, contextId: string | undefined, taskId: string): void {
  observeContext(observed, contextId);
  observed.taskId = taskId;
}

/** Records a task payload that owns the current state, including resetting an omitted status. */
function observeTaskStatus(
  observed: ObservedTaskState,
  contextId: string | undefined,
  taskId: string,
  state: TaskState | undefined,
): void {
  observeTask(observed, contextId, taskId);
  observed.taskState = state === undefined ? undefined : taskStateToJSON(state);
}

/**
 * Converts one A2A payload into response updates, recording what it says about the conversation.
 *
 * `observed` is updated in place: the session is written once the run is over, from whatever the
 * last event reported, so a caller who abandons the stream leaves the session untouched.
 *
 * @throws {A2AAgentError} When the payload is of a kind this protocol version does not define.
 */
export function updatesFromPayload(payload: A2APayload, observed: ObservedTaskState): AgentResponseUpdate[] {
  switch (payload.$case) {
    case 'task': {
      const task = payload.value;
      observeTaskStatus(observed, task.contextId, task.id, task.status?.state);
      return updatesFromTask(task, observed);
    }
    case 'statusUpdate': {
      const event = payload.value;
      observeTaskStatus(observed, event.contextId, event.taskId, event.status?.state);
      return updatesFromStatusUpdate(event);
    }
    case 'artifactUpdate': {
      const event = payload.value;
      observeTask(observed, event.contextId, event.taskId);
      const artifact = event.artifact;
      if (artifact === undefined) {
        throw new A2AAgentError('The A2A agent sent an artifact update with no artifact.');
      }
      observed.streamedArtifacts ??= new Set();
      observed.streamedArtifacts.add(artifactKey(event.taskId, artifact.artifactId));
      // The event's own metadata wins over the artifact's, and neither is dropped: a streamed
      // artifact has to fold into the same content an awaited run would have returned whole.
      return [
        artifactUpdate(artifact, event.taskId, mergeMetadata(artifact.metadata, event.metadata), event),
      ];
    }
    case 'message': {
      const message = payload.value;
      observeContext(observed, message.contextId);
      return updatesFromMessage(message);
    }
    default:
      throw new A2AAgentError(
        `The A2A agent sent an unsupported payload: '${(payload as { $case: string }).$case}'.`,
      );
  }
}

// endregion
