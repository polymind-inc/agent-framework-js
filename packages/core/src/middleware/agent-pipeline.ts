import type { AgentSession } from '../agent/session.js';
import { MiddlewareTerminated } from '../errors.js';
import type { ResponseStream } from '../streaming/response-stream.js';
import type { Tool } from '../tools/tool.js';
import type { Message } from '../types/message.js';
import type { AgentResponse, AgentResponseUpdate } from '../types/response.js';
import { agentResponse, agentResponseToUpdates } from '../types/response.js';
import type { AgentMiddleware, AgentMiddlewareContext } from './middleware.js';
import { runMiddlewareChain, terminateMiddleware } from './middleware.js';

/** What {@link runAgentPipeline} needs in order to run one agent invocation through its middleware. */
export interface AgentPipelineInit<TFinal extends AgentResponse<unknown>> {
  middleware: readonly AgentMiddleware[];
  agent: { readonly id: string; readonly name?: string };
  session: AgentSession;
  messages: Message[];
  tools: Tool[];
  options: Record<string, unknown>;
  stream: boolean;
  signal?: AbortSignal;
  /**
   * Starts the actual run with whatever the middleware left in the context.
   *
   * Called at most once, and never when a middleware short-circuits. The returned stream is inert
   * until consumed, so abandoning it (a middleware that overrides the response after `next()`)
   * runs nothing.
   */
  invoke: (ctx: AgentMiddlewareContext) => ResponseStream<AgentResponseUpdate, TFinal>;
}

/** The source and the folded result of a run that went through agent middleware. */
export interface AgentPipelineResult<TFinal> {
  /** What the caller iterates. Empty when the caller awaited instead of iterating. */
  updates: AsyncIterable<AgentResponseUpdate>;
  /** The folded result, with every `onResult` hook applied. Call after `updates` is exhausted. */
  final: () => Promise<TFinal>;
}

type UpdateHook = (
  update: AgentResponseUpdate,
) => AgentResponseUpdate | undefined | Promise<AgentResponseUpdate | undefined>;
type ResultHook = (
  response: AgentResponse<unknown>,
) => AgentResponse<unknown> | undefined | Promise<AgentResponse<unknown> | undefined>;

/** The source for a run nobody will iterate: an awaited run, or one a middleware declined. */
async function* noUpdates(): AsyncGenerator<AgentResponseUpdate> {}

/**
 * Runs an agent invocation through its agent middleware.
 *
 * The chain runs where the consumption mode is already known (`start`), so `ctx.stream` is
 * accurate and a middleware can behave differently for an awaited and an iterated run.
 *
 * After the chain, whatever sits in `ctx.response` wins: it is either the awaited run's own
 * result, or a response a middleware supplied. Only when no middleware produced one is the inner
 * stream driven, which is the streaming path. Termination is control flow, not failure — the
 * caller gets the context's response, or an empty one (Python `AgentMiddlewarePipeline.execute`
 * suppresses `MiddlewareTermination` the same way).
 */
export async function runAgentPipeline<TFinal extends AgentResponse<unknown>>(
  init: AgentPipelineInit<TFinal>,
): Promise<AgentPipelineResult<TFinal>> {
  const updateHooks: UpdateHook[] = [];
  const resultHooks: ResultHook[] = [];

  const ctx: AgentMiddlewareContext = {
    agent: init.agent,
    messages: init.messages,
    session: init.session,
    tools: init.tools,
    options: init.options,
    stream: init.stream,
    metadata: {},
    onUpdate(hook: UpdateHook): void {
      updateHooks.push(hook);
    },
    onResult(hook: ResultHook): void {
      resultHooks.push(hook);
    },
    terminate(response?: AgentResponse<unknown>): never {
      if (response !== undefined) {
        ctx.response = response;
      }
      terminateMiddleware();
    },
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  };

  let inner: ResponseStream<AgentResponseUpdate, TFinal> | undefined;
  const final = async (): Promise<void> => {
    inner = init.invoke(ctx);
    if (!init.stream) {
      // An awaited run folds inside the agent layer, so middleware after `next()` observes a
      // complete response — the same thing Python's non-streaming pipeline puts in `context.result`.
      ctx.response = await inner;
    }
  };

  try {
    await runMiddlewareChain(init.middleware, ctx, final);
  } catch (error) {
    if (!(error instanceof MiddlewareTerminated)) {
      throw error;
    }
  }

  const applyResultHooks = async (response: AgentResponse<unknown>): Promise<TFinal> => {
    let current = response;
    for (const hook of resultHooks) {
      const hooked = await hook(current);
      if (hooked !== undefined && hooked !== null) {
        current = hooked;
      }
    }
    return current as TFinal;
  };

  if (ctx.response !== undefined) {
    const response = ctx.response;
    return {
      updates: init.stream ? transform(agentResponseToUpdates(response), updateHooks) : noUpdates(),
      final: () => applyResultHooks(response),
    };
  }

  if (inner === undefined) {
    // Terminated without a result. The caller still gets a well-formed response rather than an
    // error, so a middleware can decline a run the same way it can answer one.
    const empty = agentResponse<unknown>({ messages: [], agentId: init.agent.id });
    return { updates: noUpdates(), final: () => applyResultHooks(empty) };
  }

  const stream = inner;
  return {
    updates: transform(stream, updateHooks),
    final: async () => applyResultHooks(await stream.finalResponse()),
  };
}

/**
 * Applies the `onUpdate` hooks to what the caller observes.
 *
 * The source keeps recording untransformed updates, so the folded result, the persisted transcript
 * and telemetry all describe what the agent produced rather than how a middleware chose to display
 * it (Python `ResponseStream._record_update` appends before transforming).
 */
async function* transform(
  source: AsyncIterable<AgentResponseUpdate> | Iterable<AgentResponseUpdate>,
  hooks: readonly UpdateHook[],
): AsyncGenerator<AgentResponseUpdate> {
  for await (const update of source) {
    let current = update;
    for (const hook of hooks) {
      const hooked = await hook(current);
      if (hooked !== undefined && hooked !== null) {
        current = hooked;
      }
    }
    yield current;
  }
}
