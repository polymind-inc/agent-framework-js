import { coalesceContents } from './coalesce.js';
import type { Content, UserInputRequestContent } from './content.js';
import { textOfContents } from './content.js';
import type { Message, Role } from './message.js';
import { textOfMessages } from './message.js';
import type { UsageDetails } from './usage.js';
import { addUsage, isEmptyUsage } from './usage.js';

/**
 * Why generation stopped.
 *
 * The well-known values match the reference implementations; providers may report others.
 */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | (string & {});

/**
 * An opaque token for resuming a long-running (background) provider operation.
 *
 * Produced and consumed by the provider; the framework only passes it through. Request background
 * execution with `allowBackgroundResponses`, then resume by passing the token back via
 * `run({ continuationToken })`.
 */
export interface ContinuationToken {
  [key: string]: unknown;
}

/** Fields shared by {@link ChatResponseUpdate} and {@link AgentResponseUpdate}. */
export interface ResponseUpdateBase {
  contents: Content[];
  /** Concatenated text of every `text` content in this update. */
  readonly text: string;
  role?: Role;
  authorName?: string;
  responseId?: string;
  messageId?: string;
  /** ISO 8601 timestamp. */
  createdAt?: string;
  finishReason?: FinishReason;
  continuationToken?: ContinuationToken;
  additionalProperties?: Record<string, unknown>;
  /** Provider-specific raw object. Never serialized. */
  rawRepresentation?: unknown;
}

/** A single streamed chunk from a {@link ChatClient}. */
export interface ChatResponseUpdate extends ResponseUpdateBase {
  /** Service-side conversation id, when the provider manages history. */
  conversationId?: string;
  /** The model that produced this update. */
  model?: string;
}

/** A single streamed chunk from an agent run. */
export interface AgentResponseUpdate extends ResponseUpdateBase {
  agentId?: string;
}

/** Fields shared by {@link ChatResponse} and {@link AgentResponse}. */
export interface ResponseBase<T> {
  messages: Message[];
  /** Concatenated text of every `text` content across every message. */
  readonly text: string;
  /**
   * The parsed structured output when the run specified a `responseFormat`, otherwise `undefined`.
   */
  value: T;
  responseId?: string;
  /** ISO 8601 timestamp. */
  createdAt?: string;
  finishReason?: FinishReason;
  usageDetails?: UsageDetails;
  continuationToken?: ContinuationToken;
  additionalProperties?: Record<string, unknown>;
  /** Provider-specific raw object. Never serialized. */
  rawRepresentation?: unknown;
}

/** The complete result of a {@link ChatClient} call. */
export interface ChatResponse<T = undefined> extends ResponseBase<T> {
  conversationId?: string;
  model?: string;
}

/** The complete result of an agent run. */
export interface AgentResponse<T = undefined> extends ResponseBase<T> {
  agentId?: string;
  /**
   * Contents waiting on a human. Non-empty means the run stopped early. Answer an approval
   * request with `approvalResponse(request, approved)` and pass the results to the next `run()`
   * to continue; an OAuth consent request is settled outside the framework by visiting its
   * `consentLink`.
   */
  readonly userInputRequests: UserInputRequestContent[];
}

/** Constructor input for {@link chatResponseUpdate}: everything except the derived `text` getter. */
export type ChatResponseUpdateInit = Omit<ChatResponseUpdate, 'text'>;
/** Constructor input for {@link agentResponseUpdate}: everything except the derived `text` getter. */
export type AgentResponseUpdateInit = Omit<AgentResponseUpdate, 'text'>;
/** Constructor input for {@link chatResponse}: everything except derived getters. */
export type ChatResponseInit<T> = Omit<ChatResponse<T>, 'text' | 'value'> & { value?: T };
/** Constructor input for {@link agentResponse}: everything except derived getters. */
export type AgentResponseInit<T> = Omit<AgentResponse<T>, 'text' | 'value' | 'userInputRequests'> & {
  value?: T;
};

function defineDerived<T extends object>(target: T, key: string, get: () => unknown): T {
  Object.defineProperty(target, key, { get, enumerable: false, configurable: true });
  return target;
}

/** Creates a {@link ChatResponseUpdate} with a live `text` getter. */
export function chatResponseUpdate(init: ChatResponseUpdateInit): ChatResponseUpdate {
  const update = { ...init } as ChatResponseUpdate;
  return defineDerived(update, 'text', () => textOfContents(update.contents));
}

/** Creates an {@link AgentResponseUpdate} with a live `text` getter. */
export function agentResponseUpdate(init: AgentResponseUpdateInit): AgentResponseUpdate {
  const update = { ...init } as AgentResponseUpdate;
  return defineDerived(update, 'text', () => textOfContents(update.contents));
}

