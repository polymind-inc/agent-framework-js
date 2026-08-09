/**
 * `@polymind-inc/agent-framework-agentserver/observability` — the OTel SDK wiring for hosted operation.
 *
 * `serve` (`./node`) runs {@link setupHostObservability} automatically; this subpath exists for
 * processes that host the fetch handler some other way, and for tests. The protocol package
 * itself (`.`) touches only `@opentelemetry/api`.
 */

export type { FoundryIdentity } from './observability/enrichment.js';
export { FOUNDRY_ATTR, FOUNDRY_BAGGAGE, FoundryEnrichmentSpanProcessor } from './observability/enrichment.js';
export { flushTelemetry, setTelemetryFlusher } from './observability/flush.js';
export { GenAIMainAgentSpanProcessor } from './observability/main-agent.js';
export type { HostExporter, HostObservability, HostObservabilityOptions } from './observability/setup.js';
export { activeHostObservability, setupHostObservability } from './observability/setup.js';
export { extractTraceContext } from './observability/trace-context.js';
// The baggage self-stamping internals (RESPONSE_BAGGAGE / withResponseBaggage / bindIterable)
// belong to the server's create path and are not exported.
