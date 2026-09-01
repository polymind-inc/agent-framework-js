import type { UserInputRequestContent } from './types/content.js';
import type { ResponseBase } from './types/response.js';

/** Base class for every error the framework raises. */
export class AgentFrameworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentFrameworkError';
  }
}

/** A tool could not be invoked, or its invocation failed fatally. */
export class ToolInvocationError extends AgentFrameworkError {
  /** The name of the tool that failed. */
  readonly toolName: string;

  constructor(toolName: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolInvocationError';
    this.toolName = toolName;
  }
}

/**
 * A tool stopped because it needs a human, and no result can be produced without one.
 *
 * Raised by an agent used as a tool (`agent.asTool()`) when the sub-agent's run ends holding
 * `userInputRequests`. Unlike every other error a tool raises, this one is **not** turned into a
 * `function_result` for the model: there is nothing the model can do about it, and telling it the
 * tool "failed" only makes it retry. The function-calling loop catches this control-flow error and
 * surfaces {@link contents} to the caller, which is the only place the approval or consent can be
 * settled — Python does the same with `UserInputRequiredException` (`_tools.py`).
 *
 * Raising it with **no** {@link contents} leaves the caller nothing to settle, so the loop falls
 * back to reporting an exception `function_result` to the model and continues, the same way Python
 * does. It never fails the run.
 */
export class UserInputRequiredError extends AgentFrameworkError {
  /** The actionable requests produced by the tool or sub-agent. */
  readonly contents: UserInputRequestContent[];

  constructor(
    contents: readonly UserInputRequestContent[],
    message = 'Tool requires user input to proceed.',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'UserInputRequiredError';
    this.contents = [...contents];
  }
}

/** A tool's `parameters` could not be turned into a JSON Schema. */
export class SchemaResolutionError extends AgentFrameworkError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SchemaResolutionError';
  }
}

/** A chat provider rejected the request or returned something unusable. */
export class ChatClientError extends AgentFrameworkError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChatClientError';
  }
}

/**
 * A response arrived, but it could not be turned into the caller's structured type.
 *
 * The model answered and the turn was billed and persisted; what failed is the caller's contract
 * with the schema. {@link StructuredOutputError.response} is that answer, so a caller can read the
 * text, usage, finish reason and ids of the turn they paid for, retry against them, or show the
 * model its own output. The reference implementations parse lazily, so their callers still hold
 * the response object when the parse throws; this framework parses eagerly and rejects the run, so
 * the response has to travel on the error to stay reachable at all.
 *
 * `response` is **non-enumerable**: a logger that serializes a caught error would otherwise write
 * the whole conversation — every message of the turn, and whatever the tools returned — into the
 * log line. Read it by name.
 */
export class StructuredOutputError extends ChatClientError {
  /** The completed response whose text could not be parsed or validated. */
  declare readonly response: ResponseBase<unknown>;

  constructor(message: string, response: ResponseBase<unknown>, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StructuredOutputError';
    Object.defineProperty(this, 'response', {
      value: response,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
}

/**
 * The provider refused the request because its content filter matched.
 *
 * A distinct type because the remedy is distinct: retrying does not help, and the message is one
 * the caller usually wants to surface to a user rather than log as a provider fault. Mirrors
 * Python's `ContentFilterException` (`agent_framework_openai/_exceptions.py`).
 *
 * This covers a *rejected request*. A model that answered but declined reports
 * `finishReason: 'content_filter'` instead.
 */
export class ContentFilterError extends ChatClientError {
  /** The provider's own error code, when it reported one. */
  readonly code: string | undefined;

  constructor(message: string, options?: ErrorOptions & { code?: string }) {
    super(message, options);
    this.name = 'ContentFilterError';
    this.code = options?.code;
  }
}

/** The caller configured the framework in a way that cannot work. Raised eagerly, at construction time. */
export class ConfigurationError extends AgentFrameworkError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigurationError';
  }
}

/**
 * Control flow, not a failure: a middleware asked for the pipeline to stop early.
 *
 * Raised by `ctx.terminate(result)`. Agent middleware swallows it and returns whatever the context
 * holds; function middleware lets it out so the function-calling loop stops after the current
 * round (the counterpart of Python's `MiddlewareTermination`).
 */
export class MiddlewareTerminated extends AgentFrameworkError {
  constructor(message = 'Middleware terminated execution.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'MiddlewareTerminated';
  }
}

/**
 * A failure that must end the run rather than be reported to the model.
 *
 * Everything else a tool or a function middleware throws becomes this call's `function_result`, and
 * the loop carries on — the right reading for a tool that failed, and the wrong one for a layer
 * whose whole job is to decide whether the call may happen at all. A guardrail that cannot reach
 * its policy service has not decided "no"; it has failed to decide, and telling the model the tool
 * errored invites it to try again against a check that is no longer running.
 *
 * Throw this to say so. It is never converted into a result: the current batch of calls is
 * cancelled, no further call starts, and it reaches the caller of `run()`. The counterpart of
 * Python's `MiddlewareFailure`.
 *
 * Cancellation is cooperative. A sibling call already awaiting something stops at its next
 * suspension point if it watches `ctx.signal`; one that ignores the signal runs to completion and
 * may still have its effects, but its result is discarded either way and never reaches the
 * transcript, the model, or history.
 */
export class MiddlewareFailed extends AgentFrameworkError {
  constructor(message = 'Middleware aborted the run.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'MiddlewareFailed';
  }
}

/** A feature exists in the API surface but is not implemented by this package. */
export class NotImplementedError extends AgentFrameworkError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NotImplementedError';
  }
}

/** A response stream was consumed twice, or consumed after it had already completed. */
export class StreamConsumedError extends AgentFrameworkError {
  constructor(message = 'This response stream has already been consumed.') {
    super(message);
    this.name = 'StreamConsumedError';
  }
}

/**
 * Validates an integer configuration value at the boundary where it is declared.
 *
 * Returns `value` when it is a safe integer of at least `minimum`, and throws a
 * {@link ConfigurationError} naming the offending option otherwise — eagerly, so a bad limit
 * fails where it is written rather than on the first call that reaches it.
 */
export function validateSafeInteger(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ConfigurationError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

/** The human-readable summary of a thrown value: `error.message` for an `Error`, `String(error)` otherwise. */
export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The classification of a thrown value for telemetry: `error.name` for an `Error`, `typeof` otherwise. */
export function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