/** Creates a {@link ChatResponse} with a live `text` getter. */
export function chatResponse<T = undefined>(init: ChatResponseInit<T>): ChatResponse<T> {
  const response = { value: undefined as T, ...init } as ChatResponse<T>;
  return defineDerived(response, 'text', () => textOfMessages(response.messages));
}

/** Creates an {@link AgentResponse} with live `text` and `userInputRequests` getters. */
export function agentResponse<T = undefined>(init: AgentResponseInit<T>): AgentResponse<T> {
  const response = { value: undefined as T, ...init } as AgentResponse<T>;
  defineDerived(response, 'text', () => textOfMessages(response.messages));
  return defineDerived(response, 'userInputRequests', () =>
    response.messages.flatMap((msg) =>
      msg.contents.filter(
        (content): content is UserInputRequestContent =>
          content.type === 'function_approval_request' || content.type === 'oauth_consent_request',
      ),
    ),
  );
}

/**
 * Converts a {@link ChatResponseUpdate} into an {@link AgentResponseUpdate}.
 *
 * `authorName` falls back to the agent name, matching Python's `map_chat_to_agent_update`.
 */
export function chatToAgentUpdate(
  update: ChatResponseUpdate,
  options?: { agentName?: string; agentId?: string },
): AgentResponseUpdate {
  const init: AgentResponseUpdateInit = { contents: update.contents, rawRepresentation: update };
  const authorName = update.authorName ?? options?.agentName;
  if (update.role !== undefined) init.role = update.role;
  if (authorName !== undefined) init.authorName = authorName;
  if (options?.agentId !== undefined) init.agentId = options.agentId;
  if (update.responseId !== undefined) init.responseId = update.responseId;
  if (update.messageId !== undefined) init.messageId = update.messageId;
  if (update.createdAt !== undefined) init.createdAt = update.createdAt;
  if (update.finishReason !== undefined) init.finishReason = update.finishReason;
  if (update.continuationToken !== undefined) init.continuationToken = update.continuationToken;
  if (update.additionalProperties !== undefined) init.additionalProperties = update.additionalProperties;
  return agentResponseUpdate(init);
}

// region folding

function notEmptyNorEqual(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && a !== '' && b !== undefined && b !== '' && a !== b;
}

/** Go `isDifferentMessage`: only a non-empty, differing author/id/role starts a new message. */
function isDifferentMessage(update: ResponseUpdateBase, msg: Message): boolean {
  return (
    notEmptyNorEqual(update.authorName, msg.authorName) ||
    notEmptyNorEqual(update.messageId, msg.messageId) ||
    notEmptyNorEqual(update.role, msg.role)
  );
}

/** Go `cmp.Or`: later values win, empty values are ignored. */
function orLater(next: string | undefined, current: string | undefined): string | undefined {
  return next !== undefined && next !== '' ? next : current;
}

