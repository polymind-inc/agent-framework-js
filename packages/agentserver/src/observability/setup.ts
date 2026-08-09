/**
 * Host observability setup — the OTel SDK wiring a hosted container needs at startup.
 *
 * The reference implementations do this unconditionally in their hosting layer (.NET
 * `AgentHostBuilder.Build()` → `AddAgentHostTelemetry()`, Python `AgentServerHost.__init__` →
 * `configure_observability()`), and the exporters are chosen by environment:
 *
 * - `APPLICATIONINSIGHTS_CONNECTION_STRING` → Azure Monitor (what a Foundry deployment injects);
 *   `APPLICATIONINSIGHTS_AUTH_MODE=entra` authenticates it with the managed identity.
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` (or a per-signal endpoint) → OTLP. The protocol defaults to
 *   `http/protobuf`; `grpc` needs the optional `@opentelemetry/exporter-*-otlp-grpc` packages,
 *   mirroring the reference's `[otlp-grpc]` extra.
 *
 * With neither set, providers and the enrichment processor are still registered — spans exist
 * and propagation works, nothing is exported — so a container without telemetry env vars runs
 * exactly as before, just like the reference.
 */

import { ManagedIdentityCredential } from '@azure/identity';
import { AzureMonitorMetricExporter, AzureMonitorTraceExporter } from '@azure/monitor-opentelemetry-exporter';
import type { TracerProvider } from '@opentelemetry/api';
import { metrics, trace } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import type { SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  agentName,
  agentTenantId,
  agentVersion,
  appInsightsConnectionString,
  blueprintClientId,
  isAgent365TracingRequested,
  isAppInsightsEntraAuth,
  isOtlpEnabled,
  otlpProtocol,
  projectArmId,
  resolveAgentId,
} from '../config.js';
import { raceTimeout } from '../wait.js';
import { FoundryEnrichmentSpanProcessor } from './enrichment.js';
import { setTelemetryFlusher } from './flush.js';

/** `service.name` when the container contract did not name the agent (the reference's value). */
const DEFAULT_SERVICE_NAME = 'azure.ai.agentserver';

/**
 * The metric export interval, matching the reference framework's
 * (`PeriodicExportingMetricReader(export_interval_millis=5000)`).
 */
const METRIC_EXPORT_INTERVAL_MS = 5000;

/** The per-turn flush bound, matching the reference's `flush_spans(timeout_millis=5000)`. */
const FLUSH_TIMEOUT_MS = 5000;

/** Which export paths ended up active. */
export type HostExporter = 'azure-monitor' | 'otlp-http' | 'otlp-grpc';

/** Construction options for {@link setupHostObservability}. */
export interface HostObservabilityOptions {
  /**
   * Application Insights connection string. Overrides
   * `APPLICATIONINSIGHTS_CONNECTION_STRING` (the reference host constructor takes the same
   * parameter with the same precedence).
   */
  connectionString?: string;
  /** Extra span processors, registered before the exporters'. */
  spanProcessors?: SpanProcessor[];
}

/** The configured pipeline. */
export interface HostObservability {
  /** The export paths that are live. Empty means spans exist but leave nowhere. */
  readonly exporters: readonly HostExporter[];
  /** Pushes everything buffered out now. What the server calls at the end of every turn. */
  flush(): Promise<void>;
  /** Flushes, then tears the providers down. */
  shutdown(): Promise<void>;
}

let active: HostObservability | undefined;
/** OTel's process-global providers were shut down and cannot be safely replaced in this process. */
let stopped = false;
/**
 * The configuration currently under way, so overlapping callers join it instead of building a
 * second pipeline. Cleared the moment it settles, either way.
 */
let inFlight: Promise<HostObservability> | undefined;

/** The pipeline configured by {@link setupHostObservability}, if it ran and is still installed. */
export function activeHostObservability(): HostObservability | undefined {
  return active;
}

