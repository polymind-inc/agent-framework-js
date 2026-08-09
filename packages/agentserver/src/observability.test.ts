import { context as contextApi, metrics, propagation, SpanKind, trace } from '@opentelemetry/api';
import type * as SdkMetrics from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { otlpProtocol, UnsupportedOtlpProtocolError } from './config.js';
import { platformHeaders } from './context.js';
import { ProtocolError } from './errors.js';
import { FOUNDRY_ATTR, FOUNDRY_BAGGAGE, FoundryEnrichmentSpanProcessor } from './observability/enrichment.js';
import { flushTelemetry, setTelemetryFlusher } from './observability/flush.js';
import { GenAIMainAgentSpanProcessor } from './observability/main-agent.js';
// Type-only, and never used as a value: the setup module is re-imported per test through
// `vi.resetModules()`, so importing it here would pin the very instance those tests replace.
import type * as HostObservabilitySetup from './observability/setup.js';
import { RESPONSE_BAGGAGE } from './observability/trace-context.js';
import type { HandlerContext, ResponseHandler } from './server.js';
import { ResponsesServer } from './server.js';
import { InMemoryResponseProvider } from './store/memory.js';
import type { ResponseProvider } from './store/provider.js';
import type { CreateResponseRequest, ResponseObject } from './wire.js';

/** Resets every piece of global OTel state a test may have registered. */
function disableGlobalOtel(): void {
  trace.disable();
  metrics.disable();
  propagation.disable();
  contextApi.disable();
  setTelemetryFlusher(undefined);
}

/** Narrows away undefined; a missing value fails the test with a clear error. */
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value');
  return value;
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:8088/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** The smallest event sequence the lifecycle contract accepts, with room for span-making work. */
function minimalHandler(work?: (stage: 'start' | 'late') => void): ResponseHandler {
  return async function* (_request: CreateResponseRequest, context: HandlerContext) {
    const response = (status: ResponseObject['status']): ResponseObject => ({
      ...context.response,
      status,
    });
    work?.('start');
    yield { type: 'response.created', response: response('queued') };
    yield { type: 'response.in_progress', response: response('in_progress') };
    work?.('late');
    yield { type: 'response.completed', response: response('completed') };
  };
}

describe('otlpProtocol', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to http/protobuf', () => {
    expect(otlpProtocol('OTEL_EXPORTER_OTLP_TRACES_PROTOCOL')).toBe('http/protobuf');
  });

  it('prefers the per-signal variable over the shared one', () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'grpc');
    vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_PROTOCOL', 'http/protobuf');
    expect(otlpProtocol('OTEL_EXPORTER_OTLP_TRACES_PROTOCOL')).toBe('grpc');
    expect(otlpProtocol('OTEL_EXPORTER_OTLP_METRICS_PROTOCOL')).toBe('http/protobuf');
  });

  it('rejects an unsupported protocol with the config-error type, as the reference does', () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'json');
    expect(() => otlpProtocol('OTEL_EXPORTER_OTLP_TRACES_PROTOCOL')).toThrow(UnsupportedOtlpProtocolError);
  });
});

describe('FoundryEnrichmentSpanProcessor', () => {
  it('stamps identity at end (winning over mid-span writes) and lifts baggage at start', () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [
        new FoundryEnrichmentSpanProcessor({
          agentName: 'weather-agent',
          agentVersion: '3',
          agentId: 'client-id-1',
          projectId: '/subscriptions/s/rg/r/projects/p',
          blueprintId: 'bp-1',
          tenantId: 'tenant-1',
        }),
        new SimpleSpanProcessor(exporter),
      ],
    });

    const bag = propagation
      .createBaggage()
      .setEntry(FOUNDRY_BAGGAGE.sessionId, { value: 'sess-1' })
      .setEntry(FOUNDRY_BAGGAGE.conversationId, { value: 'conv-1' })
      .setEntry(FOUNDRY_BAGGAGE.invocationId, { value: 'inv-1' });
    const ctx = propagation.setBaggage(contextApi.active(), bag);

    const span = provider.getTracer('test').startSpan('framework-span', {}, ctx);
    // A framework writing its own value mid-span must lose to the platform's identity.
    span.setAttribute(FOUNDRY_ATTR.agentName, 'framework-thinks-otherwise');
    span.end();

    const [finished] = exporter.getFinishedSpans();
    expect(finished?.attributes[FOUNDRY_ATTR.projectId]).toBe('/subscriptions/s/rg/r/projects/p');
    expect(finished?.attributes[FOUNDRY_ATTR.sessionId]).toBe('sess-1');
    expect(finished?.attributes[FOUNDRY_ATTR.conversationId]).toBe('conv-1');
    expect(finished?.attributes[FOUNDRY_ATTR.invocationId]).toBe('inv-1');
    expect(finished?.attributes[FOUNDRY_ATTR.agentName]).toBe('weather-agent');
    expect(finished?.attributes[FOUNDRY_ATTR.agentVersion]).toBe('3');
    expect(finished?.attributes[FOUNDRY_ATTR.agentId]).toBe('client-id-1');
    expect(finished?.attributes[FOUNDRY_ATTR.blueprintId]).toBe('bp-1');
    expect(finished?.attributes[FOUNDRY_ATTR.tenantId]).toBe('tenant-1');
  });

  it('adds nothing when identity and baggage are absent', () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new FoundryEnrichmentSpanProcessor({}), new SimpleSpanProcessor(exporter)],
    });

    provider.getTracer('test').startSpan('bare').end();

    const [finished] = exporter.getFinishedSpans();
    expect(finished).toBeDefined();
    expect(Object.keys(finished?.attributes ?? {})).toEqual([]);
  });
});

