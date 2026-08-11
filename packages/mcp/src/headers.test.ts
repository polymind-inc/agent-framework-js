import { describe, expect, it } from 'vitest';
import { headerInjectingFetch } from './headers.js';

const SERVER = new URL('https://mcp.example.com/mcp');

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

  it('wins over a header of the same name on the request', async () => {
    const { fetch, calls } = recorder();
    const send = headerInjectingFetch(SERVER, { authorization: 'Bearer fresh' }, fetch);

    await send(SERVER, { headers: { authorization: 'Bearer stale' } });

    expect(calls[0]?.headers.authorization).toBe('Bearer fresh');
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
});