/**
 * Whether `provider` is the one the process's tracer API actually delegates to — or `undefined`
 * when that cannot be established.
 *
 * OTel's global registration is first-write-wins: `trace.setGlobalTracerProvider` returns `false`
 * when an SDK is already registered, and then leaves the existing delegate in place. But
 * `NodeTracerProvider.register()` returns `void` (measured against `@opentelemetry/sdk-trace-node`
 * 2.x, which calls `trace.setGlobalTracerProvider(this)` and drops the answer), so a host that
 * registered its own SDK first would leave this one holding the enrichment processor and every
 * exporter while receiving nothing — silently. Asking the API afterwards is the way to tell:
 * `trace.getTracerProvider()` hands back the API's own `ProxyTracerProvider`, whose delegate is
 * whichever SDK won.
 *
 * Duck-typed rather than `instanceof`, because an embedder may hold its own copy of
 * `@opentelemetry/api`. When the shape is unfamiliar the answer is `undefined` and the caller stays
 * quiet: a warning that fires on a guess is worse than no warning.
 */
function isGlobalTracerProvider(provider: TracerProvider): boolean | undefined {
  const global = trace.getTracerProvider() as { getDelegate?: () => TracerProvider };
  return typeof global.getDelegate === 'function' ? global.getDelegate() === provider : undefined;
}

async function otlpTraceExporter(
  warn: (message: string) => void,
): Promise<{ exporter: SpanExporter; kind: HostExporter } | undefined> {
  if (otlpProtocol('OTEL_EXPORTER_OTLP_TRACES_PROTOCOL') === 'grpc') {
    try {
      const grpc = await import('@opentelemetry/exporter-trace-otlp-grpc');
      return { exporter: new grpc.OTLPTraceExporter(), kind: 'otlp-grpc' };
    } catch {
      warn(
        'OTLP/gRPC trace export was requested, but @opentelemetry/exporter-trace-otlp-grpc is not installed. Install it to enable OTLP/gRPC export.',
      );
      return undefined;
    }
  }
  return { exporter: new OTLPTraceExporter(), kind: 'otlp-http' };
}

async function otlpMetricExporter(
  warn: (message: string) => void,
): Promise<{ exporter: PushMetricExporter; kind: HostExporter } | undefined> {
  if (otlpProtocol('OTEL_EXPORTER_OTLP_METRICS_PROTOCOL') === 'grpc') {
    try {
      const grpc = await import('@opentelemetry/exporter-metrics-otlp-grpc');
      return { exporter: new grpc.OTLPMetricExporter(), kind: 'otlp-grpc' };
    } catch {
      warn(
        'OTLP/gRPC metric export was requested, but @opentelemetry/exporter-metrics-otlp-grpc is not installed. Install it to enable OTLP/gRPC export.',
      );
      return undefined;
    }
  }
  return { exporter: new OTLPMetricExporter(), kind: 'otlp-http' };
}

/**
 * Configures the process's OTel pipeline for hosted operation.
 *
 * **Idempotent, concurrently too.** The second and later calls return the first pipeline
 * untouched, and calls that *overlap* — `serve` racing an explicit setup, two hosts started
 * together — all receive the same {@link HostObservability}. The in-flight promise is stored
 * before the first `await`, which is what makes that true: this function suspends inside the OTLP
 * exporter resolution, and a check against `active` alone would let every overlapping caller past
 * it. Each would then build and globally register its own provider, span processors and exporters,
 * and every one but the last would be live, exporting, and unreachable — nothing left holding it
 * could flush or shut it down.
 *
 * A **failed** setup is not remembered: the in-flight state is released, `activeHostObservability()`
 * stays `undefined`, and the next call configures from scratch. (The failure that actually happens
 * is a misconfigured `OTEL_EXPORTER_OTLP_PROTOCOL`, which is fixable without restarting the
 * process.) Concurrent callers of a failing setup all see the same rejection. Retrying is only safe
 * because global registration is the *last* step of the configuration — see the end of
 * {@link configureHostObservability} — so a failure never leaves a registered provider behind for
 * the retry to collide with.
 *
 * {@link HostObservability.shutdown} is process-terminal for this setup helper. OpenTelemetry's
 * global provider registration is one-shot: registering a second SDK does not replace the first,
 * so returning a new handle would create a pipeline that receives no spans. A later setup call is
 * rejected explicitly; restart the host process to install a fresh pipeline.
 *
 * `serve` (in `./node`) calls this automatically; call it directly only when hosting the fetch
 * handler some other way.
 *
 * Deliberately not implemented: the log pipeline, and
 * Agent365 export (`FOUNDRY_AGENT365_TRACING_ENABLED` — owned by the Microsoft OTel distro in
 * both reference languages, which has no JS counterpart; requesting it logs a warning).
 */