describe('GenAIMainAgentSpanProcessor', () => {
  function pipeline(...processors: import('@opentelemetry/sdk-trace-base').SpanProcessor[]): {
    exporter: InMemorySpanExporter;
    provider: BasicTracerProvider;
  } {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [...processors, new SimpleSpanProcessor(exporter)],
    });
    return { exporter, provider };
  }

  it('promotes the invoke_agent span itself, reading the enrichment-stamped identity', () => {
    const { exporter, provider } = pipeline(
      new FoundryEnrichmentSpanProcessor({ agentName: 'deployed-name', agentVersion: '7', agentId: 'mi-id' }),
      new GenAIMainAgentSpanProcessor(),
    );

    provider
      .getTracer('test')
      .startSpan('invoke_agent bot', {
        attributes: {
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.agent.name': 'in-code-bot',
          'gen_ai.agent.id': 'in-code-id',
        },
      })
      .end();

    // The main-agent processor runs after enrichment, so the platform identity wins over the
    // in-code agent name — matching what the reference host reports.
    const [finished] = exporter.getFinishedSpans();
    expect(finished?.attributes['microsoft.gen_ai.main_agent.name']).toBe('deployed-name');
    expect(finished?.attributes['microsoft.gen_ai.main_agent.id']).toBe('mi-id');
    expect(finished?.attributes['microsoft.gen_ai.main_agent.version']).toBe('7');
  });

  it('copies the parent identity and project ids onto children as they start', () => {
    const { exporter, provider } = pipeline(new GenAIMainAgentSpanProcessor());
    const tracer = provider.getTracer('test');

    const parent = tracer.startSpan('invoke_agent bot', {
      attributes: {
        'gen_ai.agent.name': 'bot',
        'gen_ai.agent.id': 'id-1',
        'gen_ai.conversation.id': 'conv-9',
        'microsoft.foundry.project.id': '/subscriptions/s/rg/r/projects/p',
      },
    });
    const child = tracer.startSpan('chat model', {}, trace.setSpan(contextApi.active(), parent));
    child.end();
    parent.end();

    const finished = exporter.getFinishedSpans().find((span) => span.name === 'chat model');
    expect(finished?.attributes['microsoft.gen_ai.main_agent.name']).toBe('bot');
    expect(finished?.attributes['microsoft.gen_ai.main_agent.id']).toBe('id-1');
    expect(finished?.attributes['microsoft.gen_ai.main_agent.conversation_id']).toBe('conv-9');
    expect(finished?.attributes['microsoft.foundry.project.id']).toBe('/subscriptions/s/rg/r/projects/p');
  });

  it('retries from the parent at end when the parent was stamped after the child started', () => {
    const { exporter, provider } = pipeline(new GenAIMainAgentSpanProcessor());
    const tracer = provider.getTracer('test');

    const parent = tracer.startSpan('invoke_agent bot');
    const child = tracer.startSpan('chat model', {}, trace.setSpan(contextApi.active(), parent));
    parent.setAttribute('gen_ai.agent.name', 'late-bot');
    child.end();
    parent.end();

    const finished = exporter.getFinishedSpans().find((span) => span.name === 'chat model');
    expect(finished?.attributes['microsoft.gen_ai.main_agent.name']).toBe('late-bot');
  });

  it('stamps nothing from a remote parent, whose attributes are not readable', () => {
    const { exporter, provider } = pipeline(new GenAIMainAgentSpanProcessor());
    // The shape the propagator hands the server: a valid but remote span context, as the Foundry
    // gateway's traceparent produces. There are no attributes to read, so nothing propagates.
    const remoteParent = trace.wrapSpanContext({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
      isRemote: true,
    });

    provider
      .getTracer('test')
      .startSpan('chat model', {}, trace.setSpan(contextApi.active(), remoteParent))
      .end();

    const [finished] = exporter.getFinishedSpans();
    expect(finished).toBeDefined();
    expect(Object.keys(finished?.attributes ?? {})).toEqual([]);
  });

  it('leaves an already-stamped span alone', () => {
    const { exporter, provider } = pipeline(new GenAIMainAgentSpanProcessor());

    provider
      .getTracer('test')
      .startSpan('invoke_agent bot', {
        attributes: {
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.agent.name': 'own-name',
          'microsoft.gen_ai.main_agent.name': 'preset',
        },
      })
      .end();

    const [finished] = exporter.getFinishedSpans();
    expect(finished?.attributes['microsoft.gen_ai.main_agent.name']).toBe('preset');
    expect(finished?.attributes['microsoft.gen_ai.main_agent.id']).toBeUndefined();
  });
});

