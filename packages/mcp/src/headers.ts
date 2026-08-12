/**
 * Supplies the headers for one request to an MCP server.
 *
 * Called per request rather than per connection: a connection outlives any single credential, and
 * one that is shared across users must not keep sending whatever was captured when it opened.
 */
export type McpHeaderProvider = () => Record<string, string> | Promise<Record<string, string>>;

/** Reads the configured headers, calling the provider when there is one. */
export async function resolveHeaders(
  headers: Record<string, string> | McpHeaderProvider | undefined,
): Promise<Record<string, string>> {
  if (headers === undefined) {
    return {};
  }
  return typeof headers === 'function' ? await headers() : headers;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Wraps `inner` so every request to `url`'s origin carries the configured headers.
 *
 * The headers ride here rather than on the transport's one-time `requestInit` because a provider
 * has to be consulted per request for its value to be current, and because this is where the
 * request's own URL can be seen.
 *
 * A header the request already carries is left alone: the transport sets the protocol's own
 * headers — content type, accept, the session id — and the SDK's auth support sets
 * `authorization` the same way, so a configured header fills gaps rather than overriding them.
 *
 * ## Security considerations
 *
 * Credentials belong to the server that was configured, not to wherever it points next, so a
 * request to any other origin is passed through untouched — and a redirect is **refused** rather
 * than followed. The platform's `fetch` follows redirects internally, where a cross-origin hop
 * would silently carry every custom header along (`fetch` strips `Authorization` and `Cookie` on
 * its own, but not an API key or a platform identity header). MCP has no redirect in its protocol
 * flow, so a redirecting endpoint is treated as a configuration problem: the request fails with
 * the address the server pointed at, and the remedy is to configure `url` as that endpoint. A
 * caller who passed `redirect: 'manual'` or `'error'` keeps that behaviour and handles redirects
 * themselves.
 */
export function headerInjectingFetch(
  url: URL,
  headers: Record<string, string> | McpHeaderProvider | undefined,
  inner: typeof globalThis.fetch,
): (target: string | URL | Request, init?: RequestInit) => Promise<Response> {
  // Wider than the transport's own FetchLike (string | URL): this is handed around as a drop-in
  // fetch, and a fetch also accepts a Request — whose URL is a property, not its stringification.
  return async (target: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = target instanceof Request ? target : undefined;
    const initialUrl = new URL(request?.url ?? String(target));
    if (headers === undefined || initialUrl.origin !== url.origin) {
      return await inner(target, init);
    }

    // An `init.headers` replaces a Request's own headers entirely — the platform rule — so the
    // Request's are the base only when the caller did not pass any.
    const carried = new Headers(init?.headers ?? request?.headers);
    const outgoing = new Headers(carried);
    for (const [name, value] of Object.entries(await resolveHeaders(headers))) {
      if (!carried.has(name)) {
        outgoing.set(name, value);
      }
    }

    const redirectMode = init?.redirect ?? request?.redirect ?? 'follow';
    if (redirectMode !== 'follow') {
      // The caller took charge of redirects; inject for the one request they asked for.
      return await inner(target, { ...init, headers: outgoing });
    }

    const response = await inner(target, { ...init, headers: outgoing, redirect: 'manual' });
    if (response.type === 'opaqueredirect') {
      // A runtime that hides redirect responses cannot even say where the server pointed.
      throw new Error(
        `The MCP endpoint at ${initialUrl.href} redirected. Requests carrying injected headers ` +
          'are not followed across redirects; configure `url` as the endpoint the server redirects to.',
      );
    }
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || location === null) {
      // The platform fetch also treats a redirect status without a Location as a final response.
      return response;
    }
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `The MCP endpoint at ${initialUrl.href} redirected to ${new URL(location, initialUrl).href}. ` +
        'Requests carrying injected headers are not followed across redirects — following one ' +
        'would have to decide which origins may see the credential. Configure `url` as the ' +
        'endpoint the server redirects to.',
    );
  };
}
