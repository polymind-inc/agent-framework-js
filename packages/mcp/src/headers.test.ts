import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { headerInjectingFetch } from './headers.js';

const SERVER = new URL('https://mcp.example.com/mcp');

/** A live HTTP server whose handler the test controls; each one is its own origin. */
interface LiveServer {
  origin: string;
  seen: Array<{ method: string; path: string; headers: Record<string, string>; body: string }>;
  handle: (request: IncomingMessage, response: ServerResponse) => void;
  close: () => Promise<void>;
}

const liveServers: Server[] = [];

async function liveServer(): Promise<LiveServer> {
  const seen: LiveServer['seen'] = [];
  const state: { handle: LiveServer['handle'] } = {
    handle: (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    },
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [name, String(value)]),
        ),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      state.handle(request, response);
    });
  });
  liveServers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Server did not report a port.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    seen,
    set handle(next: LiveServer['handle']) {
      state.handle = next;
    },
    get handle(): LiveServer['handle'] {
      return state.handle;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

afterEach(async () => {
  await Promise.all(
    liveServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/** Records what reached the underlying fetch and answers with nothing in particular. */
function recorder(): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch = (async (target: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(target),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return new Response('{}');
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('headerInjectingFetch', () => {
  it('sends a static record on every request', async () => {
    const { fetch, calls } = recorder();
    const send = headerInjectingFetch(SERVER, { 'x-api-key': 'secret' }, fetch);

    await send(SERVER);
    await send(SERVER);

    expect(calls.map((call) => call.headers['x-api-key'])).toEqual(['secret', 'secret']);
  });

  it('calls a provider once per request, so a refreshed credential is used', async () => {
    const { fetch, calls } = recorder();
    let issued = 0;
    const send = headerInjectingFetch(
      SERVER,
      async () => {
        issued += 1;
        return { authorization: `Bearer token-${issued}` };
      },
      fetch,
    );

    await send(SERVER);
    await send(SERVER);

    // The second request carries the second token: a credential that expired between the two is
    // replaced without the caller building a transport of its own.
    expect(calls.map((call) => call.headers.authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('keeps the headers the transport itself set', async () => {
    const { fetch, calls } = recorder();
    const send = headerInjectingFetch(SERVER, { authorization: 'Bearer t' }, fetch);

    await send(SERVER, { headers: { accept: 'text/event-stream' } });

    expect(calls[0]?.headers).toMatchObject({
      accept: 'text/event-stream',
      authorization: 'Bearer t',
    });
  });

  it('never overrides a header the request already carries', async () => {
    // The transport sets the protocol's own headers — content-type, accept, the session id —
    // after merging its request options, and the SDK's auth support sets `authorization` the same
    // way. A configured header fills gaps; it does not fight the transport for headers the
    // protocol owns, which is also how the static `requestInit` route has always behaved.
    const { fetch, calls } = recorder();
    const send = headerInjectingFetch(
      SERVER,
      { 'content-type': 'text/plain', 'mcp-session-id': 'forged', authorization: 'Bearer configured' },
      fetch,
    );

    await send(SERVER, {
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'sdk-issued' },
    });

    expect(calls[0]?.headers).toMatchObject({
      'content-type': 'application/json',
      'mcp-session-id': 'sdk-issued',
      authorization: 'Bearer configured',
    });
  });

  it('does not attach anything to another origin', async () => {
    const { fetch, calls } = recorder();
    const send = headerInjectingFetch(SERVER, { authorization: 'Bearer t' }, fetch);

    await send('https://elsewhere.example.com/mcp');

    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('treats a different port or scheme as another origin', async () => {
    const { fetch, calls } = recorder();
    const send = headerInjectingFetch(SERVER, { authorization: 'Bearer t' }, fetch);

    await send('https://mcp.example.com:8443/mcp');
    await send('http://mcp.example.com/mcp');

    expect(calls.map((call) => call.headers.authorization)).toEqual([undefined, undefined]);
  });

  it('still reaches the server when no headers are configured', async () => {
    const { fetch, calls } = recorder();

    await headerInjectingFetch(SERVER, undefined, fetch)(SERVER);

    expect(calls).toHaveLength(1);
  });

  it('accepts a Request object, keeping its headers under the injected ones', async () => {
    // The MCP transport only passes a URL, but the wrapper is handed around as a drop-in fetch
    // and a Request is a legal first argument to one — it must not be stringified into a bogus URL.
    const { fetch, calls } = recorder();
    const send = headerInjectingFetch(SERVER, { authorization: 'Bearer t' }, fetch);

    await send(new Request(SERVER, { headers: { accept: 'text/event-stream' } }) as unknown as URL);

    expect(calls[0]?.headers).toMatchObject({
      accept: 'text/event-stream',
      authorization: 'Bearer t',
    });
  });

  it('does not decorate a Request aimed at another origin', async () => {
    const { fetch, calls } = recorder();
    const send = headerInjectingFetch(SERVER, { authorization: 'Bearer t' }, fetch);

    await send(new Request('https://elsewhere.example.com/mcp') as unknown as URL);

    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  describe('redirects', () => {
    it('refuses a cross-origin redirect instead of deciding where the credential goes', async () => {
      // The platform fetch strips `authorization` on its own when a redirect changes origin, but
      // forwards every custom header — an API key or a platform identity header would arrive at
      // whatever host the first server named. With headers configured, a redirect fails loudly
      // instead, and nothing reaches the host the server pointed at.
      const elsewhere = await liveServer();
      const origin = await liveServer();
      origin.handle = (_request, response) => {
        response.writeHead(302, { location: `${elsewhere.origin}/harvest` });
        response.end();
      };
      const send = headerInjectingFetch(
        new URL(`${origin.origin}/mcp`),
        { authorization: 'Bearer secret', 'x-api-key': 'secret-key' },
        globalThis.fetch,
      );

      await expect(send(`${origin.origin}/mcp`)).rejects.toThrow(/redirect/);

      expect(origin.seen[0]?.headers['x-api-key']).toBe('secret-key');
      expect(elsewhere.seen).toHaveLength(0);
    });

    it('refuses a same-origin redirect too, naming the endpoint to configure', async () => {
      // MCP has no redirect in its protocol flow, so a redirecting endpoint is a configuration
      // problem; the error says where the server pointed so the configuration can be fixed.
      const origin = await liveServer();
      origin.handle = (_request, response) => {
        response.writeHead(307, { location: '/moved' });
        response.end();
      };
      const send = headerInjectingFetch(
        new URL(`${origin.origin}/mcp`),
        { authorization: 'Bearer t' },
        globalThis.fetch,
      );

      await expect(send(`${origin.origin}/mcp`, { method: 'POST', body: '{}' })).rejects.toThrow(/\/moved/);

      expect(origin.seen).toHaveLength(1);
    });

    it('returns a redirect status without a Location as the final response', async () => {
      // The platform fetch treats it the same way: with nowhere to go, the response is the answer.
      const noLocation = (async (): Promise<Response> =>
        new Response(null, { status: 302 })) as unknown as typeof globalThis.fetch;
      const send = headerInjectingFetch(SERVER, { authorization: 'Bearer t' }, noLocation);

      const response = await send(SERVER);

      expect(response.status).toBe(302);
    });

    it('leaves redirect handling to a caller who asked for manual', async () => {
      const { fetch, calls } = recorder();
      const send = headerInjectingFetch(SERVER, { authorization: 'Bearer t' }, fetch);

      await send(SERVER, { redirect: 'manual' });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.headers.authorization).toBe('Bearer t');
    });
  });
});
