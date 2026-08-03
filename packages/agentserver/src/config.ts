/**
 * The container contract's environment variables.
 *
 * Read through functions rather than captured at import time, so a test — or a process that
 * configures itself before serving — sees the current value.
 */

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function intEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The port to listen on. `8088` unless `PORT` says otherwise. */
export function port(): number {
  return intEnv('PORT', 8088);
}

/**
 * Whether this process is running as a Foundry Hosted Agent.
 *
 * Any non-empty `FOUNDRY_HOSTING_ENVIRONMENT` means hosted. This is what switches on the strict
 * behaviours: the protocol-version fail-close, Foundry storage, and managed-identity auth.
 */
export function isHosted(): boolean {
  return env('FOUNDRY_HOSTING_ENVIRONMENT') !== undefined;
}

/** The project endpoint storage, toolboxes and models hang off. */
export function projectEndpoint(): string | undefined {
  return env('FOUNDRY_PROJECT_ENDPOINT');
}

/** The agent's registered name. */
export function agentName(): string | undefined {
  return env('FOUNDRY_AGENT_NAME');
}

/** The agent's version. */
export function agentVersion(): string | undefined {
  return env('FOUNDRY_AGENT_VERSION');
}

/**
 * The container sandbox's session id.
 *
 * Constant for the container's lifetime and shared across conversations *and users*, so it is
 * never a key for per-conversation state.
 */
export function agentSessionId(): string | undefined {
  return env('FOUNDRY_AGENT_SESSION_ID');
}

/** Seconds between SSE keep-alive comments. `0` disables them. */
export function sseKeepAliveSeconds(): number {
  return intEnv('SSE_KEEPALIVE_INTERVAL', 0);
}

/**
 * The largest `POST /responses` body this server reads, in bytes.
 *
 * `AGENTSERVER_MAX_BODY_BYTES`, defaulting to 10 MiB. The Foundry gateway bounds hosted traffic
 * anyway; this is what keeps a directly-exposed local server from buffering an arbitrarily large
 * body into memory.
 */
export function maxBodyBytes(): number {
  return intEnv('AGENTSERVER_MAX_BODY_BYTES', 10 * 1024 * 1024);
}

/** The most items an `input` array may carry. `AGENTSERVER_MAX_INPUT_ITEMS`, defaulting to 1000. */
export function maxInputItems(): number {
  return intEnv('AGENTSERVER_MAX_INPUT_ITEMS', 1000);
}

/**
 * The most events one background stream retains for replay. `AGENTSERVER_MAX_STREAM_EVENTS`,
 * defaulting to 10 000.
 *
 * The same kind of safety valve as the in-memory store's response cap: a
 * background run buffers its events for `GET ?stream=true` reconnects, and without a bound one
 * chatty handler holds the container's memory hostage. A run that crosses it keeps running and
 * still persists its terminal state — only the replay log is dropped, and later replays answer
 * the same 400 an expired stream gets.
 */
export function maxStreamEvents(): number {
  return intEnv('AGENTSERVER_MAX_STREAM_EVENTS', 10_000);
}

/**
 * How long `POST /responses/{id}/cancel` waits for a signalled run to wind down before
 * cancellation wins regardless. `AGENTSERVER_CANCEL_GRACE_MS`, defaulting to 10 000 — the
 * reference's fixed grace (Python `handle_cancel`: `asyncio.wait_for(..., timeout=10.0)`).
 *
 * Configurable here only because the reference's constant makes the past-grace branch — the one
 * where the handler ignores the signal and keeps running — untestable in a unit test that has to
 * finish in less than ten seconds. The default is the reference's value.
 */
export function cancelGraceMs(): number {
  return intEnv('AGENTSERVER_CANCEL_GRACE_MS', 10_000);
}

/** How long to drain in-flight responses after SIGTERM. */
export function gracefulShutdownSeconds(): number {
  return intEnv('AGENTSERVER_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS', 30);
}

/** Root for local persistence when the platform's storage is not available. */
export function stateRoot(): string {
  return (
    env('AGENTSERVER_STATE_ROOT') ?? `${process.env.HOME ?? process.env.USERPROFILE ?? '.'}/.agentserver`
  );
}

/** This package's version. Keep in sync with `version` in package.json — a unit test enforces it. */
export const PACKAGE_VERSION = '0.1.0';

/** The `x-platform-server` value: which SDK, which protocol, which runtime. */
export function serverIdentity(): string {
  return `agent-framework-js/${PACKAGE_VERSION} protocol/responses-2.0.0 node/${process.versions.node}`;
}

// --- Telemetry (consumed by ./observability) ---

