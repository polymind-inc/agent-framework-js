import type { AgentSession } from '../agent/session.js';
import type { ChatClient, ChatOptions } from '../client/chat-client.js';
import { ConfigurationError, MiddlewareTerminated } from '../errors.js';
import { HOSTED_TOOL_CAPABILITY_METHODS } from '../tools/hosted.js';
import type { AnyFunctionTool, Tool } from '../tools/tool.js';
import type { Message } from '../types/message.js';
import type { AgentResponse, AgentResponseUpdate } from '../types/response.js';

/** The `(ctx, next)` signature every middleware handler follows. */
export type MiddlewareHandler<TContext> = (ctx: TContext, next: () => Promise<void>) => Promise<void> | void;

/** A middleware that wraps a whole agent run. Build one with {@link agentMiddleware}. */
export interface AgentMiddleware {
  readonly kind: 'agent';
  readonly handler: MiddlewareHandler<AgentMiddlewareContext>;
  /** Shown in error messages; defaults to the handler's function name. */
  readonly name?: string;
}

/** A middleware that wraps one tool invocation. Build one with {@link functionMiddleware}. */
export interface FunctionMiddleware {
  readonly kind: 'function';
  readonly handler: MiddlewareHandler<FunctionMiddlewareContext>;
  /** Shown in error messages; defaults to the handler's function name. */
  readonly name?: string;
}

/**
 * Anything accepted where middleware is collected.
 *
 * Two kinds exist, and the `kind` discriminant says which layer a middleware wraps: `agent` wraps
 * a whole `run()`, `function` wraps a single tool invocation. Interception of individual model
 * calls stays an internal concern — telemetry, the function-calling loop and the approval layer
 * are implemented as chat-client layers (`withChatTelemetry`, `withFunctionInvocation`,
 * `withToolApproval`), and a public chat middleware would be a second way to do the same thing.
 */
export type Middleware = AgentMiddleware | FunctionMiddleware;

/**
 * What an agent middleware may read and change around a run.
 *
 * The mutable fields are read *after* the chain reaches the agent, so a middleware changes the run
 * by assigning to them before calling `next()`.
 *
 * ## Security considerations
 *
 * A middleware sits between the caller and the model with full control over both directions: it
 * can rewrite the prompt, inject instructions, and replace the response the caller sees. Treat the
 * middleware list as trusted code, and never build one from user input.
 */
export interface AgentMiddlewareContext {
  readonly agent: { readonly id: string; readonly name?: string };
  /** The run's input messages. Rewrite or extend before calling `next()`. */
  messages: Message[];
  /** The session this run uses; resolved before the chain starts, so it is never `undefined`. */
  readonly session: AgentSession;
  /** Extra tools for this run. Appended to the agent's tools, as `run({ tools })` would be. */
  tools: Tool[];
  /** The run's chat options. Mutating this is equivalent to passing `run({ options })`. */
  options: Record<string, unknown>;
  /** `true` when the caller is iterating the run, `false` when it awaited it. */
  readonly stream: boolean;
  /** Free-form slot for passing values between middleware in the same run. */
  readonly metadata: Record<string, unknown>;
  /**
   * The run's result.
   *
   * - assign before `next()` — or never call `next()` — to answer without invoking the agent;
   * - read after `next()` on an **awaited** run to observe the result, and assign to replace it;
   * - on a **streamed** run this stays `undefined` after `next()`: the updates have not been
   *   produced yet. Use {@link AgentMiddlewareContext.onUpdate} and
   *   {@link AgentMiddlewareContext.onResult} instead. Assigning anyway overrides the run, and the
   *   agent is never invoked.
   */
  response?: AgentResponse<unknown>;
  /**
   * Transforms each update the caller observes while streaming.
   *
   * Returning `undefined` keeps the update unchanged. Hooks run in registration order, and only
   * affect what the caller sees: the folded result, the persisted transcript and telemetry all
   * record what the agent actually produced (Python `ResponseStream._record_update`).
   */
  onUpdate(
    hook: (
      update: AgentResponseUpdate,
    ) => AgentResponseUpdate | undefined | Promise<AgentResponseUpdate | undefined>,
  ): void;
  /** Transforms the folded result, streamed or awaited. Returning `undefined` keeps it unchanged. */
  onResult(
    hook: (
      response: AgentResponse<unknown>,
    ) => AgentResponse<unknown> | undefined | Promise<AgentResponse<unknown> | undefined>,
  ): void;
  /**
   * Ends the run here.
   *
   * The rest of the chain, and the agent itself when `next()` has not been called, are skipped;
   * the caller gets `response` (or the one passed here) as a normal result rather than an error.
   */
  terminate(response?: AgentResponse<unknown>): never;
  readonly signal?: AbortSignal;
}

