import type { AccessToken, TokenCredential } from '@azure/identity';
import { FOUNDRY_SCOPE } from './target.js';

/** Refresh this long before expiry so a request never carries an about-to-expire token. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Adapts a {@link TokenCredential} to the OpenAI SDK's per-request key provider.
 *
 * The SDK calls the returned function on every request, so the token is always current; the cache
 * keeps that from turning into a credential round-trip per call.
 *
 * ## Security considerations
 *
 * The token is held in memory for its lifetime and sent as a bearer credential to `baseURL` only.
 * Point a Foundry client at a host you do not control and you hand that host a token for your
 * project.
 */
export function tokenProvider(
  credential: TokenCredential,
  scope: string = FOUNDRY_SCOPE,
): () => Promise<string> {
  let cached: AccessToken | undefined;
  let inFlight: Promise<AccessToken> | undefined;

  const isUsable = (token: AccessToken | undefined): token is AccessToken =>
    token !== undefined && token.token !== '' && token.expiresOnTimestamp - REFRESH_MARGIN_MS > Date.now();

  return async (): Promise<string> => {
    if (isUsable(cached)) {
      return cached.token;
    }
    // Concurrent requests share one refresh rather than stampeding the credential.
    inFlight ??= (async (): Promise<AccessToken> => {
      const token = await credential.getToken(scope);
      if (token === null) {
        throw new Error(`Could not acquire a Microsoft Entra token for scope '${scope}'.`);
      }
      return token;
    })().finally(() => {
      inFlight = undefined;
    });

    cached = await inFlight;
    return cached.token;
  };
}
