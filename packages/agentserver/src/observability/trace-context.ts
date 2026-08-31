/**
 * Inbound W3C trace-context handling, on `@opentelemetry/api` alone.
 *
 * The reference's `TraceContextMiddleware`: extract `traceparent` / `tracestate` / `baggage`
 * from the request and make them the ambient context for the turn, so every span the handler
 * creates parents under the calling service's trace. **No server span is created** — the
 * framework's `invoke_agent` span attaches directly to the caller's, which is the reference's
 * deliberate choice on both sides (.NET `ResponsesActivitySource`, Python
 * `TraceContextMiddleware`).
 *
 * With no SDK registered, `propagation` is a no-op and every context built here is the root
 * context. {@link inboundTraceId} is the exception: what it answers reaches the caller on a
 * response header, so it reads the inbound `traceparent` itself rather than going quiet.
 */

import type { Context, TextMapGetter } from '@opentelemetry/api';
import { isValidTraceId, context as otelContext, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';

const HEADERS_GETTER: TextMapGetter<Headers> = {
  get(carrier: Headers, key: string): string | undefined {
    return carrier.get(key) ?? undefined;
  },
  keys(carrier: Headers): string[] {
    return [...carrier.keys()];
  },
};

/**
 * The OTel context one inbound request establishes.
 *
 * An `x-request-id` the caller sent rides along as the `x_request_id` baggage entry (the
 * reference's key, underscores included), for downstream correlation.
 */
export function extractTraceContext(headers: Headers): Context {
  let extracted = propagation.extract(ROOT_CONTEXT, headers, HEADERS_GETTER);
  const requestId = headers.get('x-request-id');
  if (requestId !== null && requestId !== '') {
    const bag = propagation.getBaggage(extracted) ?? propagation.createBaggage();
    extracted = propagation.setBaggage(extracted, bag.setEntry('x_request_id', { value: requestId }));
  }
  return extracted;
}

/**
 * The W3C `traceparent` grammar: `version-traceid-parentid-flags`, lowercase hex throughout.
 *
 * `ff` is reserved and is never a version. Neither id may be all zeros — that is the value the
 * format defines as "no trace". A version this build does not know may append further fields, so
 * the trailing group is allowed and checked against the version below.
 */
const TRACEPARENT =
  /^\s?((?!ff)[\da-f]{2})-((?![0]{32})[\da-f]{32})-(?![0]{16})[\da-f]{16}-[\da-f]{2}(-.*)?\s?$/;

/**
 * The trace-id field of a W3C `traceparent`, when the whole value is one.
 *
 * Every field decides this, not the trace id alone: a header whose parent id is all zeros, whose
 * flags are not two hex digits, or whose version is the reserved `ff` does not name a trace this
 * request belongs to, and reading an id out of it would let a malformed header displace the
 * correlation id the caller sent.
 *
 * The rule is the grammar itself, which is also what a conforming propagator applies — so the
 * answer here and the answer from an extracted context agree on the same header, and that
 * agreement is what the tests pin rather than the wording of this comment.
 */
function traceparentTraceId(traceparent: string | null): string | undefined {
  if (traceparent === null) {
    return undefined;
  }
  const match = TRACEPARENT.exec(traceparent);
  if (match === null) {
    return undefined;
  }
  // Extra fields belong to versions that define them; version `00` is exactly four.
  if (match[1] === '00' && match[3] !== undefined) {
    return undefined;
  }
  return match[2];
}

/**
 * The trace this request already belongs to, or `undefined` when it belongs to none.
 *
 * Three sources, in priority order: the span active around the call — an outer instrumentation's
 * server span, when the host created one — then the context a registered propagator extracts from
 * the request, which is what carries a non-W3C format, and finally the `traceparent` header read
 * directly.
 *
 * That last source is what keeps the answer the same whether or not an OTel SDK was ever
 * registered: with none, the propagation API is a no-op. A value the caller reads back off the
 * response is part of the contract with that caller, so it must not change because of a
 * telemetry choice made inside this process.
 *
 * A trace id that is not 32 hex digits, or is all zeros — the value W3C reserves for "no trace",
 * which a broken instrumentation does emit — names no trace and is rejected at every source.
 */
export function inboundTraceId(headers: Headers): string | undefined {
  const active = trace.getSpanContext(otelContext.active())?.traceId;
  if (active !== undefined && isValidTraceId(active)) {
    return active;
  }
  const extracted = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, headers, HEADERS_GETTER))?.traceId;
  if (extracted !== undefined && isValidTraceId(extracted)) {
    return extracted;
  }
  return traceparentTraceId(headers.get('traceparent'));
}

/**
 * The baggage entries the server stamps on every `POST /responses`, worded exactly as the
 * references word them (Python `_endpoint_handler.handle_create`, .NET
 * `ResponsesTracingConstants.Baggage`).
 *
 * These are *self*-stamped: the calling service is not required to send anything. Without them
 * the enrichment processor's lifts never fire, and a span would carry `gen_ai.conversation.id`
 * only when the caller happened to speak W3C baggage.
 */
