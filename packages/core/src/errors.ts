import type { UserInputRequestContent } from './types/content.js';

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
 * Throws the abort reason when `signal` is already aborted.
 *
 * The thrown value is whatever the caller's {@link AbortController} carries — by default a
 * `DOMException` named `AbortError`, per the web standard.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** The human-readable summary of a thrown value: `error.message` for an `Error`, `String(error)` otherwise. */
export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
