/**
 * Request assembly and failure diagnostics shared by the hand-written Foundry data-plane clients
 * (response storage, memory stores). Retry policy stays with each client: storage retries
 * transient failures, memory deliberately does not.
 */

import { FOUNDRY_API_VERSION } from './target.js';

/** The full request URL: the base, the route, and the data-plane api-version query. */
export function foundryUrl(base: string, path: string, extraQuery: Record<string, string> = {}): string {
  const query = new URLSearchParams({ 'api-version': FOUNDRY_API_VERSION, ...extraQuery });
  return `${base}${path}?${query.toString()}`;
}

/** What one Foundry data-plane request carries beyond its method and route. */
export interface FoundryRequestOptions {
  /** Headers beyond bearer auth and accept — platform correlation headers, feature opt-ins. */
  headers?: Record<string, string>;
  /** JSON-encoded onto the request, with the matching content-type. */
  body?: unknown;
  signal?: AbortSignal | undefined;
}

/**
 * The `fetch` init for one authenticated JSON request: bearer auth, JSON accept, and — only when
 * a body is present — the JSON content-type and the encoded body.
 */
export function foundryRequestInit(
  method: string,
  token: string,
  options: FoundryRequestOptions = {},
): RequestInit {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    ...options.headers,
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

/**
 * The response body as text, or `''` when it cannot be read.
 *
 * A body that cannot be read must not replace the status with a read error.
 */
export async function bodyText(response: Response): Promise<string> {
  // try/catch rather than `.catch()`: a non-standard transport can throw from `text()` itself
  // synchronously, and that failure degrades the same way as a rejected read.
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * The diagnostic message for a data-plane response that did not succeed.
 *
 * The service's own message is included, bounded. Without it a failure reads only as
 * `Foundry storage returned 500`, which says nothing about whether the payload was wrong, the
 * caller unresolvable, or the service down — and this runs inside a container where attaching a
 * debugger is not an option, so the error text is the entire diagnostic.
 */
export function foundryFailureMessage(service: string, status: number, body: string, what: string): string {
  const detail = body.slice(0, 500);
  return `Foundry ${service} returned ${status} for ${what}.${detail === '' ? '' : ` ${detail}`}`;
}

/**
 * Cancels a discarded response's body.
 *
 * A response nothing reads would otherwise hold its connection until GC; cancelling is
 * best-effort resource hygiene, never a failure.
 */
export async function drainBody(response: Response): Promise<void> {
  // try/catch rather than `.catch()`: a non-standard transport can throw from `cancel()` itself
  // synchronously, and "never a failure" has to cover that path too.
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort only.
  }
}