describe('setupHostObservability', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
    disableGlobalOtel();
  });

  /** A fresh module instance per test: the setup is process-once by design. */
  async function freshSetup(): Promise<typeof HostObservabilitySetup> {
    vi.resetModules();
    return await import('./observability/setup.js');
  }

  it('registers providers but no exporters with a bare environment', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { setupHostObservability } = await freshSetup();
    const handle = await setupHostObservability();

    expect(handle.exporters).toEqual([]);
    // The registration check is duck-typed against the API's proxy provider, so the case that
    // matters most is that it stays silent when the registration *did* take.
    expect(warn.mock.calls.flat().join(' ')).not.toContain('another OpenTelemetry SDK');
    // The provider is real: spans record (and the enrichment processor sees them), they just
    // export nowhere — the reference's fallback behaviour.
    const span = trace.getTracer('probe').startSpan('probe');
    expect(span.isRecording()).toBe(true);
    span.end();
    await handle.flush();
  });

  it('stamps the Foundry resource attributes and the main-agent identity through the pipeline', async () => {
    vi.stubEnv('FOUNDRY_AGENT_NAME', 'probe-agent');
    vi.stubEnv('FOUNDRY_AGENT_VERSION', '42');
    vi.stubEnv('FOUNDRY_PROJECT_ENDPOINT', 'https://res.services.ai.azure.com/api/projects/p');
    vi.stubEnv('FOUNDRY_PROJECT_ARM_ID', '/subscriptions/s/rg/r/projects/p');
    const spans = new InMemorySpanExporter();
    const { setupHostObservability } = await freshSetup();
    const handle = await setupHostObservability({ spanProcessors: [new SimpleSpanProcessor(spans)] });
    try {
      trace
        .getTracer('probe')
        .startSpan('invoke_agent bot', { attributes: { 'gen_ai.operation.name': 'invoke_agent' } })
        .end();

      const [finished] = spans.getFinishedSpans();
      // The .NET host's resource-detector attributes, alongside the service identity.
      expect(finished?.resource.attributes['service.name']).toBe('probe-agent');
      expect(finished?.resource.attributes['foundry.agent.name']).toBe('probe-agent');
      expect(finished?.resource.attributes['foundry.agent.version']).toBe('42');
      expect(finished?.resource.attributes['foundry.project.endpoint']).toBe(
        'https://res.services.ai.azure.com/api/projects/p',
      );
      expect(finished?.resource.attributes['foundry.project.arm_id']).toBe(
        '/subscriptions/s/rg/r/projects/p',
      );
      // Enrichment stamps the deployed identity at end, and the main-agent processor — running
      // after it — promotes exactly that identity on the invoke_agent span.
      expect(finished?.attributes['microsoft.gen_ai.main_agent.name']).toBe('probe-agent');
      expect(finished?.attributes['microsoft.gen_ai.main_agent.version']).toBe('42');
    } finally {
      await handle.shutdown();
    }
  });

  it('turns on Azure Monitor export when the platform injects a connection string', async () => {
    vi.stubEnv(
      'APPLICATIONINSIGHTS_CONNECTION_STRING',
      'InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.invalid/',
    );
    const { setupHostObservability } = await freshSetup();
    const handle = await setupHostObservability();

    expect(handle.exporters).toEqual(['azure-monitor']);
  });

  it('accepts entra auth mode for Azure Monitor', async () => {
    vi.stubEnv(
      'APPLICATIONINSIGHTS_CONNECTION_STRING',
      'InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.invalid/',
    );
    vi.stubEnv('APPLICATIONINSIGHTS_AUTH_MODE', 'Entra');
    const { setupHostObservability } = await freshSetup();
    const handle = await setupHostObservability();

    expect(handle.exporters).toEqual(['azure-monitor']);
  });

  it('turns on OTLP http export when an endpoint is set', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
    const { setupHostObservability } = await freshSetup();
    const handle = await setupHostObservability();

    expect(handle.exporters).toEqual(['otlp-http']);
  });

  it('honours the grpc protocol, per signal', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4317');
    vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_PROTOCOL', 'grpc');
    const { setupHostObservability } = await freshSetup();
    const handle = await setupHostObservability();

    // Traces over gRPC, metrics fall back to the http/protobuf default.
    expect(handle.exporters).toEqual(['otlp-grpc', 'otlp-http']);
  });

  it('combines Azure Monitor and OTLP when both are configured', async () => {
    vi.stubEnv(
      'APPLICATIONINSIGHTS_CONNECTION_STRING',
      'InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.invalid/',
    );
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
    const { setupHostObservability } = await freshSetup();
    const handle = await setupHostObservability();

    expect(handle.exporters).toEqual(['azure-monitor', 'otlp-http']);
  });

  it('rejects an unsupported OTLP protocol instead of exporting nowhere', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
    vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'json');
    const { setupHostObservability } = await freshSetup();

    await expect(setupHostObservability()).rejects.toThrow(/Unsupported OTLP protocol/);
  });

  it('serve refuses to start on the same misconfiguration, like the reference host', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
    vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'json');
    // Fresh module generation so the auto-setup actually runs (it is process-once by design).
    vi.resetModules();
    const { serve } = await import('./node.js');
    const { ResponsesServer } = await import('./server.js');
    const server = new ResponsesServer({ handler: minimalHandler() });

    // The message, not the class: the fresh generation has its own class identity.
    await expect(serve(server, { port: 0, host: '127.0.0.1', handleSignals: false })).rejects.toThrow(
      /Unsupported OTLP protocol/,
    );
  });

  it('records outbound fetch calls as HTTP client spans', async () => {
    const httpSpans = new InMemorySpanExporter();
    const { setupHostObservability } = await freshSetup();
    const handle = await setupHostObservability({ spanProcessors: [new SimpleSpanProcessor(httpSpans)] });

    // The `finally` unsubscribes the undici channels even when an assertion throws, so later
    // tests always see an uninstrumented process.
    try {
      const { createServer } = await import('node:http');
      const server = createServer((_req, res) => res.end('ok'));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      try {
        await (await fetch(`http://127.0.0.1:${port}/via-fetch`)).text();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      const clients = httpSpans.getFinishedSpans().filter((span) => span.kind === SpanKind.CLIENT);
      // Located by URL rather than position: finished-span order is not guaranteed, and other
      // client spans may exist alongside the one this test issued.
      const fetchSpan = clients.find((span) => String(span.attributes['url.full']).includes('/via-fetch'));
      expect(fetchSpan).toBeDefined();
      // The local listener served the call, but no server span exists for it: the platform's
      // gateway already records one per turn, and the listener would emit one per readiness probe.
      expect(httpSpans.getFinishedSpans().filter((span) => span.kind === SpanKind.SERVER)).toEqual([]);
    } finally {
      await handle.shutdown();
    }
  });

  it('disables the fetch instrumentation when another SDK owns the global tracer provider', async () => {
    // The setup warns that a lost global registration leaves this pipeline inert. The undici
    // subscription is bound to this pipeline's provider directly, so without an explicit disable
    // it would keep exporting HTTP client spans the warning just declared impossible — and
    // duplicate the embedder's own, if their SDK instruments fetch too.
    const embedders = new NodeTracerProvider();
    embedders.register();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ourSpans = new InMemorySpanExporter();
    const { setupHostObservability } = await freshSetup();
    const handle = await setupHostObservability({ spanProcessors: [new SimpleSpanProcessor(ourSpans)] });
    try {
      const { createServer } = await import('node:http');
      const server = createServer((_req, res) => res.end('ok'));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      try {
        await (await fetch(`http://127.0.0.1:${port}/inert`)).text();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      expect(ourSpans.getFinishedSpans()).toEqual([]);
    } finally {
      await handle.shutdown();
      await embedders.shutdown();
    }
  });

  it('is idempotent', async () => {
    const { setupHostObservability } = await freshSetup();
    const first = await setupHostObservability();
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
    const second = await setupHostObservability();

    expect(second).toBe(first);
    expect(second.exporters).toEqual([]);
  });

  it('is idempotent under concurrent calls, building the pipeline exactly once', async () => {
    // The `active` check and the assignment that answers it are separated by the OTLP exporter
    // resolution, which awaits: two calls that overlap there both read "not configured yet" and
    // both go on to build and register a full pipeline. The loser's provider, its
    // `BatchSpanProcessor` and its exporter are then live and unreachable — nothing can flush or
    // shut them down.
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
    const register = vi.spyOn(NodeTracerProvider.prototype, 'register');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { setupHostObservability, activeHostObservability } = await freshSetup();

    const [first, second, third] = await Promise.all([
      setupHostObservability(),
      setupHostObservability(),
      setupHostObservability(),
    ]);

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(activeHostObservability()).toBe(first);
    expect(first.exporters).toEqual(['otlp-http']);
    // One provider registered globally, and one pipeline announced: the exporters were constructed
    // and installed once, not once per caller.
    expect(register).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.filter((call) => String(call[0]).includes('exporting telemetry via'))).toHaveLength(
      1,
    );

    await first.shutdown();
  });

  it('lets the next caller retry after a failed setup instead of latching the failure', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
    vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'json');
    const { setupHostObservability, activeHostObservability } = await freshSetup();

    const results = await Promise.allSettled([setupHostObservability(), setupHostObservability()]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(activeHostObservability()).toBeUndefined();

    // The misconfiguration is the only reason it failed; fixing it must make the next call work.
    vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/protobuf');
    const handle = await setupHostObservability();
    expect(handle.exporters).toEqual(['otlp-http']);
    await handle.shutdown();
  });

  it('rejects setup after shutdown instead of returning a disconnected pipeline', async () => {
    const { setupHostObservability, activeHostObservability } = await freshSetup();
    const first = await setupHostObservability();
    await first.shutdown();
    expect(activeHostObservability()).toBeUndefined();

    await expect(setupHostObservability()).rejects.toThrow(
      'Host observability has been shut down and cannot be configured again in this process',
    );
    expect(activeHostObservability()).toBeUndefined();
  });

  it('pins the OTel premise that refusal rests on: a shut-down registration is still not replaceable', async () => {
    // Why `shutdown()` is process-terminal rather than "tear down, then allow a fresh setup".
    // `TracerProvider.shutdown()` shuts its span processors down and nothing else — it never calls
    // `trace.disable()` — so the API-level registration survives it, and `registerGlobal` refuses
    // the next one (`setGlobalTracerProvider` passes no `allowOverride`, and on `false` it does not
    // even reach `setDelegate`). A second pipeline would be live, holding exporters, and receive no
    // spans at all. The test above only fixes *that* we refuse; this fixes *why*, so the day
    // OpenTelemetry makes re-registration work, the refusal is flagged as having lost its reason.
    const first = new NodeTracerProvider();
    first.register();
    await first.shutdown();

    expect(trace.setGlobalTracerProvider(new NodeTracerProvider())).toBe(false);
  });

  it('warns instead of exporting nothing when another SDK already owns the global registration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // An embedding host that configured its own OTel SDK before starting the server. Our
    // registration is then refused, and the enrichment processor and every exporter below hang off
    // a provider that no `trace.getTracer` call will ever reach — silently, since `register()`
    // returns `void`.
    new NodeTracerProvider().register();
    const { setupHostObservability } = await freshSetup();

    const handle = await setupHostObservability();

    // Telemetry never fails the container: a warning, not a throw.
    expect(handle.exporters).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toContain('another OpenTelemetry SDK');
  });

  it('leaves the global registration alone when configuration fails, so a retry can still install one', async () => {
    // Global registration is the last step for a reason. Anything that threw *after* it would
    // leave the process registered to a pipeline no caller holds, and the retry the helper
    // promises (see the test above) would build a second provider that OTel silently refuses —
    // precisely the disconnected pipeline this ordering exists to prevent. Failing the metric provider is
    // how that ordering is observed: it is the last fallible construction step.
    vi.doMock('@opentelemetry/sdk-metrics', async () => {
      const actual = await vi.importActual<typeof SdkMetrics>('@opentelemetry/sdk-metrics');
      const failing = class {
        constructor() {
          throw new Error('meter provider construction failed');
        }
      } as unknown as typeof actual.MeterProvider;
      return { ...actual, MeterProvider: failing };
    });
    try {
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
      const { setupHostObservability, activeHostObservability } = await freshSetup();

      await expect(setupHostObservability()).rejects.toThrow('meter provider construction failed');
      expect(activeHostObservability()).toBeUndefined();

      // Nothing was registered globally, so the next pipeline is still the one the process gets.
      expect(trace.setGlobalTracerProvider(new NodeTracerProvider())).toBe(true);
    } finally {
      vi.doUnmock('@opentelemetry/sdk-metrics');
    }
  });

  it('warns that Agent365 tracing is not supported instead of failing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('FOUNDRY_HOSTING_ENVIRONMENT', 'production');
    vi.stubEnv('FOUNDRY_AGENT365_TRACING_ENABLED', 'true');
    const { setupHostObservability } = await freshSetup();
    const handle = await setupHostObservability();

    expect(handle.exporters).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toContain('Agent365');
  });

  it('names the service after the agent and stamps the Foundry identity on spans', async () => {
    vi.stubEnv('FOUNDRY_AGENT_NAME', 'weather-agent');
    vi.stubEnv('FOUNDRY_AGENT_VERSION', '7');
    vi.stubEnv('FOUNDRY_PROJECT_ARM_ID', '/subscriptions/s/projects/p');
    const exporter = new InMemorySpanExporter();
    const { setupHostObservability } = await freshSetup();
    await setupHostObservability({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

    trace.getTracer('probe').startSpan('probe').end();

    const [span] = exporter.getFinishedSpans();
    expect(span?.resource.attributes['service.name']).toBe('weather-agent');
    expect(span?.resource.attributes['service.version']).toBe('7');
    expect(span?.attributes[FOUNDRY_ATTR.projectId]).toBe('/subscriptions/s/projects/p');
    // No instance client id in the environment, so the id falls back to `{name}:{version}`.
    expect(span?.attributes[FOUNDRY_ATTR.agentId]).toBe('weather-agent:7');
  });
});

