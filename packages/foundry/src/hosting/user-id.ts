import { ProtocolError } from '@polymind-inc/agent-framework-agentserver';

/**
 * The platform-injected user id, refused when the hosted environment did not supply one.
 *
 * An *empty* header is rejected the same as a missing one: it would silently fall through to an
 * anonymous partition every caller of a misconfigured gateway would share.
 */
export function requireHostedUserId(userId: string | undefined): string {
  if (userId === undefined || userId === '') {
    throw new ProtocolError(
      400,
      'The hosted environment is missing the platform user id. The request did not come from a ' +
        'Foundry platform service.',
      { code: 'missing_user_id', source: 'platform' },
    );
  }
  return userId;
}
