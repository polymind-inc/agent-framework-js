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
 * With no SDK registered, `propagation` is a no-op and everything here returns the root context.
 */

import type { Context, TextMapGetter } from '@opentelemetry/api';
import { context as contextApi, propagation, ROOT_CONTEXT } from '@opentelemetry/api';

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
 * Pins `context` to every pull of `iterable`.
 *
 * An async generator resumes in whatever context its consumer holds when it calls `next()` — and
 * an SSE body is consumed by the socket writer, long after the request scope closed. Without
 * this, the handler's spans would parent correctly up to the first event (pulled inside the
 * request scope) and then fall out of the trace.
 */
export function bindIterable<T>(iterable: AsyncIterable<T>, context: Context): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const iterator = iterable[Symbol.asyncIterator]();
      const { return: returnFn, throw: throwFn } = iterator;
      const bound: AsyncIterator<T> = {
        next: (): Promise<IteratorResult<T>> => contextApi.with(context, () => iterator.next()),
      };
      if (returnFn !== undefined) {
        bound.return = (value?: unknown): Promise<IteratorResult<T>> =>
          contextApi.with(context, () => returnFn.call(iterator, value));
      }
      if (throwFn !== undefined) {
        bound.throw = (error?: unknown): Promise<IteratorResult<T>> =>
          contextApi.with(context, () => throwFn.call(iterator, error));
      }
      return bound;
    },
  };
}
