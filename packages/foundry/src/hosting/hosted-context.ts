/**
 * The typed execution context of one hosted turn, for code that runs *inside* the agent.
 *
 * The hosting handler receives everything about the turn as explicit arguments, and the stores it
 * writes to take the user id as a required parameter — a partition key that lives in a signature
 * is one the compiler enforces. But tools, context providers and middleware are wired into the
 * agent by the application, not by the handler, so there is no argument the handler could hand
 * down to them. For those, this module carries the turn's context ambiently, the same split the
 * .NET implementation reaches with explicit `RunCoreAsync` parameters plus an `AsyncLocal`
 * accessor, and Python with a `ContextVar` the endpoint sets per turn.
 *
 * ## What is deliberately not here
 *
 * - **A tenant.** The platform's trust boundary injects exactly two identifiers per request: the
 *   end-user id and the call id. A hosted container is deployed per agent, inside one tenant, so
 *   tenant isolation is container isolation; inventing a per-request tenant field would claim an
 *   identity the platform never supplies.
 * - **Trace context.** OpenTelemetry's own ambient context is the source of truth for the active
 *   trace; a copy here would drift from it the moment a span starts or ends.
 *
 * ## Scope
 *
 * The context is installed around the agent-run stream by re-entering the `AsyncLocalStorage`
 * scope on every pull (the consent channel does the same, and for the same reason): an async
 * generator resumes in its consumer's context, so wrapping the whole loop once would leave the
 * propagation to wherever the loop happened to be suspended. Outside a hosted turn — including
 * after it ends — {@link getHostedAgentContext} returns `undefined`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentReference, HandlerContext } from '@polymind-inc/agent-framework-agentserver';

/** What one hosted turn knows about itself. One frozen instance per turn. */
export interface HostedAgentContext {
  /**
   * The end user this turn serves, injected by the platform. The partition key for per-user
   * state, and `undefined` outside a hosted environment (local runs share one anonymous
   * partition). Never forward it on an outbound call: it is a global, cross-agent identifier.
   */
  readonly userId: string | undefined;
  /**
   * The platform's opaque per-request call id, when protocol v2.0.0 is in play. Foundry
   * first-party services require it on outbound calls; `platformHeaders()` already forwards it.
   */
  readonly callId: string | undefined;
  /** The correlation id, echoed on the response as `x-request-id`. */
  readonly requestId: string;
  /** The id this turn's response is stored under. */
  readonly responseId: string;
  /** The conversation this turn belongs to, when the request named one. */
  readonly conversationId: string | undefined;
  /** Which agent this turn resolved to. Always carries a non-empty name. */
  readonly agent: AgentReference;
  /**
   * The sandbox session this turn runs in. Container-scoped, not conversation-scoped: one value
   * serves every conversation and user this container hosts, so it must never key per-user or
   * per-conversation state.
   */
  readonly agentSessionId: string;
  /** Aborted when the client disconnects or the container is shutting down. */
  readonly signal: AbortSignal;
}

const storage = new AsyncLocalStorage<HostedAgentContext>();

/** The turn's context, narrowed from what the protocol layer hands the handler. */
export function hostedAgentContextOf(context: HandlerContext): HostedAgentContext {
  return Object.freeze({
    userId: context.request.userId,
    callId: context.request.foundryCallId,
    requestId: context.request.requestId,
    responseId: context.responseId,
    conversationId: context.conversationId,
    agent: context.agentReference,
    agentSessionId: context.agentSessionId,
    signal: context.signal,
  });
}

/**
 * The context of the hosted turn in flight, or `undefined` outside one.
 *
 * Read-only by construction: the instance is frozen, and nothing here can widen a tool's or
 * provider's authority — the stores that persist per-user state take their partition key as an
 * explicit argument and never read it from this ambient.
 */
export function getHostedAgentContext(): HostedAgentContext | undefined {
  return storage.getStore();
}

/**
 * Drives `stream` with `context` installed as the ambient hosted context.
 *
 * Each `next()` is invoked inside `AsyncLocalStorage.run`, which is where the agent runs the
 * round — the model call, the tools, the context providers — so a read from any of them lands on
 * this turn's context and nowhere else, including while another turn is interleaved on the same
 * container.
 */
export async function* withHostedAgentContext<T>(
  context: HostedAgentContext,
  stream: AsyncIterable<T>,
): AsyncGenerator<T, void, undefined> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await storage.run(context, () => iterator.next());
      if (next.done === true) {
        return;
      }
      yield next.value;
    }
  } finally {
    // `break` in the consumer has to reach the agent's own cleanup (session save, tool teardown)
    // exactly as it would without this wrapper.
    await iterator.return?.();
  }
}
