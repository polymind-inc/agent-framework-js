import type { Context, TextMapGetter, TextMapPropagator, TextMapSetter } from '@opentelemetry/api';
import {
  context as contextApi,
  isValidTraceId,
  metrics,
  propagation,
  ROOT_CONTEXT,
  TraceFlags,
  trace,
} from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, assert, describe, expect, it } from 'vitest';
import { HEADERS } from './context.js';
import { makeServer, post } from './test-helpers.js';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const SPAN_ID = '0123456789abcdef';
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;
const ZERO_TRACEPARENT = '00-00000000000000000000000000000000-0000000000000000-00';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A header carrying a trace id in a format no W3C propagator reads. */
const CUSTOM_TRACE_HEADER = 'x-test-trace-id';
const CUSTOM_TRACE_ID = 'aaaaaaaabbbbbbbbccccccccdddddddd';

/**
 * A propagator for {@link CUSTOM_TRACE_HEADER}, standing in for any non-W3C trace format a
 * deployment might register (B3, Jaeger, a vendor's own).
 */
const customPropagator: TextMapPropagator = {
  inject(_context: Context, _carrier: unknown, _setter: TextMapSetter): void {},
  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    const traceId = getter.get(carrier, CUSTOM_TRACE_HEADER);
    if (typeof traceId !== 'string' || !isValidTraceId(traceId)) {
      return context;
    }
    return trace.setSpanContext(context, {
      traceId,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
  },
  fields(): string[] {
    return [CUSTOM_TRACE_HEADER];
  },
};

/** Registers an SDK, which is what makes `context.with` and the global propagator take effect. */
function registerSdk(propagator?: TextMapPropagator): void {
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
  });
  provider.register(propagator === undefined ? {} : { propagator });
}

function requestIdOf(response: Response): string {
  const value = response.headers.get(HEADERS.requestId);
  assert.exists(value);
  return value;
}

describe('request id resolution', () => {
  afterEach(() => {
    trace.disable();
    metrics.disable();
    propagation.disable();
    contextApi.disable();
  });

  it('answers with the trace the caller named, over the correlation id it sent', async () => {
    registerSdk();

    const response = await makeServer().handle(
      post({ input: 'x' }, { traceparent: TRACEPARENT, [HEADERS.requestId]: 'req-123' }),
    );

    expect(requestIdOf(response)).toBe(TRACE_ID);
  });

  it('reads the trace id off the header when no SDK is registered', async () => {
    // Whether a deployment installed an OTel SDK is not something a calling service can see, so
    // the id it gets back must not depend on it.
    const response = await makeServer().handle(
      post({ input: 'x' }, { traceparent: TRACEPARENT, [HEADERS.requestId]: 'req-123' }),
    );

    expect(requestIdOf(response)).toBe(TRACE_ID);
  });

  it('takes the trace id from a registered non-W3C propagator', async () => {
    registerSdk(customPropagator);

    const response = await makeServer().handle(
      post(
        { input: 'x' },
        { [CUSTOM_TRACE_HEADER]: CUSTOM_TRACE_ID, traceparent: TRACEPARENT, [HEADERS.requestId]: 'req-123' },
      ),
    );

    expect(requestIdOf(response)).toBe(CUSTOM_TRACE_ID);
  });

  it('prefers the trace already active over the one the request names', async () => {
    registerSdk();
    const active = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: CUSTOM_TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
    });

    const response = await contextApi.with(active, () =>
      makeServer().handle(post({ input: 'x' }, { traceparent: TRACEPARENT })),
    );

    expect(requestIdOf(response)).toBe(CUSTOM_TRACE_ID);
  });

  it.each([
    // Nothing like a traceparent, a well-shaped one whose trace id is not hex, and one truncated
    // to fewer fields than the format defines.
    'not-a-traceparent',
    `00-nothex${'0'.repeat(26)}-${SPAN_ID}-01`,
    `00-${TRACE_ID}`,
  ])(
    'falls back to the correlation id the caller sent when the traceparent is malformed (%s)',
    async (traceparent) => {
      registerSdk();

      const response = await makeServer().handle(
        post({ input: 'x' }, { traceparent, [HEADERS.requestId]: 'req-123' }),
      );

      expect(requestIdOf(response)).toBe('req-123');
    },
  );

  it('treats an all-zero trace id as no trace at all', async () => {
    registerSdk();

    const response = await makeServer().handle(
      post({ input: 'x' }, { traceparent: ZERO_TRACEPARENT, [HEADERS.requestId]: 'req-123' }),
    );

    expect(requestIdOf(response)).toBe('req-123');
  });

  it('mints an id when the only trace id offered is all zeros and no correlation id was sent', async () => {
    const response = await makeServer().handle(post({ input: 'x' }, { traceparent: ZERO_TRACEPARENT }));

    const requestId = requestIdOf(response);
    expect(requestId).not.toContain('0000000000000000');
    expect(requestId).toMatch(UUID);
  });

  it('echoes an empty correlation id as a minted one rather than an empty header', async () => {
    const response = await makeServer().handle(post({ input: 'x' }, { [HEADERS.requestId]: '' }));

    expect(requestIdOf(response)).toMatch(UUID);
  });

  it('reports one resolved id on the response header and in the error body', async () => {
    registerSdk();

    const response = await makeServer().handle(
      new Request('http://localhost:8088/nope', { headers: { traceparent: TRACEPARENT } }),
    );
    const body = (await response.json()) as { error: { additionalInfo: { request_id: string } } };

    expect(response.status).toBe(404);
    expect(requestIdOf(response)).toBe(TRACE_ID);
    expect(body.error.additionalInfo.request_id).toBe(requestIdOf(response));
  });
});
