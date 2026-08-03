import { type AgentSession, ConfigurationError } from '@polymind-inc/agent-framework-core';
import { A2AAgentError } from './errors.js';

/** The state partition this package owns inside an `AgentSession`. */
export const A2A_STATE_KEY = 'a2a';

/**
 * What the session remembers about the remote conversation, beyond its context id.
 *
 * The context id lives in `session.serviceSessionId`, because that is what it is: the service's own
 * identifier for a conversation whose transcript the service keeps. The task fields are per-turn
 * bookkeeping and live in this partition.
 *
 * `taskState` is stored in its protocol spelling (`TASK_STATE_INPUT_REQUIRED`), not as the SDK's
 * numeric enum, so a persisted session stays readable and survives a renumbering of the enum.
 */
export interface A2ASessionState {
  /** The task the previous turn ended on, when it ended on one. */
  taskId?: string;
  /** That task's state, which decides how the next message links to it. */
  taskState?: string;
}

/** The keys this package owns inside its partition. */
type PartitionKey = keyof A2ASessionState | 'contextId';

function describe(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value;
}

function readString(partition: Record<string, unknown>, key: PartitionKey): string | undefined {
  const value = partition[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    // Refuse rather than repair, as session restoration does everywhere: a task id of the wrong
    // shape means this partition was not written by this package, and guessing would link the next
    // message to a task that does not exist.
    throw new ConfigurationError(
      `Session state for the A2A agent is invalid: '${key}' must be a string, got ${describe(value)}.`,
    );
  }
  return value === '' ? undefined : value;
}

/**
 * Reads the A2A bookkeeping out of a session.
 *
 * A task pointer is only honoured inside the conversation that produced it, so the partition also
 * records which context that was. Two situations make the recorded task unusable, and both are
 * reachable through ordinary framework use — `agent.asTool({ propagateSession: true })` hands a
 * sub-agent a session that shares the caller's `state` but deliberately drops its
 * `serviceSessionId`:
 *
 * - the session names no conversation, so there is nothing the task could belong to;
 * - the session names a *different* conversation than the one the task was created in, because a
 *   sibling run wrote into the shared state.
 *
 * In both cases the task is ignored rather than sent: a `taskId` or `referenceTaskIds` pointing
 * into another conversation is at best meaningless to the remote agent and at worst answers the
 * wrong question.
 */
export function readA2ASessionState(session: AgentSession | undefined): A2ASessionState {
  if (session === undefined) {
    return {};
  }
  const partition = session.partition(A2A_STATE_KEY);
  // Every field is validated before the scope is considered, so a partition that was not written
  // by this package is refused rather than quietly ignored, whichever conversation it names.
  const contextId = readString(partition, 'contextId');
  const taskId = readString(partition, 'taskId');
  const taskState = readString(partition, 'taskState');
  if (contextId === undefined || contextId !== session.serviceSessionId) {
    return {};
  }
  return {
    ...(taskId === undefined ? {} : { taskId }),
    ...(taskState === undefined ? {} : { taskState }),
  };
}

/**
 * The error for a response that belongs to a different conversation than the session it ran in.
 *
 * One wording for both places it is detected — per event while a stream is running, and again when
 * the session is committed.
 */
export function contextMismatch(expected: string, actual: string): A2AAgentError {
  return new A2AAgentError(
    `The contextId returned by the A2A agent ('${actual}') differs from the one this session ` +
      `is bound to ('${expected}').`,
  );
}

/**
 * Records what the run observed, once it has finished.
 *
 * The context id is set once: a session belongs to one remote conversation for its whole life, so a
 * response naming a different one is a mismatch, not an update. The task fields are overwritten
 * unconditionally — including back to absent — because they describe the turn that just ended, and
 * a run that came back as a plain message ended on no task at all.
 *
 * @throws {A2AAgentError} When the response belongs to a different conversation than the session.
 */
export function writeA2ASessionState(
  session: AgentSession,
  observed: { contextId?: string | undefined; taskId?: string | undefined; taskState?: string | undefined },
): void {
  const { contextId } = observed;
  if (contextId !== undefined && contextId !== '') {
    if (session.serviceSessionId !== undefined && session.serviceSessionId !== contextId) {
      throw contextMismatch(session.serviceSessionId, contextId);
    }
    session.serviceSessionId ??= contextId;
  }
  const partition = session.partition(A2A_STATE_KEY);
  // The task is stored with the conversation it belongs to. Without one there is nothing to scope
  // it to, so it is not stored at all rather than left for another conversation to pick up.
  const scope = session.serviceSessionId;
  if (scope === undefined || observed.taskId === undefined || observed.taskId === '') {
    delete partition.contextId;
    delete partition.taskId;
    delete partition.taskState;
    return;
  }
  partition.contextId = scope;
  partition.taskId = observed.taskId;
  if (observed.taskState === undefined) {
    delete partition.taskState;
  } else {
    partition.taskState = observed.taskState;
  }
}