describe('server trace context', () => {
  afterEach(() => disableGlobalOtel());

  const TRACEPARENT = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';

  function register(exporter: InMemorySpanExporter): void {
    new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();
  }

  it('parents handler spans under the calling service and exposes request-id baggage', async () => {
    const exporter = new InMemorySpanExporter();
    register(exporter);
    let requestIdBaggage: string | undefined;
    const server = new ResponsesServer({
      handler: minimalHandler((stage) => {
        if (stage === 'start') {
          requestIdBaggage = propagation.getBaggage(contextApi.active())?.getEntry('x_request_id')?.value;
        }
        trace.getTracer('test-handler').startSpan(`${stage}-span`).end();
      }),
      store: new InMemoryResponseProvider(),
    });

    const response = await server.handle(
      post({ input: 'hi' }, { traceparent: TRACEPARENT, 'x-request-id': 'req-42' }),
    );

    expect(response.status).toBe(200);
    expect(requestIdBaggage).toBe('req-42');
    const spans = exporter.getFinishedSpans();
    const start = must(spans.find((span) => span.name === 'start-span'));
    expect(start.spanContext().traceId).toBe('0123456789abcdef0123456789abcdef');
    expect(start.parentSpanContext?.spanId).toBe('0123456789abcdef');
  });

  it('keeps late spans of a streamed turn in the caller trace', async () => {
    const exporter = new InMemorySpanExporter();
    register(exporter);
    const server = new ResponsesServer({
      handler: minimalHandler((stage) => {
        trace.getTracer('test-handler').startSpan(`${stage}-span`).end();
      }),
      store: new InMemoryResponseProvider(),
    });

    const response = await server.handle(post({ input: 'hi', stream: true }, { traceparent: TRACEPARENT }));
    await response.text(); // consume the SSE body, which is what pulls the late events

    // The `late-span` is created on a pull made by the SSE writer, outside the request scope —
    // the exact resumption `bindIterable` pins back to the extracted context.
    const late = must(exporter.getFinishedSpans().find((span) => span.name === 'late-span'));
    expect(late.spanContext().traceId).toBe('0123456789abcdef0123456789abcdef');
    expect(late.parentSpanContext?.spanId).toBe('0123456789abcdef');
  });

  it('prefers the active span for outbound platform headers over the inbound traceparent', async () => {
    const exporter = new InMemorySpanExporter();
    register(exporter);
    let captured: Record<string, string> = {};
    const server = new ResponsesServer({
      handler: minimalHandler((stage) => {
        if (stage !== 'start') return;
        const span = trace.getTracer('test-handler').startSpan('outbound-call');
        contextApi.with(trace.setSpan(contextApi.active(), span), () => {
          captured = platformHeaders();
        });
        span.end();
      }),
      store: new InMemoryResponseProvider(),
    });

    const res = await server.handle(
      post({ input: 'hi' }, { traceparent: TRACEPARENT, 'x-agent-foundry-call-id': 'call-1' }),
    );

    expect(res.status).toBe(200);
    expect(captured['x-agent-foundry-call-id']).toBe('call-1');
    // Same trace as the caller, but the span id is the handler's own — not the inbound one.
    expect(captured.traceparent).toMatch(/^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/);
    expect(captured.traceparent).not.toBe(TRACEPARENT);
  });

  it('carries the trace state with the injected traceparent', async () => {
    // `tracestate` is only meaningful next to the `traceparent` it belongs to (W3C trace-context
    // section 3.3): forwarding one without the other tells the next hop that the vendor state is gone.
    // The handler's own span inherits the caller's trace state, so the propagator emits it.
    const exporter = new InMemorySpanExporter();
    register(exporter);
    let captured: Record<string, string> = {};
    const server = new ResponsesServer({
      handler: minimalHandler((stage) => {
        if (stage !== 'start') return;
        const span = trace.getTracer('test-handler').startSpan('outbound-call');
        contextApi.with(trace.setSpan(contextApi.active(), span), () => {
          captured = platformHeaders();
        });
        span.end();
      }),
      store: new InMemoryResponseProvider(),
    });

    const res = await server.handle(
      post({ input: 'hi' }, { traceparent: TRACEPARENT, tracestate: 'vendor1=abc,vendor2=def' }),
    );

    expect(res.status).toBe(200);
    expect(captured.tracestate).toBe('vendor1=abc,vendor2=def');
  });
});

