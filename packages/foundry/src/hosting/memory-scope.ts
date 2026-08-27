/**
 * Memory scopes derived from the hosted turn's identity.
 *
 * The memory provider takes its scope as a value or a function; this is the function a hosted
 * agent wants. It lives here, not beside the provider, because it reads the ambient hosted context
 * — which only exists inside a hosting handler.
 */

import { ConfigurationError } from '@polymind-inc/agent-framework-core';
import { getHostedAgentContext } from './hosted-context.js';

/**
 * Scopes memories to the end user of the hosted turn.
 *
 * ```ts
 * new FoundryMemoryProvider({ project, memoryStoreName: 'assistant-memories', scope: hostedUserScope() });
 * ```
 *
 * Throws outside a hosted turn, and when the platform supplied no user id, rather than falling
 * back to a shared partition: a fallback here would quietly merge every user's memories into one
 * scope, and that is a failure nobody notices until the memories of one user surface in another's
 * conversation. Outside a hosted container, pass a scope of your own.
 *
 * There is no tenant equivalent. The platform injects exactly one identity per request — the end
 * user — and a hosted container is deployed per agent inside one tenant, so the tenant boundary is
 * the container's, not a partition inside the store.
 */
export function hostedUserScope(): () => string {
  return () => {
    const context = getHostedAgentContext();
    if (context === undefined) {
      throw new ConfigurationError(
        'hostedUserScope() was called outside a hosted turn. It reads the identity the Foundry ' +
          'hosting layer installs per request; outside a hosted container, pass an explicit scope.',
      );
    }
    const userId = context.userId;
    if (userId === undefined || userId.trim() === '') {
      throw new ConfigurationError(
        'The hosted turn carries no end-user id, so memories cannot be scoped to a user.',
      );
    }
    return userId;
  };
}