export const RESPONSE_BAGGAGE = {
  responseId: 'azure.ai.agentserver.response_id',
  /**
   * The very key `FOUNDRY_BAGGAGE.conversationId` (in `./enrichment`) lifts onto
   * `gen_ai.conversation.id`. Written out rather than referenced because
   * `isolatedDeclarations` needs the literal; the two are held together by the enrichment test,
   * which stamps through one constant and asserts through the other.
   */
  conversationId: 'azure.ai.agentserver.conversation_id',
  streaming: 'azure.ai.agentserver.streaming',
  /** Set only when the caller sent the header, as both references gate it. */
  requestId: 'azure.ai.agentserver.x-request-id',
} as const;

/** What the references truncate `x-request-id` to (Python `extract_request_id`, .NET's `[..256]`). */
const MAX_REQUEST_ID_LENGTH = 256;

/** One turn's identity, as the create route knows it. */
export interface ResponseBaggage {
  responseId: string;
  /** `undefined` when the request named no conversation; the entry is still set, empty. */
  conversationId: string | undefined;
  streaming: boolean;
  /** The inbound `x-request-id` header, not this server's generated fallback. */
  requestId: string | undefined;
}

/**
 * Adds the create-time baggage to `context`, keeping whatever the caller sent.
 *
 * `streaming` is the reference's stringified boolean — `"True"` / `"False"`, PascalCase in both
 * Python (`str(bool)`) and .NET (`bool.ToString()`) — because the value travels as written and a
 * consumer matching on it would not recognise `"true"`.
 */
export function withResponseBaggage(context: Context, turn: ResponseBaggage): Context {
  let bag = propagation.getBaggage(context) ?? propagation.createBaggage();
  bag = bag
    .setEntry(RESPONSE_BAGGAGE.responseId, { value: turn.responseId })
    // Always present, empty when there is no conversation: the references write
    // `conversation_id or ""` / `?? string.Empty` rather than omitting the entry. Their
    // enrichment processors test the value for truth, so an empty one stamps no attribute.
    .setEntry(RESPONSE_BAGGAGE.conversationId, { value: turn.conversationId ?? '' })
    .setEntry(RESPONSE_BAGGAGE.streaming, { value: turn.streaming ? 'True' : 'False' });
  if (turn.requestId !== undefined && turn.requestId !== '') {
    bag = bag.setEntry(RESPONSE_BAGGAGE.requestId, {
      value: turn.requestId.slice(0, MAX_REQUEST_ID_LENGTH),
    });
  }
  return propagation.setBaggage(context, bag);
}

/**
 * The baggage entries the Invocations server stamps on every request it dispatches, worded as
 * both references word them (Python `_invocation.py`, .NET `InvocationsActivitySource`).
 *
 * Self-stamped for the same reason as {@link RESPONSE_BAGGAGE}: the calling service is not
 * required to send anything, and these are what correlate the handler's spans with the
 * invocation that caused them. No server span carries them — neither reference creates one.
 */
export const INVOCATION_BAGGAGE = {
  invocationId: 'azure.ai.agentserver.invocation_id',
  sessionId: 'azure.ai.agentserver.session_id',
} as const;

/** One invocation's identity, as the dispatch knows it. */
export interface InvocationBaggage {
  invocationId: string;
  sessionId: string;
}

/** Adds the invocation baggage to `context`, keeping whatever the caller sent. */
export function withInvocationBaggage(context: Context, turn: InvocationBaggage): Context {
  let bag = propagation.getBaggage(context) ?? propagation.createBaggage();
  bag = bag
    .setEntry(INVOCATION_BAGGAGE.invocationId, { value: turn.invocationId })
    .setEntry(INVOCATION_BAGGAGE.sessionId, { value: turn.sessionId });
  return propagation.setBaggage(context, bag);
}

/**
 * Runs every pull of `iterable` through `run`, which re-enters whatever ambient scopes the turn
 * needs — the OTel context, the request's `AsyncLocalStorage`, or both composed.
 *
 * An async generator resumes in whatever context its consumer holds when it calls `next()` — and
 * an SSE body is consumed by the socket writer, long after the request scope closed. Without
 * this, the handler's spans would parent correctly up to the first event (pulled inside the
 * request scope) and then fall out of the trace, and work the turn still does while the stream
 * drains would lose the request's platform headers.
 */
export function bindIterable<T>(iterable: AsyncIterable<T>, run: <R>(fn: () => R) => R): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const iterator = iterable[Symbol.asyncIterator]();
      const { return: returnFn, throw: throwFn } = iterator;
      const bound: AsyncIterator<T> = {
        next: (): Promise<IteratorResult<T>> => run(() => iterator.next()),
      };
      if (returnFn !== undefined) {
        bound.return = (value?: unknown): Promise<IteratorResult<T>> =>
          run(() => returnFn.call(iterator, value));
      }
      if (throwFn !== undefined) {
        bound.throw = (error?: unknown): Promise<IteratorResult<T>> =>
          run(() => throwFn.call(iterator, error));
      }
      return bound;
    },
  };
}