function isValidCreatedAt(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

function appendRaw(current: unknown, incoming: unknown, owned: WeakSet<object>): unknown {
  if (incoming === undefined || incoming === null) {
    return current;
  }
  if (current === undefined) {
    return incoming;
  }
  // Streams carry one raw event per update, so this append runs per delta. Push in place when the
  // accumulating array was created by this fold (O(1) per update); copy a caller-supplied array
  // once so it is never mutated.
  if (Array.isArray(current)) {
    if (owned.has(current)) {
      current.push(incoming);
      return current;
    }
    const copy = [...current, incoming];
    owned.add(copy);
    return copy;
  }
  const pair = [current, incoming];
  owned.add(pair);
  return pair;
}

interface FoldState {
  messages: Message[];
  responseId: string | undefined;
  agentId: string | undefined;
  conversationId: string | undefined;
  model: string | undefined;
  createdAt: string | undefined;
  finishReason: FinishReason | undefined;
  usageDetails: UsageDetails | undefined;
  continuationToken: ContinuationToken | undefined;
  additionalProperties: Record<string, unknown> | undefined;
  rawRepresentation: unknown;
  /** Arrays created by this fold's `appendRaw`, safe to extend in place. */
  ownedRaw: WeakSet<object>;
}

function foldUpdate(state: FoldState, update: ChatResponseUpdate | AgentResponseUpdate): void {
  const last = state.messages.at(-1);
  let msg: Message;
  if (last !== undefined && !isDifferentMessage(update, last)) {
    msg = last;
  } else {
    msg = { role: 'assistant', contents: [] };
    state.messages.push(msg);
  }

  const authorName = orLater(update.authorName, msg.authorName);
  if (authorName !== undefined) msg.authorName = authorName;
  const role = orLater(update.role, msg.role);
  if (role !== undefined) msg.role = role;
  const messageId = orLater(update.messageId, msg.messageId);
  if (messageId !== undefined) msg.messageId = messageId;
  if (!isValidCreatedAt(msg.createdAt) && update.createdAt !== undefined && update.createdAt !== '') {
    msg.createdAt = update.createdAt;
  }

  for (const content of update.contents) {
    if (content.type === 'usage') {
      // Usage is response-level metadata, not transcript content (Python `_process_update`).
      state.usageDetails = addUsage(state.usageDetails, content.usageDetails);
      continue;
    }
    // Fragments (function-call arguments, text deltas, ...) are appended as-is and merged by the
    // final per-message coalesce pass in `fold`, which respects annotation-carrying items instead
    // of silently dropping the unmerged fragment (Go appends during Update and coalesces once).
    msg.contents.push(content);
  }

  if (update.additionalProperties !== undefined) {
    msg.additionalProperties = { ...msg.additionalProperties, ...update.additionalProperties };
    state.additionalProperties = { ...state.additionalProperties, ...update.additionalProperties };
  }
  if (update.rawRepresentation !== undefined) {
    msg.rawRepresentation = appendRaw(msg.rawRepresentation, update.rawRepresentation, state.ownedRaw);
    state.rawRepresentation = appendRaw(state.rawRepresentation, update.rawRepresentation, state.ownedRaw);
  }

  state.responseId = orLater(update.responseId, state.responseId);
  state.finishReason = orLater(update.finishReason, state.finishReason);
  if (!isValidCreatedAt(state.createdAt) && isValidCreatedAt(update.createdAt)) {
    state.createdAt = update.createdAt;
  }
  // Unlike the other metadata, the continuation token is always taken from the latest update so
  // that a completed background operation can clear it (Go `Response.Update`).
  state.continuationToken = update.continuationToken;

  if ('agentId' in update) {
    state.agentId = orLater(update.agentId, state.agentId);
  }
  if ('conversationId' in update) {
    state.conversationId = orLater(update.conversationId, state.conversationId);
  }
  if ('model' in update) {
    state.model = orLater(update.model, state.model);
  }
}

function fold(updates: readonly (ChatResponseUpdate | AgentResponseUpdate)[]): FoldState {
  const state: FoldState = {
    messages: [],
    responseId: undefined,
    agentId: undefined,
    conversationId: undefined,
    model: undefined,
    createdAt: undefined,
    finishReason: undefined,
    usageDetails: undefined,
    continuationToken: undefined,
    additionalProperties: undefined,
    rawRepresentation: undefined,
    ownedRaw: new WeakSet(),
  };
  for (const update of updates) {
    foldUpdate(state, update);
  }
  for (const msg of state.messages) {
    msg.contents = coalesceContents(msg.contents);
  }
  return state;
}

/**
 * Folds streamed {@link AgentResponseUpdate}s into a single {@link AgentResponse}.
 *
 * Semantics match Go `Response.Update` / .NET `ToAgentResponse`:
 *
 * - a new message starts only when `authorName`, `messageId` or `role` is present on both sides
 *   and differs;
 * - response metadata takes the latest non-empty value, except `createdAt`, which keeps the
 *   first valid value, and `continuationToken`, which always takes the latest value so a finished
 *   background operation can clear it;
 * - `usage` contents are summed into {@link ResponseBase.usageDetails} instead of being kept as
 *   transcript content;
 * - adjacent compatible contents are coalesced (see {@link coalesceContents}).
 *
 * @param updates - The updates in arrival order. Not mutated.
 */
export function mergeUpdates<T = undefined>(updates: readonly AgentResponseUpdate[]): AgentResponse<T> {
  const state = fold(updates);
  const init: AgentResponseInit<T> = { messages: state.messages };
  if (state.agentId !== undefined) init.agentId = state.agentId;
  if (state.responseId !== undefined) init.responseId = state.responseId;
  setFoldMetadata(init, state);
  return agentResponse<T>(init);
}

/** Folds streamed {@link ChatResponseUpdate}s into a {@link ChatResponse}. See {@link mergeUpdates}. */
export function mergeChatUpdates<T = undefined>(updates: readonly ChatResponseUpdate[]): ChatResponse<T> {
  const state = fold(updates);
  const init: ChatResponseInit<T> = { messages: state.messages };
  if (state.responseId !== undefined) init.responseId = state.responseId;
  if (state.conversationId !== undefined) init.conversationId = state.conversationId;
  if (state.model !== undefined) init.model = state.model;
  setFoldMetadata(init, state);
  return chatResponse<T>(init);
}

/** Copies the folded response-level metadata common to both response flavors onto the init. */
function setFoldMetadata(
  init: ChatResponseInit<unknown> | AgentResponseInit<unknown>,
  state: FoldState,
): void {
  if (state.createdAt !== undefined) init.createdAt = state.createdAt;
  if (state.finishReason !== undefined) init.finishReason = state.finishReason;
  if (state.usageDetails !== undefined) init.usageDetails = state.usageDetails;
  if (state.continuationToken !== undefined) init.continuationToken = state.continuationToken;
  if (state.additionalProperties !== undefined) init.additionalProperties = state.additionalProperties;
  if (state.rawRepresentation !== undefined) init.rawRepresentation = state.rawRepresentation;
}

/** Constructor input common to both update flavors: {@link ResponseUpdateBase} without `text`. */
type ResponseUpdateInitBase = Omit<ResponseUpdateBase, 'text'>;

/**
 * Shared explode logic for {@link chatResponseToUpdates} / {@link agentResponseToUpdates}: one
 * update per message, plus a trailing metadata-only update for response-level usage /
 * continuation token. `addExtras` injects the flavor-specific fields (`conversationId` / `model`
 * or `agentId`) into each update.
 */
function responseToUpdates(
  response: ResponseBase<unknown>,
  addExtras: (init: ResponseUpdateInitBase) => void,
): ResponseUpdateInitBase[] {
  const inits: ResponseUpdateInitBase[] = [];
  for (const msg of response.messages) {
    const init: ResponseUpdateInitBase = { contents: msg.contents, role: msg.role };
    if (msg.rawRepresentation !== undefined) init.rawRepresentation = msg.rawRepresentation;
    if (msg.additionalProperties !== undefined) init.additionalProperties = msg.additionalProperties;
    if (msg.messageId !== undefined) init.messageId = msg.messageId;
    if (msg.authorName !== undefined) init.authorName = msg.authorName;
    const createdAt = msg.createdAt ?? response.createdAt;
    if (createdAt !== undefined) init.createdAt = createdAt;
    if (response.responseId !== undefined) init.responseId = response.responseId;
    if (response.finishReason !== undefined) init.finishReason = response.finishReason;
    addExtras(init);
    inits.push(init);
  }

  // Go gates the trailing update on a non-zero usage record (`!isZeroUsage`), not mere presence.
  const hasUsage = !isEmptyUsage(response.usageDetails);
  if (hasUsage || response.additionalProperties !== undefined || response.continuationToken !== undefined) {
    const init: ResponseUpdateInitBase = {
      contents: hasUsage ? [{ type: 'usage', usageDetails: response.usageDetails as UsageDetails }] : [],
    };
    if (response.responseId !== undefined) init.responseId = response.responseId;
    if (response.createdAt !== undefined) init.createdAt = response.createdAt;
    if (response.continuationToken !== undefined) init.continuationToken = response.continuationToken;
    addExtras(init);
    if (response.finishReason !== undefined) init.finishReason = response.finishReason;
    if (response.additionalProperties !== undefined)
      init.additionalProperties = response.additionalProperties;
    inits.push(init);
  }
  return inits;
}

/**
 * Explodes a {@link ChatResponse} back into the updates a stream would have produced.
 *
 * The inverse of {@link mergeChatUpdates}: each message becomes one update, and response-level
 * usage / continuation token are carried on a trailing metadata-only update. Mirrors Go
 * `Response.ToUpdates`, and lets the function-invocation loop use one code path for streaming and
 * non-streaming inner calls.
 */
export function chatResponseToUpdates(response: ChatResponse<unknown>): ChatResponseUpdate[] {
  return responseToUpdates(response, (init: ChatResponseUpdateInit) => {
    if (response.conversationId !== undefined) init.conversationId = response.conversationId;
    if (response.model !== undefined) init.model = response.model;
  }).map((init) => chatResponseUpdate(init));
}

/**
 * Explodes an {@link AgentResponse} back into the updates a streamed run would have produced.
 *
 * The agent-level counterpart of {@link chatResponseToUpdates}, used when a layer above the agent
 * supplies a complete response to a caller that is iterating — an agent middleware answering
 * without invoking the agent, for example.
 */
export function agentResponseToUpdates(response: AgentResponse<unknown>): AgentResponseUpdate[] {
  return responseToUpdates(response, (init: AgentResponseUpdateInit) => {
    if (response.agentId !== undefined) init.agentId = response.agentId;
  }).map((init) => agentResponseUpdate(init));
}

// endregion
