/**
 * The main-agent stamp: `microsoft.gen_ai.main_agent.*` propagated onto every span in a trace, so
 * downstream telemetry is attributed to the top-level (user-facing) agent rather than an internal
 * sub-agent. A port of the Microsoft OpenTelemetry distro's `GenAIMainAgentSpanProcessor`, which
 * the Python and .NET hosts inherit from that distro.
 *
 * These four keys are also the only `microsoft.*`-prefixed span attributes the Azure Monitor JS
 * exporter forwards — the rest of the prefix is dropped at export time — so they are what the
 * Foundry portal can actually read from a Node host.
 */

import type { Span as ApiSpan, AttributeValue, Context } from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { FOUNDRY_ATTR } from './enrichment.js';

const MAIN_AGENT_PREFIX = 'microsoft.gen_ai.main_agent.';

/**
 * Each row: the main-agent attribute to write, and the plain agent attribute it falls back to
 * when the parent (or, for self-promotion, the span itself) has not been stamped yet.
 */
const PROPAGATION: readonly (readonly [target: string, fallback: string])[] = [
  [`${MAIN_AGENT_PREFIX}name`, FOUNDRY_ATTR.agentName],
  [`${MAIN_AGENT_PREFIX}id`, FOUNDRY_ATTR.agentId],
  [`${MAIN_AGENT_PREFIX}version`, FOUNDRY_ATTR.agentVersion],
  [`${MAIN_AGENT_PREFIX}conversation_id`, FOUNDRY_ATTR.conversationId],
];

/** Project-scope keys, carried down so every span of a trace names the same project. */
const PROJECT_ID_KEYS: readonly string[] = ['gen_ai.azure_ai_project.id', FOUNDRY_ATTR.projectId];

/**
 * Reads a span's attributes when the implementation exposes them.
 *
 * The API's `Span` deliberately has no attribute accessor; the SDK's does. A remote parent — a
 * bare `SpanContext` wrapped by the propagator — yields nothing, and then no propagation happens,
 * exactly as in the reference processor.
 */
function attributesOf(span: ApiSpan): Record<string, unknown> {
  const attributes = (span as { attributes?: unknown }).attributes;
  return typeof attributes === 'object' && attributes !== null ? (attributes as Record<string, unknown>) : {};
}

export class GenAIMainAgentSpanProcessor implements SpanProcessor {
  /**
   * child span → parent span, so {@link onEnd} can retry the copy for children whose parent
   * attributes were not yet written when the child started. Weak keys also release an abandoned
   * child that is never ended, instead of retaining it for the lifetime of the process.
   */
  readonly #parents = new WeakMap<object, ApiSpan>();

  onStart(span: Span, parentContext: Context): void {
    const parent = trace.getSpan(parentContext);
    if (parent === undefined || !trace.isSpanContextValid(parent.spanContext())) {
      return;
    }
    this.#parents.set(span, parent);

    const parentAttributes = attributesOf(parent);
    for (const [target, fallback] of PROPAGATION) {
      const value = parentAttributes[target] ?? parentAttributes[fallback];
      if (value !== undefined) {
        span.setAttribute(target, value as AttributeValue);
      }
    }
    for (const key of PROJECT_ID_KEYS) {
      const value = parentAttributes[key];
      if (value !== undefined) {
        span.setAttribute(key, value as AttributeValue);
      }
    }
  }

  onEnd(span: ReadableSpan): void {
    const parent = this.#parents.get(span);
    this.#parents.delete(span);

    const attributes = span.attributes as Record<string, unknown>;
    const parentAttributes = parent === undefined ? {} : attributesOf(parent);
    const updates: Record<string, unknown> = {};

    if (!Object.keys(attributes).some((key) => key.startsWith(MAIN_AGENT_PREFIX))) {
      // Self-promotion: the top-level invoke_agent span names itself the main agent. Running
      // after the Foundry enrichment processor, the values it copies are the platform's deployed
      // identity, not whatever the in-process framework called the agent.
      if (attributes['gen_ai.operation.name'] === 'invoke_agent') {
        for (const [target, source] of PROPAGATION) {
          const value = attributes[source];
          if (value !== undefined) {
            updates[target] = value;
          }
        }
      }
      // Parent fallback, winning over self-promotion as in the reference: covers children whose
      // parent was stamped only after the child had already started.
      if (parent !== undefined) {
        for (const [target, fallback] of PROPAGATION) {
          const value = parentAttributes[target] ?? parentAttributes[fallback];
          if (value !== undefined) {
            updates[target] = value;
          }
        }
      }
    }

    if (parent !== undefined) {
      for (const key of PROJECT_ID_KEYS) {
        if (attributes[key] === undefined && parentAttributes[key] !== undefined) {
          updates[key] = parentAttributes[key];
        }
      }
    }

    // The SDK refuses setAttribute on an ended span, so this writes the attribute record
    // directly — the same workaround the enrichment processor uses.
    try {
      for (const [key, value] of Object.entries(updates)) {
        attributes[key] = value;
      }
    } catch {
      // A frozen attribute record loses the main-agent stamp on this span, nothing more.
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