describe('per-turn flush', () => {
  afterEach(() => disableGlobalOtel());

  it('flushes after a non-streamed turn', async () => {
    const flusher = vi.fn(async () => {});
    setTelemetryFlusher(flusher);
    const server = new ResponsesServer({ handler: minimalHandler(), store: new InMemoryResponseProvider() });

    await server.handle(post({ input: 'hi' }));

    expect(flusher).toHaveBeenCalledTimes(1);
  });

  it('flushes when a streamed turn ends', async () => {
    const flusher = vi.fn(async () => {});
    setTelemetryFlusher(flusher);
    const server = new ResponsesServer({ handler: minimalHandler(), store: new InMemoryResponseProvider() });

    const response = await server.handle(post({ input: 'hi', stream: true }));
    expect(flusher).not.toHaveBeenCalled();
    await response.text();

    expect(flusher).toHaveBeenCalledTimes(1);
  });

  it('never lets a failing flusher fail the request', async () => {
    setTelemetryFlusher(async () => {
      throw new Error('collector is down');
    });
    const server = new ResponsesServer({ handler: minimalHandler(), store: new InMemoryResponseProvider() });

    const response = await server.handle(post({ input: 'hi' }));

    expect(response.status).toBe(200);
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });

  it('flushes a request refused before the handler ever runs', async () => {
    const flusher = vi.fn(async () => {});
    setTelemetryFlusher(flusher);
    const server = new ResponsesServer({ handler: minimalHandler(), store: new InMemoryResponseProvider() });

    // A validation refusal: `background` requires `store`, so this never reaches the handler.
    const rejected = await server.handle(post({ input: 'hi', background: true, store: false }));

    expect(rejected.status).toBe(400);
    expect(flusher).toHaveBeenCalledTimes(1);
  });

  it('flushes a routing refusal', async () => {
    const flusher = vi.fn(async () => {});
    setTelemetryFlusher(flusher);
    const server = new ResponsesServer({ handler: minimalHandler(), store: new InMemoryResponseProvider() });

    const missing = await server.handle(new Request('http://localhost:8088/nope'));

    expect(missing.status).toBe(404);
    expect(flusher).toHaveBeenCalledTimes(1);
  });

  it('flushes when the handler throws after emitting a span', async () => {
    const flusher = vi.fn(async () => {});
    setTelemetryFlusher(flusher);
    const exporter = new InMemorySpanExporter();
    new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();
    const server = new ResponsesServer({
      handler: async function* () {
        trace.getTracer('test-handler').startSpan('setup-span').end();
        throw new Error('the session is not authorized');
        // biome-ignore lint/correctness/noUnreachable: never runs; the yield only makes this function a generator
        yield { type: 'response.created' };
      },
      store: new InMemoryResponseProvider(),
    });

    const response = await server.handle(post({ input: 'hi' }));

    expect(response.status).toBe(500);
    // The span the failing turn produced is exactly the one worth exporting: a sandbox frozen on
    // the 500 would otherwise lose the only record of why the turn failed.
    expect(exporter.getFinishedSpans().map((span) => span.name)).toContain('setup-span');
    expect(flusher).toHaveBeenCalledTimes(1);
  });

  it('flushes when a stream fails before it is committed', async () => {
    const flusher = vi.fn(async () => {});
    setTelemetryFlusher(flusher);
    const server = new ResponsesServer({
      handler: async function* () {
        trace.getTracer('test-handler').startSpan('setup-span').end();
        throw new Error('the agent does not exist');
        // biome-ignore lint/correctness/noUnreachable: never runs; the yield only makes this function a generator
        yield { type: 'response.created' };
      },
      store: new InMemoryResponseProvider(),
    });

    // The failure lands before the 200 and the SSE headers, so there is no body whose `finally`
    // could flush — the request scope is the last chance.
    const response = await server.handle(post({ input: 'hi', stream: true }));

    expect(response.status).toBe(500);
    expect(flusher).toHaveBeenCalledTimes(1);
  });

  it('flushes when storing the finished turn answers with a protocol error', async () => {
    const flusher = vi.fn(async () => {});
    setTelemetryFlusher(flusher);
    const inner = new InMemoryResponseProvider();
    const store: ResponseProvider = {
      get: (id, owner) => inner.get(id, owner),
      async put() {
        throw new ProtocolError(404, 'response not found', { code: 'not_found', param: 'response_id' });
      },
      delete: (id, owner) => inner.delete(id, owner),
      history: (id, owner) => inner.history(id, owner),
    };
    const server = new ResponsesServer({ handler: minimalHandler(), store });

    // The handler ran to completion and only the persist refused, so the success path's flush is
    // never reached.
    const response = await server.handle(post({ input: 'hi' }));

    expect(response.status).toBe(404);
    expect(flusher).toHaveBeenCalledTimes(1);
  });

  it('leaves the flush to a background run rather than spending a second one', async () => {
    const flusher = vi.fn(async () => {});
    setTelemetryFlusher(flusher);
    const server = new ResponsesServer({ handler: minimalHandler(), store: new InMemoryResponseProvider() });

    const created = await server.handle(post({ input: 'hi', background: true }));
    expect(created.status).toBe(200);

    // The detached run owns the turn, and its own teardown is what flushes.
    for (let attempt = 0; attempt < 200 && flusher.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flusher).toHaveBeenCalledTimes(1);
  });
});

