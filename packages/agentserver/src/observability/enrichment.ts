/**
 * The Foundry identity stamp, applied to every span this process exports.
 *
 * A port of the reference's enrichment processor (.NET `FoundryEnrichmentProcessor`, Python
 * `_FoundryEnrichmentSpanProcessor`): the portal joins traces to a project and an agent through
 * these attributes, so they go on **all** spans — the framework's, and anything else a handler's
 * libraries emit.
 */

import type { Context } from '@opentelemetry/api';
import { context as contextApi, propagation } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

/** Span attribute keys the Foundry portal reads (reference `_tracing.py` / `FoundryEnrichmentProcessor`). */
export const FOUNDRY_ATTR = {
  projectId: 'microsoft.foundry.project.id',
  sessionId: 'microsoft.session.id',
  conversationId: 'gen_ai.conversation.id',
  invocationId: 'azure.ai.agentserver.invocations.invocation_id',
  agentName: 'gen_ai.agent.name',
  agentVersion: 'gen_ai.agent.version',
  agentId: 'gen_ai.agent.id',
  blueprintId: 'microsoft.a365.agent.blueprint.id',
  tenantId: 'microsoft.tenant.id',
} as const;

/**
 * Baggage keys lifted onto spans by the enrichment processor.
 *
 * The calling service may send any of them; `conversationId` is additionally stamped by this
 * server on every create (`RESPONSE_BAGGAGE` in `./trace-context`), so the lift does not depend
 * on the caller speaking W3C baggage.
 */
export const FOUNDRY_BAGGAGE = {
  sessionId: 'azure.ai.agentserver.session_id',
  conversationId: 'azure.ai.agentserver.conversation_id',
  invocationId: 'azure.ai.agentserver.invocation_id',
} as const;

/** The identity one deployment reports. Resolved from the container contract's env vars. */
export interface FoundryIdentity {
  agentName?: string | undefined;
  agentVersion?: string | undefined;
  agentId?: string | undefined;
  projectId?: string | undefined;
  blueprintId?: string | undefined;
  tenantId?: string | undefined;
}

export class FoundryEnrichmentSpanProcessor implements SpanProcessor {
  readonly #identity: FoundryIdentity;

  constructor(identity: FoundryIdentity) {
    this.#identity = identity;
  }

  onStart(span: Span, parentContext: Context): void {
    if (this.#identity.projectId !== undefined) {
      span.setAttribute(FOUNDRY_ATTR.projectId, this.#identity.projectId);
    }
    // Session / conversation ids ride in as baggage; stamping them at start means child spans
    // created by any library inherit them (the reference stamps the same three).
    const bag = propagation.getBaggage(parentContext ?? contextApi.active());
    if (bag === undefined) {
      return;
    }
    // Empty is absent, not a value to stamp: the reference tests each entry for truth
    // (`if conversation_id:`), and the create route sets `conversation_id` to `""` when the turn
    // names no conversation. An empty `gen_ai.conversation.id` would read as a real one.
    const sessionId = bag.getEntry(FOUNDRY_BAGGAGE.sessionId)?.value;
    if (sessionId !== undefined && sessionId !== '') {
      span.setAttribute(FOUNDRY_ATTR.sessionId, sessionId);
    }
    const conversationId = bag.getEntry(FOUNDRY_BAGGAGE.conversationId)?.value;
    if (conversationId !== undefined && conversationId !== '') {
      span.setAttribute(FOUNDRY_ATTR.conversationId, conversationId);
    }
    const invocationId = bag.getEntry(FOUNDRY_BAGGAGE.invocationId)?.value;
    if (invocationId !== undefined && invocationId !== '') {
      span.setAttribute(FOUNDRY_ATTR.invocationId, invocationId);
    }
  }

  onEnd(span: ReadableSpan): void {
    // Written at end so the platform's identity *wins* over anything a framework wrote mid-span
    // (the reference does the same, for the same reason). The SDK refuses setAttribute on an
    // ended span, so this writes the attribute record directly — Python pokes `_attributes` for
    // the identical workaround.
    try {
      const attributes = span.attributes as Record<string, unknown>;
      if (this.#identity.agentName !== undefined) {
        attributes[FOUNDRY_ATTR.agentName] = this.#identity.agentName;
      }
      if (this.#identity.agentVersion !== undefined) {
        attributes[FOUNDRY_ATTR.agentVersion] = this.#identity.agentVersion;
      }
      if (this.#identity.agentId !== undefined) {
        attributes[FOUNDRY_ATTR.agentId] = this.#identity.agentId;
      }
      if (this.#identity.blueprintId !== undefined) {
        attributes[FOUNDRY_ATTR.blueprintId] = this.#identity.blueprintId;
      }
      if (this.#identity.tenantId !== undefined) {
        attributes[FOUNDRY_ATTR.tenantId] = this.#identity.tenantId;
      }
    } catch {
      // A frozen attribute record loses the identity stamp on this span, nothing more.
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
