import { AsyncLocalStorage } from 'node:async_hooks';
import { context as otelContext, propagation } from '@opentelemetry/api';

/** The HTTP header names that make up the platform contract (protocol v2.0.0). */
export const HEADERS = {
  /** Correlation id; echoed back on the response. */
  requestId: 'x-request-id',
  /** Server SDK identity, set on every response. */
  serverVersion: 'x-platform-server',
  /** The resolved session id, returned to the platform. */
  sessionId: 'x-agent-session-id',
  /**
   * The end user, injected by the platform. Partition key for per-user state.
   *
   * **Never forwarded outbound.** See {@link RequestContext.platformHeaders}.
   */
  userId: 'x-agent-user-id',
  /** Opaque per-request call id (v2.0.0 only). Must be forwarded to Foundry 1P services. */
  foundryCallId: 'x-agent-foundry-call-id',
  /** A response id chosen by the platform; takes precedence over anything the client asks for. */
  responseId: 'x-agent-response-id',
  /** `user` / `platform` / `upstream`, on 4xx and 5xx. */
  errorSource: 'x-platform-error-source',
  /** Internal diagnostics for the platform, truncated. Never in the response body. */
  errorDetail: 'x-platform-error-detail',
  /** Prefix for client pass-through headers. */
  clientPrefix: 'x-client-',
} as const;

/** Everything the protocol layer knows about the request in flight. */
export interface RequestContext {
  /** The end user, or `undefined` outside a hosted environment. */
  readonly userId: string | undefined;
  /** The platform's per-request call id, when protocol v2.0.0 is in play. */
  readonly foundryCallId: string | undefined;
  readonly requestId: string;
  /** `x-client-*` headers the caller sent. */
  readonly clientHeaders: Readonly<Record<string, string>>;
  /** W3C trace context, for outbound propagation. */
  readonly traceparent: string | undefined;
  /**
   * The W3C vendor trace state that came with {@link traceparent}.
   *
   * Kept next to it because the two are one value split across two headers: `tracestate` is
   * interpreted relative to the `traceparent` it arrived with, so neither is meaningful alone.
   */
  readonly tracestate: string | undefined;
  /**
   * The headers to attach to a call to a Foundry first-party service.
   *
   * The call id, and the W3C trace context (`traceparent` + `tracestate`) when there is one.
   * `x-agent-user-id` is deliberately excluded: it is a global cross-agent identifier, and leaking
   * it to an arbitrary outbound host would hand that host a durable handle on the end user. The
   * trace context is not in that category — it is a correlator, not an identity — so the trace is
   * propagated rather than broken at every hop.
   */
  platformHeaders(): Record<string, string>;
}

const storage = new AsyncLocalStorage<RequestContext>();

function collectClientHeaders(headers: Headers): Record<string, string> {
  const collected: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith(HEADERS.clientPrefix)) {
      collected[name.toLowerCase()] = value;
    }
  });
  return collected;
}

/** Builds the context for one inbound request. */
export function createRequestContext(headers: Headers): RequestContext {
  const userId = headers.get(HEADERS.userId) ?? undefined;
  const foundryCallId = headers.get(HEADERS.foundryCallId) ?? undefined;
  const requestId = headers.get(HEADERS.requestId) ?? crypto.randomUUID();
  const clientHeaders = collectClientHeaders(headers);
  const traceparent = headers.get('traceparent') ?? undefined;
  const tracestate = headers.get('tracestate') ?? undefined;

  return {
    userId,
    foundryCallId,
    requestId,
    clientHeaders,
    traceparent,
    tracestate,
    platformHeaders(): Record<string, string> {
      const out: Record<string, string> = {};
      if (foundryCallId !== undefined) {
        out[HEADERS.foundryCallId] = foundryCallId;
      }
      // The *active* span's context, when an SDK is registered — an outbound call made inside
      // `invoke_agent` must correlate as its child, not as a sibling stamped with the inbound
      // value. With no propagator (or no active span) the injection
      // writes nothing and the caller's own trace context passes through as before.
      const injected: Record<string, string> = {};
      propagation.inject(otelContext.active(), injected);
      // `traceparent` and `tracestate` are one value in two headers: `tracestate` records vendor
      // state *for the trace the accompanying `traceparent` names* (W3C trace-context section 3.3), so
      // they are taken from the same source and never mixed. Sending the inbound `tracestate`
      // beside an injected `traceparent` would attribute the caller's vendor state to this
      // server's span; sending a `traceparent` without its `tracestate` silently discards every
      // vendor's sampling and routing decisions at this hop.
      const source: { traceparent: string; tracestate: string | undefined } | undefined =
        injected.traceparent !== undefined
          ? { traceparent: injected.traceparent, tracestate: injected.tracestate }
          : traceparent !== undefined
            ? { traceparent, tracestate }
            : undefined;
      if (source !== undefined) {
        out.traceparent = source.traceparent;
        if (source.tracestate !== undefined && source.tracestate !== '') {
          out.tracestate = source.tracestate;
        }
      }
      return out;
    },
  };
}

/**
 * Runs `fn` with `context` as the ambient request context.
 *
 * `AsyncLocalStorage` carries it across every `await` inside `fn`, which is what lets a toolbox
 * call deep inside a handler find the call id without threading it through every signature.
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The context of the request in flight, or `undefined` outside one. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The headers for an outbound call to a Foundry service.
 *
 * Empty outside a request, and never contains the user id. See {@link RequestContext.platformHeaders}.
 */
export function platformHeaders(): Record<string, string> {
  return getRequestContext()?.platformHeaders() ?? {};
}