export function setupHostObservability(options: HostObservabilityOptions = {}): Promise<HostObservability> {
  if (active !== undefined) {
    return Promise.resolve(active);
  }
  if (inFlight !== undefined) {
    return inFlight;
  }
  if (stopped) {
    return Promise.reject(
      new Error(
        'Host observability has been shut down and cannot be configured again in this process. Restart the host to install a new pipeline.',
      ),
    );
  }
  // Assigned in the same synchronous step as the two checks above — before `configure` reaches its
  // first `await` — so there is no point at which a second caller sees "nobody is configuring".
  const pending = configureHostObservability(options).then(
    (handle) => {
      inFlight = undefined;
      active = handle;
      return handle;
    },
    (error: unknown) => {
      inFlight = undefined;
      throw error;
    },
  );
  inFlight = pending;
  return pending;
}

/** Builds and registers one pipeline. Called once per successful {@link setupHostObservability}. */
async function configureHostObservability(options: HostObservabilityOptions): Promise<HostObservability> {
  const warn = (message: string): void => console.warn(`[agentserver observability] ${message}`);

  const name = agentName();
  const version = agentVersion();
  // `service.name` is what App Insights shows as the cloud role name.
  const resource = defaultResource().merge(
    resourceFromAttributes({
      'service.name': name ?? DEFAULT_SERVICE_NAME,
      ...(version === undefined ? {} : { 'service.version': version }),
    }),
  );

  const enrichment = new FoundryEnrichmentSpanProcessor({
    agentName: name,
    agentVersion: version,
    agentId: resolveAgentId(),
    projectId: projectArmId(),
    blueprintId: blueprintClientId(),
    tenantId: agentTenantId(),
  });

  const spanProcessors: SpanProcessor[] = [enrichment, ...(options.spanProcessors ?? [])];
  const metricExporters: PushMetricExporter[] = [];
  const exporters: HostExporter[] = [];

  const connectionString = options.connectionString ?? appInsightsConnectionString();
  if (connectionString !== undefined && connectionString !== '') {
    let credential: ManagedIdentityCredential | undefined;
    if (isAppInsightsEntraAuth()) {
      try {
        // System-assigned, as the reference: the instance client id is for outbound Foundry
        // calls, not for the telemetry sink.
        credential = new ManagedIdentityCredential();
      } catch (error) {
        warn(
          `failed to create the managed identity credential; falling back to connection-string auth: ${String(error)}`,
        );
      }
    }
    const azureOptions = { connectionString, ...(credential === undefined ? {} : { credential }) };
    spanProcessors.push(new BatchSpanProcessor(new AzureMonitorTraceExporter(azureOptions)));
    metricExporters.push(new AzureMonitorMetricExporter(azureOptions));
    exporters.push('azure-monitor');
  }

  if (isOtlpEnabled()) {
    // The OTLP exporters read their own endpoint / headers env vars; only the protocol needs
    // resolving here (per-signal, then shared, then http/protobuf — the reference's order).
    const traceExport = await otlpTraceExporter(warn);
    if (traceExport !== undefined) {
      spanProcessors.push(new BatchSpanProcessor(traceExport.exporter));
      if (!exporters.includes(traceExport.kind)) {
        exporters.push(traceExport.kind);
      }
    }
    const metricExport = await otlpMetricExporter(warn);
    if (metricExport !== undefined) {
      metricExporters.push(metricExport.exporter);
      if (!exporters.includes(metricExport.kind)) {
        exporters.push(metricExport.kind);
      }
    }
  }

  if (isAgent365TracingRequested()) {
    warn(
      'FOUNDRY_AGENT365_TRACING_ENABLED is set, but Agent365 trace export is not supported by this SDK yet.',
    );
  }

  const tracerProvider = new NodeTracerProvider({ resource, spanProcessors });

  let meterProvider: MeterProvider | undefined;
  if (metricExporters.length > 0) {
    meterProvider = new MeterProvider({
      resource,
      readers: metricExporters.map(
        (exporter) =>
          new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS }),
      ),
    });
  }

  // Outbound HTTP visibility, matching what the reference hosts inherit from their OTel distros:
  // the model and storage calls appear as client spans nested under the framework's spans.
  //
  // Undici only, deliberately. Its instrumentation rides `diagnostics_channel`, so it works in
  // the ESM bundle a hosted container actually runs. `@opentelemetry/instrumentation-http` would
  // not: it patches the `node:http` module through the CommonJS require path, which an ESM import
  // never crosses, leaving classic-stack clients (for example the managed-identity token calls)
  // uninstrumented either way. Server-side request spans are also out: the platform's gateway
  // already records one per turn, and the listener would emit one for every readiness probe.
  //
  // Wired through the instance API — not `registerInstrumentations`, which would drag in a
  // second copy of the instrumentation base package (undici pins its own) plus the
  // module-patching machinery a channel-based instrumentation never touches. Constructed with
  // the default config on purpose: the class gates span creation on `getConfig().enabled` at
  // event time, so `{ enabled: false }` + `enable()` subscribes but then discards every request
  // (measured). The constructor subscribes immediately; the provider attaches on the next line,
  // before anything can fetch.
  //
  // Only the tracer is bound to this pipeline — and the global-registration check below revokes
  // even that if another SDK holds the global slot. Metrics stay on the global meter API, so
  // they land in whichever meter provider actually owns the process.
  const undiciInstrumentation = new UndiciInstrumentation();
  undiciInstrumentation.setTracerProvider(tracerProvider);

  const flush = async (): Promise<void> => {
    // Metrics too — the reference flushes only spans, but a frozen sandbox that never reaches
    // the periodic reader would otherwise lose every histogram. Bounded
    // the way the reference bounds `flush_spans(timeout_millis=5000)`: `forceFlush` alone waits
    // out the exporter's own timeout (30 s), and this runs on the request path — an unreachable
    // collector must cost a turn five seconds at most, not thirty.
    await raceTimeout(
      Promise.all([tracerProvider.forceFlush(), meterProvider?.forceFlush()]),
      FLUSH_TIMEOUT_MS,
    );
  };
  setTelemetryFlusher(flush);

  let shutdownPromise: Promise<void> | undefined;
  const handle: HostObservability = {
    exporters,
    flush,
    shutdown(): Promise<void> {
      shutdownPromise ??= (() => {
        // Marked terminal and detached before the first await. A setup racing shutdown therefore
        // gets a deterministic refusal instead of a second, disconnected global provider.
        stopped = true;
        if (active === handle) {
          active = undefined;
        }
        setTelemetryFlusher(undefined);
        undiciInstrumentation.disable();
        return Promise.all([tracerProvider.shutdown(), meterProvider?.shutdown()]).then(() => undefined);
      })();
      return shutdownPromise;
    },
  };

  // Global registration is the **last** step, and everything above it is construction only.
  //
  // It is the one action here that cannot be taken back: OTel installs a global provider once per
  // process, and `shutdown()` does not release the slot. A failure *after*
  // this point would therefore leave the process registered to a pipeline no caller holds, and the
  // retry `setupHostObservability` promises after a failure would build a second provider that
  // OTel silently refuses to install — exactly the disconnected pipeline this ordering exists to prevent. With
  // nothing fallible left below, that path does not exist rather than merely being unlikely.
  //
  // `register()` also installs the AsyncLocalStorage context manager and the default W3C
  // trace-context + baggage propagator, which is what makes the server's inbound extraction and
  // the enrichment processor's baggage lifts real.
  tracerProvider.register();
  // A telemetry problem must never take the container down, so a lost
  // registration is reported, not thrown. `undefined` means "cannot tell" and says nothing.
  if (isGlobalTracerProvider(tracerProvider) === false) {
    // The fetch instrumentation is bound to this pipeline's provider directly, so it would keep
    // exporting HTTP client spans the warning below declares impossible — duplicated ones, if
    // the SDK that won the slot instruments fetch itself. Disabled, so "inert" stays true.
    undiciInstrumentation.disable();
    warn(
      'another OpenTelemetry SDK already registered the global tracer provider, so this pipeline will receive no spans: the Foundry enrichment processor and the exporters configured above are inert, and the fetch instrumentation has been disabled. Configure host observability before registering your own SDK.',
    );
  }
  if (meterProvider !== undefined && !metrics.setGlobalMeterProvider(meterProvider)) {
    warn(
      'another OpenTelemetry SDK already registered the global meter provider, so this pipeline will receive no metrics.',
    );
  }

  if (exporters.length > 0) {
    console.log(`[agentserver observability] exporting telemetry via: ${exporters.join(', ')}`);
  }
  return handle;
}