/** Application Insights connection string, injected by the platform at deploy time. */
export function appInsightsConnectionString(): string | undefined {
  return env('APPLICATIONINSIGHTS_CONNECTION_STRING');
}

/** Whether Azure Monitor export should authenticate with the managed identity. */
export function isAppInsightsEntraAuth(): boolean {
  return (env('APPLICATIONINSIGHTS_AUTH_MODE') ?? '').trim().toLowerCase() === 'entra';
}

/**
 * The agent identity reported as `gen_ai.agent.id` on every span.
 *
 * Resolution order is the reference's (`resolve_agent_id`): the instance's managed-identity
 * client id, then `{name}:{version}`, then the bare name.
 */
export function resolveAgentId(): string | undefined {
  const clientId = env('FOUNDRY_AGENT_INSTANCE_CLIENT_ID');
  if (clientId !== undefined) {
    return clientId;
  }
  const name = agentName();
  if (name === undefined) {
    return undefined;
  }
  const version = agentVersion();
  return version === undefined ? name : `${name}:${version}`;
}

/**
 * The Foundry project's ARM resource id, reported as `microsoft.foundry.project.id`.
 *
 * The portal queries spans by this id, so without it traces exist but the project's
 * observability page cannot find them.
 */
export function projectArmId(): string | undefined {
  return env('FOUNDRY_PROJECT_ARM_ID');
}

/** The agent blueprint's client id, reported as `microsoft.a365.agent.blueprint.id`. */
export function blueprintClientId(): string | undefined {
  return env('FOUNDRY_AGENT_BLUEPRINT_CLIENT_ID');
}

/** The agent's tenant, reported as `microsoft.tenant.id`. */
export function agentTenantId(): string | undefined {
  return env('FOUNDRY_AGENT_TENANT_ID');
}

/** Whether any OTLP endpoint is configured — the switch for OTLP export. */
export function isOtlpEnabled(): boolean {
  return (
    env('OTEL_EXPORTER_OTLP_ENDPOINT') !== undefined ||
    env('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') !== undefined ||
    env('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT') !== undefined ||
    env('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT') !== undefined
  );
}

/**
 * A telemetry *misconfiguration* — as opposed to a telemetry outage.
 *
 * `serve` swallows setup failures (a dead collector must not keep the container from serving)
 * but re-throws this one: the reference host draws the same line, letting its `ValueError` for
 * an unsupported OTLP protocol fail startup while everything else is a warning. A typo that
 * silently exported nothing would be exactly the failure mode this layer exists to fix.
 */
export class UnsupportedOtlpProtocolError extends Error {
  constructor(raw: string) {
    super(`Unsupported OTLP protocol '${raw}'. Use 'http/protobuf' or 'grpc'.`);
    this.name = 'UnsupportedOtlpProtocolError';
  }
}

/**
 * The OTLP protocol for one signal: per-signal variable, then the shared one, then
 * `http/protobuf` (the reference's default — note agent_framework Python defaults to `grpc`;
 * the agentserver layer is the one this package mirrors).
 *
 * `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL` is **not** in the parameter type, and its absence is the
 * point. The reference resolves all three protocols in one place
 * (`core/_tracing.py:336-338`) because it builds all three pipelines; it validates the logs
 * protocol as a side effect of needing its value. This package has no log pipeline at all
 * (a deliberate deviation — core emits messages as span events), so there is no logs
 * exporter whose protocol could be read, and no signal a typo there could silently disable.
 * Failing startup over a variable that governs nothing this process does would be fail-fast
 * pointed at the wrong thing. When the log pipeline lands, add the name to this union — that is
 * the whole change, and it is why the union is spelled out rather than typed `string`.
 *
 * @throws {UnsupportedOtlpProtocolError} When the value is neither `http/protobuf` nor `grpc`,
 * like the reference.
 */
export function otlpProtocol(
  signalEnv: 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL' | 'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
): 'http/protobuf' | 'grpc' {
  const raw = env(signalEnv) ?? env('OTEL_EXPORTER_OTLP_PROTOCOL') ?? 'http/protobuf';
  const normalized = raw.trim().toLowerCase();
  if (normalized !== 'http/protobuf' && normalized !== 'grpc') {
    throw new UnsupportedOtlpProtocolError(raw);
  }
  return normalized;
}

/** Whether Agent365 tracing was requested — hosted only, and not yet supported here. */
export function isAgent365TracingRequested(): boolean {
  const flag = (env('FOUNDRY_AGENT365_TRACING_ENABLED') ?? '').trim().toLowerCase();
  return isHosted() && (flag === 'true' || flag === '1');
}
