import { metrics, trace } from '@opentelemetry/api';
import type { DataPoint, Histogram, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Agent } from '../agent/agent.js';
import { MockChatClient } from '../client/test-support.js';
import { tool } from '../tools/tool.js';
import { textContent } from '../types/content.js';
import {
  GEN_AI_METRICS,
  OPERATION_DURATION_BUCKET_BOUNDARIES,
  TOKEN_USAGE_BUCKET_BOUNDARIES,
} from './metrics.js';
import { configureObservability } from './settings.js';

// Delta rather than cumulative, so each test reads only the samples its own run produced.
const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
const meterProvider = new MeterProvider({ readers: [reader] });

const spanExporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });

beforeAll(() => {
  metrics.setGlobalMeterProvider(meterProvider);
  trace.setGlobalTracerProvider(tracerProvider);
});

afterEach(() => {
  exporter.reset();
  spanExporter.reset();
  configureObservability({});
});

afterAll(async () => {
  await meterProvider.shutdown();
  await tracerProvider.shutdown();
  metrics.disable();
  trace.disable();
});

/** Forces a collection and returns the metrics of this framework's meter. */
async function collect(): Promise<ResourceMetrics['scopeMetrics'][number] | undefined> {
  await reader.forceFlush();
  const batches = exporter.getMetrics();
  const latest = batches[batches.length - 1];
  return latest?.scopeMetrics.find((scope) => scope.scope.name === '@polymind-inc/agent-framework-core');
}

function usingClient(usage?: { inputTokenCount: number; outputTokenCount: number }): MockChatClient {
  return new MockChatClient([
    {
      contents: [textContent('hi')],
      finishReason: 'stop',
      ...(usage === undefined ? {} : { usage }),
    },
  ]);
}

describe('chat metrics', () => {
  it('records token usage split by token type, with the Python bucket boundaries', async () => {
    const agent = new Agent({ client: usingClient({ inputTokenCount: 12, outputTokenCount: 34 }) });

    await agent.run('hello');

    const scope = await collect();
    const tokens = scope?.metrics.find((m) => m.descriptor.name === GEN_AI_METRICS.tokenUsage);
    expect(tokens?.descriptor.unit).toBe('tokens');
    const points = tokens?.dataPoints as Array<DataPoint<Histogram>>;
    const byType = Object.fromEntries(
      points.map((point) => [point.attributes['gen_ai.token.type'], point.value.sum]),
    );
    expect(byType).toEqual({ input: 12, output: 34 });
    expect(points[0]?.value.buckets.boundaries).toEqual([...TOKEN_USAGE_BUCKET_BOUNDARIES]);
    expect(points[0]?.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'mock',
      'gen_ai.request.model': 'mock-model',
    });
  });

  it('records the operation duration, with the Python bucket boundaries', async () => {
    await new Agent({ client: usingClient() }).run('hello');

    const scope = await collect();
    const duration = scope?.metrics.find((m) => m.descriptor.name === GEN_AI_METRICS.operationDuration);
    expect(duration?.descriptor.unit).toBe('s');
    const points = duration?.dataPoints as Array<DataPoint<Histogram>>;
    expect(points[0]?.value.count).toBe(1);
    expect(points[0]?.value.buckets.boundaries).toEqual([...OPERATION_DURATION_BUCKET_BOUNDARIES]);
    // High-cardinality span attributes must not become metric dimensions.
    expect(points[0]?.attributes).not.toHaveProperty('gen_ai.response.id');
  });

  it('carries error.type on the duration of a failed call', async () => {
    const failing = {
      metadata: { providerName: 'mock' },
      getResponse: (): never => {
        throw new Error('boom');
      },
    };

    await expect(new Agent({ client: failing as never }).run('hello')).rejects.toThrow('boom');

    const scope = await collect();
    const duration = scope?.metrics.find((m) => m.descriptor.name === GEN_AI_METRICS.operationDuration);
    const points = duration?.dataPoints as Array<DataPoint<Histogram>>;
    expect(points[0]?.attributes['error.type']).toBe('Error');
  });

  it('records one sample per model round of a tool loop', async () => {
    const echo = tool({
      name: 'echo',
      description: 'Echoes',
      parameters: { type: 'object', properties: {} },
      execute: () => 'ok',
    });
    const client = new MockChatClient([
      {
        contents: [{ type: 'function_call', callId: 'call_1', name: 'echo', arguments: {} }],
        usage: { inputTokenCount: 10, outputTokenCount: 2 },
      },
      {
        contents: [textContent('done')],
        finishReason: 'stop',
        usage: { inputTokenCount: 20, outputTokenCount: 3 },
      },
    ]);

    await new Agent({ client, tools: [echo] }).run('go');

    const scope = await collect();
    const duration = scope?.metrics.find((m) => m.descriptor.name === GEN_AI_METRICS.operationDuration);
    const points = duration?.dataPoints as Array<DataPoint<Histogram>>;
    expect(points[0]?.value.count).toBe(2);
  });
});

describe('nested usage aggregation', () => {
  it('sums the usage of every tool round onto the invoke_agent span', async () => {
    const echo = tool({
      name: 'echo',
      description: 'Echoes',
      parameters: { type: 'object', properties: {} },
      execute: () => 'ok',
    });
    const client = new MockChatClient([
      {
        contents: [{ type: 'function_call', callId: 'call_1', name: 'echo', arguments: {} }],
        usage: { inputTokenCount: 10, outputTokenCount: 2 },
      },
      {
        contents: [textContent('done')],
        finishReason: 'stop',
        usage: { inputTokenCount: 20, outputTokenCount: 3 },
      },
    ]);

    await new Agent({ client, tools: [echo], name: 'bot' }).run('go');

    const invoke = spanExporter.getFinishedSpans().find((span) => span.name === 'invoke_agent bot');
    expect(invoke?.attributes['gen_ai.usage.input_tokens']).toBe(30);
    expect(invoke?.attributes['gen_ai.usage.output_tokens']).toBe(5);
    // Each inner round still reports its own.
    const rounds = spanExporter
      .getFinishedSpans()
      .filter((span) => span.name.startsWith('chat'))
      .map((span) => span.attributes['gen_ai.usage.input_tokens']);
    expect(rounds).toEqual([10, 20]);
  });
});

describe('message events', () => {
  it('emits role-named events on the chat span when content capture is on', async () => {
    configureObservability({ captureMessageContent: true });

    await new Agent({ client: usingClient(), name: 'bot' }).run('hello');

    const chat = spanExporter.getFinishedSpans().find((span) => span.name.startsWith('chat'));
    const names = chat?.events.map((event) => event.name);
    expect(names).toEqual(['gen_ai.user.message', 'gen_ai.choice']);
    const first = chat?.events[0];
    expect(first?.attributes?.['event.name']).toBe('gen_ai.user.message');
    expect(JSON.parse(String(first?.attributes?.body))).toEqual({ content: 'hello' });
  });

  it('emits nothing without the opt-in, since the events carry message text', async () => {
    await new Agent({ client: usingClient(), name: 'bot' }).run('hello');

    for (const span of spanExporter.getFinishedSpans()) {
      expect(span.events).toEqual([]);
    }
  });
});

describe('no-op behaviour without an SDK', () => {
  it('records nothing when no meter provider is registered', async () => {
    metrics.disable();
    try {
      const response = await new Agent({ client: usingClient() }).run('hello');
      expect(response.text).toBe('hi');
    } finally {
      metrics.setGlobalMeterProvider(meterProvider);
    }
  });
});