describe('server-stamped baggage', () => {
  afterEach(() => disableGlobalOtel());

  /** Registers a provider that both lifts baggage onto spans and records them. */
  function registerEnriched(exporter: InMemorySpanExporter): void {
    new NodeTracerProvider({
      spanProcessors: [new FoundryEnrichmentSpanProcessor({}), new SimpleSpanProcessor(exporter)],
    }).register();
  }

  /** The four create-time entries the reference stamps, read from the ambient context. */
  function stamped(): Record<string, string | undefined> {
    const bag = propagation.getBaggage(contextApi.active());
    return {
      responseId: bag?.getEntry(RESPONSE_BAGGAGE.responseId)?.value,
      conversationId: bag?.getEntry(RESPONSE_BAGGAGE.conversationId)?.value,
      streaming: bag?.getEntry(RESPONSE_BAGGAGE.streaming)?.value,
      requestId: bag?.getEntry(RESPONSE_BAGGAGE.requestId)?.value,
    };
  }

  it('stamps the turn itself, so a caller that sends no baggage still gets the conversation id', async () => {
    const exporter = new InMemorySpanExporter();
    registerEnriched(exporter);
    let captured: Record<string, string | undefined> = {};
    const server = new ResponsesServer({
      handler: minimalHandler((stage) => {
        if (stage === 'start') {
          captured = stamped();
        }
        trace.getTracer('test-handler').startSpan(`${stage}-span`).end();
      }),
      store: new InMemoryResponseProvider(),
    });

    // Deliberately no `baggage` header: the point is that the server does not depend on one.
    const response = await server.handle(
      post({ input: 'hi', conversation: 'conv_7' }, { 'x-request-id': 'req-9' }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ResponseObject;
    expect(captured.responseId).toBe(body.id);
    expect(captured.conversationId).toBe('conv_7');
    // `"True"` / `"False"`: both references stringify their language's boolean verbatim.
    expect(captured.streaming).toBe('False');
    expect(captured.requestId).toBe('req-9');

    // The lift in the enrichment processor is what the portal actually reads, and it is dead code
    // until the entry exists.
    const start = must(exporter.getFinishedSpans().find((span) => span.name === 'start-span'));
    expect(start.attributes[FOUNDRY_ATTR.conversationId]).toBe('conv_7');
  });

  it('carries the stamp into the late pulls of a streamed turn', async () => {
    const exporter = new InMemorySpanExporter();
    registerEnriched(exporter);
    const seen: Array<string | undefined> = [];
    const server = new ResponsesServer({
      handler: minimalHandler(() => {
        seen.push(stamped().streaming);
      }),
      store: new InMemoryResponseProvider(),
    });

    const response = await server.handle(post({ input: 'hi', stream: true }));
    await response.text();

    // The setup pull happens inside the request scope, the late one on the SSE writer's pull.
    expect(seen).toEqual(['True', 'True']);
  });

  it('sets the conversation entry empty — and leaves the span attribute off — with no conversation', async () => {
    const exporter = new InMemorySpanExporter();
    registerEnriched(exporter);
    let captured: Record<string, string | undefined> = {};
    const server = new ResponsesServer({
      handler: minimalHandler((stage) => {
        if (stage === 'start') {
          captured = stamped();
        }
        trace.getTracer('test-handler').startSpan(`${stage}-span`).end();
      }),
      store: new InMemoryResponseProvider(),
    });

    const response = await server.handle(post({ input: 'hi' }));

    expect(response.status).toBe(200);
    // The reference writes `conversation_id or ""` rather than omitting the entry…
    expect(captured.conversationId).toBe('');
    // …and its enrichment processor tests the value for truth, so an empty one stamps nothing.
    expect(captured.requestId).toBeUndefined();
    const start = must(exporter.getFinishedSpans().find((span) => span.name === 'start-span'));
    expect(start.attributes[FOUNDRY_ATTR.conversationId]).toBeUndefined();
  });

  it('adds to the caller baggage instead of replacing it', async () => {
    const exporter = new InMemorySpanExporter();
    registerEnriched(exporter);
    let captured: Record<string, string | undefined> = {};
    const server = new ResponsesServer({
      handler: minimalHandler((stage) => {
        if (stage === 'start') {
          captured = stamped();
        }
        trace.getTracer('test-handler').startSpan(`${stage}-span`).end();
      }),
      store: new InMemoryResponseProvider(),
    });

    const response = await server.handle(
      post({ input: 'hi', conversation: 'conv_9' }, { baggage: `${FOUNDRY_BAGGAGE.sessionId}=sess-1` }),
    );

    expect(response.status).toBe(200);
    expect(captured.conversationId).toBe('conv_9');
    const start = must(exporter.getFinishedSpans().find((span) => span.name === 'start-span'));
    expect(start.attributes[FOUNDRY_ATTR.sessionId]).toBe('sess-1');
    expect(start.attributes[FOUNDRY_ATTR.conversationId]).toBe('conv_9');
  });
});
