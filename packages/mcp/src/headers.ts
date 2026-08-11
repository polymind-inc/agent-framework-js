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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The platform fetch's own ceiling before it rejects with "too many redirects". */
const MAX_REDIRECTS = 20;

/** What the platform fetch itself removes when a redirect leaves the origin. */
const STRIPPED_ON_CROSS_ORIGIN = ['authorization', 'cookie', 'proxy-authorization'];

/** Entity headers that no longer describe the request once a redirect rewrites it to a GET. */
const STRIPPED_ON_METHOD_REWRITE = ['content-type', 'content-length', 'content-encoding', 'content-language'];

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
 * request to any other origin is passed through untouched — and because the platform's `fetch`
 * follows redirects internally, where a cross-origin hop would silently carry every custom header
 * along, redirects are followed *here* instead, one hop at a time with `redirect: 'manual'`. Each
 * hop re-decides: a hop on the configured origin gets fresh headers from the provider, a hop off
 * it gets none, and the headers the platform itself strips on a cross-origin hop —
 * `Authorization`, `Cookie`, `Proxy-Authorization` — are stripped here the same way. A caller who
 * passed `redirect: 'manual'` or `'error'` keeps that behaviour and handles redirects themselves.
 *
 * A runtime that hides redirect responses from `manual` (a browser's `opaqueredirect`) cannot
 * offer that guarantee; the request fails there rather than falling back to a leaky follow, and
 * the remedy is to point `url` at the endpoint the server redirects to.
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
    const initialUrl = new URL(request?.url ?? String(target));
    if (headers === undefined) {
      return await inner(target, init);
    }

    // An `init.headers` replaces a Request's own headers entirely — the platform rule — so the
    // Request's are the base only when the caller did not pass any. `carried` only ever holds the
    // request's own headers; injected values are computed per hop and never persisted into it.
    const carried = new Headers(init?.headers ?? request?.headers);
    const redirectMode = init?.redirect ?? request?.redirect ?? 'follow';
    if (redirectMode !== 'follow') {
      // The caller took charge of redirects; inject for the one request they asked for.
      if (initialUrl.origin !== url.origin) {
        return await inner(target, init);
      }
      return await inner(target, { ...init, headers: await withInjected(carried, headers) });
    }

    let currentUrl = initialUrl;
    let method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    let body: RequestInit['body'] = init?.body;
    for (let hop = 0; ; hop += 1) {
      const outgoing =
        currentUrl.origin === url.origin ? await withInjected(carried, headers) : new Headers(carried);
      // The first hop dispatches the caller's own argument, so a Request keeps its body and
      // options; later hops are rebuilt from what this loop tracks.
      const response =
        hop === 0 && request !== undefined
          ? await inner(request, { ...init, headers: outgoing, redirect: 'manual' })
          : await inner(currentUrl, {
              ...init,
              method,
              body: body ?? null,
              headers: outgoing,
              redirect: 'manual',
            });

      if (response.type === 'opaqueredirect') {
        throw new Error(
          'This runtime hides redirect responses, so a redirecting MCP endpoint cannot carry ' +
            'injected headers safely. Point `url` at the endpoint the server redirects to.',
        );
      }
      if (!REDIRECT_STATUSES.has(response.status)) {
        return response;
      }
      const location = response.headers.get('location');
      if (location === null) {
        // The platform fetch treats a redirect status without a Location as a final response.
        return response;
      }
      if (hop >= MAX_REDIRECTS) {
        throw new TypeError(`Gave up after ${MAX_REDIRECTS} redirects requesting ${currentUrl.href}.`);
      }
      await response.body?.cancel().catch(() => undefined);

      const nextUrl = new URL(location, currentUrl);
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
        // The platform fetch rewrites these to a bodyless GET; the entity headers go with it.
        method = 'GET';
        body = undefined;
        for (const name of STRIPPED_ON_METHOD_REWRITE) {
          carried.delete(name);
        }
      } else if (
        (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) ||
        (hop === 0 && request !== undefined && request.body !== null && init?.body === undefined)
      ) {
        // A streamed body was consumed by the hop that just failed to be final.
        throw new TypeError(
          `Cannot follow the redirect from ${currentUrl.href}: the request body was already sent.`,
        );
      }
      if (nextUrl.origin !== currentUrl.origin) {
        for (const name of STRIPPED_ON_CROSS_ORIGIN) {
          carried.delete(name);
        }
      }
      currentUrl = nextUrl;
    }
  };
}

/** A copy of `carried` with the configured headers filled into the names it does not claim. */
async function withInjected(
  carried: Headers,
  headers: Record<string, string> | McpHeaderProvider,
): Promise<Headers> {
  const outgoing = new Headers(carried);
  for (const [name, value] of Object.entries(await resolveHeaders(headers))) {
    if (!carried.has(name)) {
      outgoing.set(name, value);
    }
  }
  return outgoing;
}