/**
 * What a function middleware may read and change around one tool invocation.
 *
 * Runs inside the function-calling loop, once per call, after arguments have been parsed and
 * validated and before the tool body runs.
 */
export interface FunctionMiddlewareContext {
  readonly tool: AnyFunctionTool;
  /** The model's `callId` for this invocation. */
  readonly callId: string;
  /** The validated arguments. Rewrite before calling `next()` to change what the tool receives. */
  arguments: unknown;
  /** The session of the run this call belongs to, when the call came from an agent run. */
  readonly session?: AgentSession;
  /** Free-form slot for passing values between middleware for the same call. */
  readonly metadata: Record<string, unknown>;
  /**
   * The tool's return value.
   *
   * Assign before `next()` — or never call `next()` — to answer without running the tool; read
   * after `next()` to observe or replace what the model will be told. A
   * `function_approval_request` assigned here is surfaced to the caller instead of being sent to
   * the model, which is how {@link toolApprovalMiddleware} defers a call to a human.
   */
  result?: unknown;
  /**
   * The error the **tool body** threw, when it threw.
   *
   * A mirror, not the channel: the failure is what `next()` throws, and this is set alongside it
   * so a middleware can look without catching. Clearing it does not clear the failure — recover by
   * catching and assigning {@link FunctionMiddlewareContext.result}.
   *
   * Only the tool's own failure appears here. A failure thrown by another middleware unwinds
   * without passing through the tool seam, so this is still unset while your `catch` or `finally`
   * runs — it answers "was it the tool?", not "did something fail?".
   */
  error?: unknown;
  /**
   * Ends this invocation *and* the function-calling loop.
   *
   * The current round still reports its results to the caller; the model is not called again
   * (Python `MiddlewareTermination`, `_execute_single_function_call`).
   */
  terminate(result?: unknown): never;
  readonly signal?: AbortSignal;
}

/**
 * Declares an agent middleware.
 *
 * ```ts
 * const logging = agentMiddleware(async (ctx, next) => {
 *   console.log('->', ctx.messages.length, 'messages');
 *   await next();
 *   console.log('<-', ctx.response?.text);
 * });
 *
 * const agent = new Agent({ client, middleware: [logging] });
 * ```
 *
 * The kind is declared here rather than inferred: TypeScript types are erased at runtime, so
 * unlike Python the framework cannot look at the handler's parameter type.
 */
export function agentMiddleware(
  handler: MiddlewareHandler<AgentMiddlewareContext>,
  options?: { name?: string },
): AgentMiddleware {
  return { kind: 'agent', handler, ...middlewareName(handler, options) };
}

/** The shared name resolution: an explicit option wins, then the handler's own function name. */
function middlewareName(handler: MiddlewareHandler<never>, options?: { name?: string }): { name?: string } {
  const name = options?.name ?? (handler.name === '' ? undefined : handler.name);
  return name === undefined ? {} : { name };
}

/**
 * Declares a function middleware.
 *
 * `next()` throws when the call it wraps fails, whether the tool body threw or an inner middleware
 * did, so anything that has to happen on both paths belongs in `finally`:
 *
 * ```ts
 * const timing = functionMiddleware(async (ctx, next) => {
 *   const started = performance.now();
 *   try {
 *     await next();
 *   } finally {
 *     console.log(ctx.tool.name, performance.now() - started, 'ms');
 *   }
 * });
 * ```
 *
 * Catching it and assigning `ctx.result` answers the call in the tool's place; letting it out
 * reports it to the model as this call's failure and the loop carries on. To end the run instead,
 * throw {@link MiddlewareFailed} — that one is never turned into a result.
 *
 * A failure from the **tool body** is also readable as `ctx.error`, set before it is thrown, for a
 * middleware that wants to look at it without catching. A failure thrown by another middleware is
 * not: it unwinds without passing through the tool seam, so `ctx.error` is still unset while your
 * `catch` or `finally` runs. What you caught is the failure; `ctx.error` only ever tells you
 * whether the tool itself was the one that failed.
 */
export function functionMiddleware(
  handler: MiddlewareHandler<FunctionMiddlewareContext>,
  options?: { name?: string },
): FunctionMiddleware {
  return { kind: 'function', handler, ...middlewareName(handler, options) };
}

/** Middleware split by kind. */
export interface CategorizedMiddleware {
  agent: AgentMiddleware[];
  function: FunctionMiddleware[];
}

function isMiddleware(value: unknown): value is Middleware {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Middleware>;
  return (
    (candidate.kind === 'agent' || candidate.kind === 'function') && typeof candidate.handler === 'function'
  );
}

/**
 * Splits middleware from every collection site into the two kinds, preserving order.
 *
 * Python's `categorize_middleware` recovers the kind by introspecting the handler's type
 * annotations; here the kind is carried on the object itself, so anything that is not a
 * {@link Middleware} is a configuration error rather than a silent fallback to `agent`.
 *
 * @throws {ConfigurationError} When a source contains something that is not a middleware.
 */
