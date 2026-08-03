import type { AgentSession } from '../agent/session.js';
import type { FunctionMiddleware } from './middleware.js';

/**
 * Where the agent layer hands run-scoped values to the chat-client layers beneath it.
 *
 * A symbol key rather than a field on {@link ChatOptions}: options travel all the way to the
 * provider and are serialized into the request, and per-run middleware is not something any
 * provider should ever see. Symbols survive the object spreads the layers do, are invisible to
 * `Object.keys` and `JSON.stringify`, and the function-invocation layer strips this one before
 * calling the provider anyway.
 *
 * `Symbol.for` rather than `Symbol()` so two copies of the package in one process still agree.
 *
 * @internal
 */
export const RUN_SCOPE: unique symbol = Symbol.for('agent-framework.core.runScope');

/** Values that belong to one agent run rather than to one model call. */
export interface RunScope {
  /** Per-run function middleware, in collection order. */
  middleware?: readonly FunctionMiddleware[];
  /** The session the run belongs to, so a function middleware can read and write its state. */
  session?: AgentSession;
}

/** Attaches a {@link RunScope} to an options object. Mutates and returns `options`. */
export function attachRunScope<T extends object>(options: T, scope: RunScope): T {
  (options as Record<symbol, unknown>)[RUN_SCOPE] = scope;
  return options;
}

/** Reads the {@link RunScope} an outer layer attached, if any. */
export function readRunScope(options: unknown): RunScope | undefined {
  if (typeof options !== 'object' || options === null) {
    return undefined;
  }
  const scope = (options as Record<symbol, unknown>)[RUN_SCOPE];
  return typeof scope === 'object' && scope !== null ? (scope as RunScope) : undefined;
}

/** Returns a copy of `options` without the run scope, for handing down to a provider. */
export function stripRunScope<T extends object>(options: T): T {
  if (!(RUN_SCOPE in options)) {
    return options;
  }
  const copy = { ...options };
  delete (copy as Record<symbol, unknown>)[RUN_SCOPE];
  return copy;
}
