import { ConfigurationError, type ContinuationToken } from '@polymind-inc/agent-framework-core';

/**
 * Resumes a long-running A2A task.
 *
 * The wire form is a single property, `{"taskId": "..."}`: the task is server-side state, so its id
 * is all a resumed run needs. The context id is *not* carried here — it belongs to the session, and
 * a token that also named a conversation could be replayed against a different one.
 */
export interface A2AContinuationToken extends ContinuationToken {
  taskId: string;
}

/** Issues a token for a task that is still running. */
export function a2aContinuationToken(taskId: string): A2AContinuationToken {
  return { taskId };
}

/**
 * Reads back a token produced by {@link a2aContinuationToken}.
 *
 * Parsing is strict, including a check for properties this version does not know: a token is
 * opaque to the caller, so anything unexpected in one means it came from somewhere else — another
 * provider, a hand-written object, a newer version — and resuming against a task id lifted out of
 * it would run the wrong operation.
 *
 * @throws {ConfigurationError} When the value is not an A2A continuation token.
 */
export function parseA2AContinuationToken(token: ContinuationToken): A2AContinuationToken {
  const taskId: unknown = token.taskId;
  if (typeof taskId !== 'string' || taskId === '') {
    throw new ConfigurationError(
      "The value passed as continuationToken is not an A2A token: 'taskId' must be a non-empty string. " +
        'Pass back the `continuationToken` from a previous AgentResponse unchanged.',
    );
  }
  const unknownKeys = Object.keys(token).filter((key) => key !== 'taskId');
  if (unknownKeys.length > 0) {
    throw new ConfigurationError(
      `The value passed as continuationToken is not an A2A token: unrecognized ${
        unknownKeys.length === 1 ? 'property' : 'properties'
      } ${unknownKeys.map((key) => `'${key}'`).join(', ')}.`,
    );
  }
  return { taskId };
}
