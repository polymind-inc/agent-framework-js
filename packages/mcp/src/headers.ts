import type { FetchLike } from '@modelcontextprotocol/client';

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

/**
 * Wraps `inner` so every request to `url`'s origin carries the configured headers.
 *
 * The headers ride here rather than on the transport's one-time `requestInit` because a provider
 * has to be consulted per request for its value to be current, and because this is where the
 * request's own URL can be seen.
 *
 * ## Security considerations
 *
 * Credentials belong to the server that was configured, not to wherever it points next, so a
 * request to any other origin is passed through untouched. Note the limit of that guarantee: the
 * platform's `fetch` follows redirects internally, so a cross-origin redirect is never seen here.
 * `Authorization` and `Cookie` are dropped by `fetch` itself in that case, but a custom header —
 * a call id, trace context, an API key under a vendor name — is not. A caller who needs a
 * redirect-proof guarantee should supply a `fetch` that refuses redirects.
 */
export function headerInjectingFetch(
  url: URL,
  headers: Record<string, string> | McpHeaderProvider | undefined,
  inner: typeof globalThis.fetch,
): FetchLike {
  return async (target: string | URL, init?: RequestInit): Promise<Response> => {
    // The MCP transport passes a string or URL, but this is handed around as a drop-in fetch, and
    // a fetch also accepts a Request — whose URL is a property, not its stringification.
    const request = target instanceof Request ? target : undefined;
    if (new URL(request?.url ?? String(target)).origin !== url.origin) {
      return await inner(target, init);
    }
    // An `init.headers` replaces a Request's own headers entirely — the platform rule — so the
    // Request's are the base only when the caller did not pass any.
    const merged = new Headers(init?.headers ?? request?.headers);
    for (const [name, value] of Object.entries(await resolveHeaders(headers))) {
      merged.set(name, value);
    }
    return await inner(target, { ...init, headers: merged });
  };
}