export function categorizeMiddleware(
  ...sources: ReadonlyArray<readonly unknown[] | unknown | undefined>
): CategorizedMiddleware {
  const result: CategorizedMiddleware = { agent: [], function: [] };
  for (const source of sources) {
    if (source === undefined || source === null) {
      continue;
    }
    const items: readonly unknown[] = Array.isArray(source) ? source : [source];
    for (const item of items) {
      if (!isMiddleware(item)) {
        throw new ConfigurationError(
          'Middleware must be created with agentMiddleware() or functionMiddleware(); ' +
            `received ${describe(item)}.`,
        );
      }
      if (item.kind === 'agent') {
        result.agent.push(item);
      } else {
        result.function.push(item);
      }
    }
  }
  return result;
}

function describe(value: unknown): string {
  if (typeof value === 'function') {
    return `a bare function${value.name === '' ? '' : ` (${value.name})`}`;
  }
  if (typeof value === 'object' && value !== null) {
    const kind = (value as { kind?: unknown }).kind;
    return typeof kind === 'string' ? `an object with kind '${kind}'` : 'a plain object';
  }
  return typeof value;
}

/**
 * Runs an onion of middleware around `final`.
 *
 * The first registered middleware is the outermost layer, so `next()` descends toward `final` and
 * the code after `await next()` unwinds in reverse registration order. A middleware that never
 * calls `next()` short-circuits everything below it, including `final`.
 *
 * `next()` may be called at most once per middleware: calling it twice would run the agent (or the
 * tool) a second time, which no caller can observe correctly since only one result is returned.
 *
 * {@link MiddlewareTerminated} is not caught here — each pipeline decides what termination means.
 */
export async function runMiddlewareChain<TContext>(
  middleware: ReadonlyArray<{ handler: MiddlewareHandler<TContext>; name?: string }>,
  ctx: TContext,
  final: () => Promise<void>,
): Promise<void> {
  const step = async (index: number): Promise<void> => {
    if (index >= middleware.length) {
      await final();
      return;
    }
    const entry = middleware[index] as { handler: MiddlewareHandler<TContext>; name?: string };
    let called = false;
    const next = async (): Promise<void> => {
      if (called) {
        throw new ConfigurationError(
          `Middleware '${entry.name ?? `#${index}`}' called next() more than once; ` +
            'each middleware may continue the chain at most once.',
        );
      }
      called = true;
      await step(index + 1);
    };
    await entry.handler(ctx, next);
  };
  await step(0);
}

/**
 * Throws {@link MiddlewareTerminated}. The result travels on the context (`ctx.response` /
 * `ctx.result`, assigned by `terminate()` before this is called), not on the error.
 */
export function terminateMiddleware(): never {
  throw new MiddlewareTerminated();
}

/**
 * Attaches middleware to a {@link ChatClient}, so an agent built on it picks them up.
 *
 * This is the "chat client construction" collection site without requiring every
 * provider to grow a `middleware` option:
 *
 * ```ts
 * const client = withMiddleware(new OpenAIChatClient({ model: 'gpt-5' }), [auditTools]);
 * const agent = new Agent({ client });
 * ```
 *
 * The client keeps working as a plain {@link ChatClient} — the middleware only takes effect for an
 * agent, which is the layer that owns runs and tool invocations.
 */
export function withMiddleware<TOptions extends ChatOptions>(
  client: ChatClient<TOptions>,
  middleware: readonly Middleware[],
): ChatClient<TOptions> & { readonly middleware: readonly Middleware[] } {
  const existing = (client as { middleware?: readonly Middleware[] }).middleware ?? [];
  // The hosted-tool capability protocol is duck-typed on method presence, so the wrapper
  // has to carry the underlying client's capability methods or `supportsMcp` and friends would
  // report a capable client as incapable after wrapping. `forSession` is a different capability
  // with the same hazard: `Agent` reads it off the client it was handed, so a wrapper that drops
  // it silently turns a session-scoped provider into an ordinary one — nothing fails, and nothing
  // reports the loss.
  const capabilities: Record<string, unknown> = {};
  for (const method of [...HOSTED_TOOL_CAPABILITY_METHODS, 'forSession']) {
    const fn = (client as unknown as Record<string, unknown>)[method];
    if (typeof fn === 'function') {
      // Bound to the wrapped client, which loses nothing: this wrapper's `getResponse` only
      // delegates, and the middleware it carries travels on `middleware` for the agent to collect,
      // not through the call.
      capabilities[method] = fn.bind(client);
    }
  }
  return {
    ...capabilities,
    metadata: client.metadata,
    getResponse: (messages, options) => client.getResponse(messages, options),
    middleware: [...existing, ...middleware],
  };
}
