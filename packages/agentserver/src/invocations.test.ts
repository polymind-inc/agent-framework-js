import { assert, describe, expect, it, vi } from 'vitest';
import { getRequestContext, HEADERS } from './context.js';
import { badRequest, ProtocolError } from './errors.js';
import type { InvocationHandler, InvocationsServerConfig } from './invocations.js';
import { INVOCATION_ID_HEADER, InvocationsServer } from './invocations.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Echoes the raw request body back, with the invocation identity in a JSON envelope. */
function echoHandler(): InvocationHandler {
  return async (request, context) =>
    new Response(
      JSON.stringify({
        invocationId: context.invocationId,
        sessionId: context.sessionId,
        body: await request.text(),
      }),
      { headers: { 'content-type': 'application/json' } },
    );
}

function makeServer(overrides: Partial<InvocationsServerConfig> = {}): InvocationsServer {
  return new InvocationsServer({ handler: echoHandler(), ...overrides });
}

function invoke(body: string | null = 'hello', headers: Record<string, string> = {}, query = ''): Request {
  return new Request(`http://localhost:8088/invocations${query}`, {
    method: 'POST',
    headers,
    ...(body === null ? {} : { body }),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function errorCodeOf(payload: Record<string, unknown>): string {
  return (payload.error as { code: string }).code;
}

describe('routes', () => {
  it('answers the readiness probe', async () => {
    const response = await makeServer().handle(new Request('http://localhost:8088/readiness'));
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ status: 'healthy' });
  });

  it('dispatches POST /invocations to the handler with the body unread', async () => {
    // Not JSON on purpose: the protocol layer must pass the payload through unparsed.
    const response = await makeServer().handle(
      invoke('this is { not json', { 'content-type': 'text/plain' }),
    );
    expect(response.status).toBe(200);
    expect((await json(response)).body).toBe('this is { not json');
  });

  it('preserves the handler-chosen status and content type', async () => {
    const server = makeServer({
      handler: () => new Response('accepted', { status: 202, headers: { 'content-type': 'text/plain' } }),
    });
    const response = await server.handle(invoke());
    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(await response.text()).toBe('accepted');
  });

  it('passes a handler response with no body through', async () => {
    const server = makeServer({ handler: () => new Response(null, { status: 204 }) });
    const response = await server.handle(invoke());
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('answers 405 for a GET on the invoke route', async () => {
    const response = await makeServer().handle(new Request('http://localhost:8088/invocations'));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('answers 404 for the read route until a handler is registered', async () => {
    const response = await makeServer().handle(new Request('http://localhost:8088/invocations/inv_1'));
    expect(response.status).toBe(404);
    expect(errorCodeOf(await json(response))).toBe('not_found');
    // Application code is what is missing, not platform plumbing.
    expect(response.headers.get(HEADERS.errorSource)).toBe('upstream');
  });

  it('answers 404 for the cancel route until a handler is registered', async () => {
    const response = await makeServer().handle(
      new Request('http://localhost:8088/invocations/inv_1/cancel', { method: 'POST' }),
    );
    expect(response.status).toBe(404);
    expect(errorCodeOf(await json(response))).toBe('not_found');
  });

  it('dispatches the read route with the path id', async () => {
    const server = makeServer({
      getHandler: (_request, context) => new Response(JSON.stringify({ id: context.invocationId })),
    });
    const response = await server.handle(new Request('http://localhost:8088/invocations/inv_42'));
    expect(response.status).toBe(200);
    expect((await json(response)).id).toBe('inv_42');
    expect(response.headers.get(INVOCATION_ID_HEADER)).toBe('inv_42');
  });

  it('dispatches the cancel route and refuses other verbs on it', async () => {
    const server = makeServer({
      cancelHandler: (_request, context) => new Response(JSON.stringify({ cancelled: context.invocationId })),
    });
    const ok = await server.handle(
      new Request('http://localhost:8088/invocations/inv_9/cancel', { method: 'POST' }),
    );
    expect((await json(ok)).cancelled).toBe('inv_9');

    const wrongVerb = await server.handle(new Request('http://localhost:8088/invocations/inv_9/cancel'));
    expect(wrongVerb.status).toBe(405);
    expect(wrongVerb.headers.get('allow')).toBe('POST');
  });

  it('refuses a GET id route reached with POST', async () => {
    const response = await makeServer({ getHandler: echoHandler() }).handle(
      new Request('http://localhost:8088/invocations/inv_1', { method: 'POST' }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });

  it('answers 404 for paths outside the protocol and below the known routes', async () => {
    const server = makeServer({ cancelHandler: echoHandler() });
    for (const path of ['/responses', '/invocations/inv_1/cancel/extra', '/invocations/inv_1/other']) {
      const response = await server.handle(new Request(`http://localhost:8088${path}`, { method: 'POST' }));
      expect(response.status, path).toBe(404);
    }
  });

  it('rejects lookalike paths that only share the prefix', async () => {
    // `/invocationsfoo` must never alias `/invocations/foo`: with handlers registered on every
    // route, each of these still falls outside the protocol.
    const server = makeServer({ getHandler: echoHandler(), cancelHandler: echoHandler() });
    const cases: Array<[string, string]> = [
      ['GET', '/invocationsfoo'],
      ['POST', '/invocationsfoo'],
      ['POST', '/invocationsfoo/cancel'],
    ];
    for (const [method, path] of cases) {
      const response = await server.handle(
        new Request(`http://localhost:8088${path}`, {
          method,
          ...(method === 'POST' ? { body: 'x' } : {}),
        }),
      );
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it('answers a unicode path id without crashing, degrading only the header echo', async () => {
    const server = makeServer({ getHandler: (_request, context) => new Response(context.invocationId) });
    const response = await server.handle(new Request('http://localhost:8088/invocations/%E2%98%83'));
    expect(response.status).toBe(200);
    // The handler still sees the id as the caller sent it; only the header echo degrades to a
    // representable approximation instead of crashing the response.
    expect(await response.text()).toBe('☃');
    expect(response.headers.get(INVOCATION_ID_HEADER)).toBe('?');
  });

  it.each([
    ['read', 'GET', ''],
    ['cancel', 'POST', '/cancel'],
  ])(
    'stamps the resolved identity on the 404 for an unregistered %s route',
    async (_name, method, suffix) => {
      const response = await makeServer().handle(
        new Request(`http://localhost:8088/invocations/inv_404${suffix}?agent_session_id=pin`, { method }),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get(INVOCATION_ID_HEADER)).toBe('inv_404');
      expect(response.headers.get(HEADERS.sessionId)).toBe('pin');
    },
  );

  it('generates the session id echoed on an unregistered-route 404 when nothing names one', async () => {
    const response = await makeServer().handle(new Request('http://localhost:8088/invocations/inv_404'));
    expect(response.status).toBe(404);
    const sessionId = response.headers.get(HEADERS.sessionId);
    assert.exists(sessionId);
    expect(sessionId).toMatch(UUID);
  });

  it('mounts under a prefix without claiming sibling paths', async () => {
    const server = makeServer({ prefix: '/api' });
    const mounted = await server.handle(
      new Request('http://localhost:8088/api/invocations', { method: 'POST', body: 'x' }),
    );
    expect(mounted.status).toBe(200);

    const sibling = await server.handle(
      new Request('http://localhost:8088/apiary/invocations', { method: 'POST', body: 'x' }),
    );
    expect(sibling.status).toBe(404);

    const bare = await server.handle(new Request('http://localhost:8088/invocations', { method: 'POST' }));
    expect(bare.status).toBe(404);
  });
});

describe('invocation id', () => {
  it('echoes a valid x-agent-invocation-id on the response and to the handler', async () => {
    const response = await makeServer().handle(invoke('x', { [INVOCATION_ID_HEADER]: 'inv_abc.1:2' }));
    expect(response.headers.get(INVOCATION_ID_HEADER)).toBe('inv_abc.1:2');
    expect((await json(response)).invocationId).toBe('inv_abc.1:2');
  });

  it.each([
    ['empty', ''],
    ['illegal characters', 'inv id with spaces'],
    ['overlong', 'a'.repeat(257)],
  ])('replaces an invalid header (%s) with a generated UUID', async (_name, value) => {
    const response = await makeServer().handle(invoke('x', { [INVOCATION_ID_HEADER]: value }));
    const invocationId = response.headers.get(INVOCATION_ID_HEADER);
    assert.exists(invocationId);
    expect(invocationId).toMatch(UUID);
  });

  it('generates a UUID when the header is absent', async () => {
    const response = await makeServer().handle(invoke());
    const invocationId = response.headers.get(INVOCATION_ID_HEADER);
    assert.exists(invocationId);
    expect(invocationId).toMatch(UUID);
  });

  it('overrides an invocation id header the handler set itself', async () => {
    const server = makeServer({
      handler: () => new Response('x', { headers: { [INVOCATION_ID_HEADER]: 'handler-forged' } }),
    });
    const response = await server.handle(invoke('x', { [INVOCATION_ID_HEADER]: 'inv_real' }));
    expect(response.headers.get(INVOCATION_ID_HEADER)).toBe('inv_real');
  });
});

describe('session id', () => {
  it('prefers the agent_session_id query parameter', async () => {
    vi.stubEnv('FOUNDRY_AGENT_SESSION_ID', 'env-session');
    const response = await makeServer().handle(invoke('x', {}, '?agent_session_id=query-session'));
    expect(response.headers.get(HEADERS.sessionId)).toBe('query-session');
    expect((await json(response)).sessionId).toBe('query-session');
  });

  it('falls back to FOUNDRY_AGENT_SESSION_ID', async () => {
    vi.stubEnv('FOUNDRY_AGENT_SESSION_ID', 'env-session');
    const response = await makeServer().handle(invoke());
    expect(response.headers.get(HEADERS.sessionId)).toBe('env-session');
  });

  it('generates a UUID when neither the query nor the environment names one', async () => {
    const response = await makeServer().handle(invoke());
    const sessionId = response.headers.get(HEADERS.sessionId);
    assert.exists(sessionId);
    expect(sessionId).toMatch(UUID);
  });

  it('ignores an invalid query value rather than propagating it', async () => {
    vi.stubEnv('FOUNDRY_AGENT_SESSION_ID', 'env-session');
    const response = await makeServer().handle(invoke('x', {}, `?agent_session_id=${'a'.repeat(300)}`));
    expect(response.headers.get(HEADERS.sessionId)).toBe('env-session');
  });

  it('resolves the session for the read and cancel routes by the same rule', async () => {
    const server = makeServer({
      getHandler: (_request, context) => new Response(context.sessionId),
    });
    const response = await server.handle(
      new Request('http://localhost:8088/invocations/inv_1?agent_session_id=pinned'),
    );
    expect(await response.text()).toBe('pinned');
    expect(response.headers.get(HEADERS.sessionId)).toBe('pinned');
  });
});

describe('header contract', () => {
  it('echoes x-request-id and reports the invocations protocol on x-platform-server', async () => {
    const response = await makeServer().handle(invoke('x', { [HEADERS.requestId]: 'req-1' }));
    expect(response.headers.get(HEADERS.requestId)).toBe('req-1');
    const serverVersion = response.headers.get(HEADERS.serverVersion);
    assert.exists(serverVersion);
    expect(serverVersion).toContain('protocol/invocations-2.0.0');
  });

  it('generates a request id when the caller sent none', async () => {
    const response = await makeServer().handle(invoke());
    const requestId = response.headers.get(HEADERS.requestId);
    assert.exists(requestId);
    expect(requestId).toMatch(UUID);
  });

  it('hands the platform identity to the handler through the request context', async () => {
    const server = makeServer({
      handler: (_request, context) =>
        new Response(
          JSON.stringify({
            userId: context.request.userId,
            callId: context.request.foundryCallId,
            outbound: context.request.platformHeaders(),
          }),
        ),
    });
    const response = await server.handle(
      invoke('x', { [HEADERS.userId]: 'user-1', [HEADERS.foundryCallId]: 'call-1' }),
    );
    const body = await json(response);
    expect(body.userId).toBe('user-1');
    expect(body.callId).toBe('call-1');
    // The user id never appears among the outbound platform headers.
    expect(body.outbound).toEqual({ [HEADERS.foundryCallId]: 'call-1' });
  });

  it('keeps the ambient request context available to the handler', async () => {
    const server = makeServer({
      handler: () => new Response(getRequestContext()?.foundryCallId ?? 'missing'),
    });
    const response = await server.handle(invoke('x', { [HEADERS.foundryCallId]: 'call-9' }));
    expect(await response.text()).toBe('call-9');
  });

  it('keeps the request context across the pulls of a streamed body', async () => {
    // The socket writer consumes the body long after the request scope closed. The first pull of
    // the handler's stream runs eagerly inside that scope; the second is consumer-driven, so this
    // pins the outcome — a late pull still sees the turn's platform headers — whichever layer
    // (the wrapper's re-entry, or the stream's own creation-scope propagation) provides it.
    let pulls = 0;
    const server = makeServer({
      handler: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller): void {
              pulls += 1;
              controller.enqueue(
                new TextEncoder().encode(`${pulls}:${getRequestContext()?.foundryCallId ?? 'missing'};`),
              );
              if (pulls === 2) {
                controller.close();
              }
            },
          }),
        ),
    });
    const response = await server.handle(invoke('x', { [HEADERS.foundryCallId]: 'call-7' }));
    expect(await response.text()).toBe('1:call-7;2:call-7;');
  });
});

describe('body cancellation', () => {
  it('keeps the request context for the upstream cancel when the caller abandons the body', async () => {
    // A consumer cancels the body from outside every ambient scope; the handler's own stream
    // teardown must still see the turn's request context.
    let observed: string | undefined | null = null;
    const server = makeServer({
      handler: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(new TextEncoder().encode('first'));
            },
            cancel(): void {
              observed = getRequestContext()?.requestId;
            },
          }),
        ),
    });
    const response = await server.handle(invoke('x', { [HEADERS.requestId]: 'req-cancel' }));
    assert.exists(response.body);
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel('abandoned');
    expect(observed).toBe('req-cancel');
  });
});

describe('errors', () => {
  it('answers a handler exception with an opaque 500 classified upstream', async () => {
    const server = makeServer({
      handler: () => {
        throw new Error('the connection string is secret-42');
      },
    });
    const response = await server.handle(invoke());
    expect(response.status).toBe(500);
    const body = await json(response);
    expect((body.error as { message: string }).message).toBe('internal server error');
    expect(JSON.stringify(body)).not.toContain('secret-42');
    expect(response.headers.get(HEADERS.errorSource)).toBe('upstream');
    // Diagnostics stay off the wire for upstream failures.
    expect(response.headers.get(HEADERS.errorDetail)).toBeNull();
  });

  it('answers a rejected handler promise the same way', async () => {
    const server = makeServer({ handler: () => Promise.reject(new Error('boom')) });
    const response = await server.handle(invoke());
    expect(response.status).toBe(500);
    expect(response.headers.get(HEADERS.errorSource)).toBe('upstream');
  });

  it('lets a handler-thrown ProtocolError shape the response', async () => {
    const server = makeServer({
      handler: () => {
        throw badRequest('message is required', { param: 'message' });
      },
    });
    const response = await server.handle(invoke());
    expect(response.status).toBe(400);
    expect(errorCodeOf(await json(response))).toBe('invalid_request');
    expect(response.headers.get(HEADERS.errorSource)).toBe('user');
  });

  it('carries diagnostics on the detail header for platform-source errors only', async () => {
    const server = makeServer({
      handler: () => {
        throw new ProtocolError(500, 'internal server error', {
          code: 'server_error',
          type: 'server_error',
          source: 'platform',
          detail: 'stage: session restore',
        });
      },
    });
    const response = await server.handle(invoke());
    expect(response.headers.get(HEADERS.errorDetail)).toBe('stage: session restore');
  });

  it('stamps the resolved invocation identity on error responses too', async () => {
    const server = makeServer({
      handler: () => {
        throw new Error('boom');
      },
    });
    const response = await server.handle(
      invoke('x', { [INVOCATION_ID_HEADER]: 'inv_fail' }, '?agent_session_id=sess_fail'),
    );
    expect(response.headers.get(INVOCATION_ID_HEADER)).toBe('inv_fail');
    expect(response.headers.get(HEADERS.sessionId)).toBe('sess_fail');
  });
});

describe('draining', () => {
  it('refuses new invocations with 503 while the readiness probe keeps answering', async () => {
    const server = makeServer();
    await server.drain();

    const refused = await server.handle(invoke());
    expect(refused.status).toBe(503);

    const probe = await server.handle(new Request('http://localhost:8088/readiness'));
    expect(probe.status).toBe(200);
  });
});

describe('cancellation', () => {
  it('aborts the handler when the caller disconnects', async () => {
    const aborted = Promise.withResolvers<void>();
    const server = makeServer({
      handler: async (_request, context) => {
        if (context.signal.aborted) {
          aborted.resolve();
        } else {
          context.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        }
        await aborted.promise;
        return new Response('wound down');
      },
    });

    const controller = new AbortController();
    const pending = server.handle(
      new Request('http://localhost:8088/invocations', {
        method: 'POST',
        body: 'x',
        signal: controller.signal,
      }),
    );
    controller.abort();
    const response = await pending;
    expect(await response.text()).toBe('wound down');
  });

  it('aborts in-flight handlers when the server drains', async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const server = makeServer({
      handler: async (_request, context) => {
        context.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        entered.resolve();
        await aborted.promise;
        return new Response('stopped');
      },
    });

    const pending = server.handle(invoke());
    await entered.promise;
    await server.drain();
    expect(await (await pending).text()).toBe('stopped');
  });

  it('hands an already-aborted request signal to the handler as aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let observed: boolean | undefined;
    const server = makeServer({
      handler: (_request, context) => {
        observed = context.signal.aborted;
        return new Response('x');
      },
    });
    await server.handle(
      new Request('http://localhost:8088/invocations', {
        method: 'POST',
        body: 'x',
        signal: controller.signal,
      }),
    );
    expect(observed).toBe(true);
  });
});

describe('SSE keep-alive', () => {
  function sseHandler(gate: Promise<void>): InvocationHandler {
    return () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller): Promise<void> {
            controller.enqueue(new TextEncoder().encode('data: first\n\n'));
            await gate;
            controller.enqueue(new TextEncoder().encode('data: second\n\n'));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
  }

  it('stays silent by default', async () => {
    const gate = Promise.withResolvers<void>();
    const server = makeServer({ handler: sseHandler(gate.promise) });
    const pending = server.handle(invoke());
    setTimeout(() => gate.resolve(), 50);
    const text = await (await pending).text();
    expect(text).not.toContain(': keep-alive');
  });

  it('injects keep-alive comments into a silent text/event-stream body', async () => {
    vi.stubEnv('SSE_KEEPALIVE_INTERVAL', '1');
    vi.useFakeTimers();
    try {
      const gate = Promise.withResolvers<void>();
      const server = makeServer({ handler: sseHandler(gate.promise) });
      const response = await server.handle(invoke());
      assert.exists(response.body);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      expect(decoder.decode((await reader.read()).value)).toBe('data: first\n\n');

      // One interval of silence: the wrapper speaks so the proxies stay convinced.
      const second = reader.read();
      await vi.advanceTimersByTimeAsync(1000);
      expect(decoder.decode((await second).value)).toBe(': keep-alive\n\n');

      gate.resolve();
      expect(decoder.decode((await reader.read()).value)).toBe('data: second\n\n');
      expect((await reader.read()).done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers the payload intact after many consecutive keep-alives', async () => {
    // Hours of silence mean many intervals against one still-pending read; the wait must resolve
    // through the read's single observer every time, and the eventual chunk must still arrive.
    vi.stubEnv('SSE_KEEPALIVE_INTERVAL', '1');
    vi.useFakeTimers();
    try {
      const gate = Promise.withResolvers<void>();
      const server = makeServer({ handler: sseHandler(gate.promise) });
      const response = await server.handle(invoke());
      assert.exists(response.body);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      expect(decoder.decode((await reader.read()).value)).toBe('data: first\n\n');

      for (let interval = 0; interval < 5; interval += 1) {
        const next = reader.read();
        await vi.advanceTimersByTimeAsync(1000);
        expect(decoder.decode((await next).value), `interval ${interval}`).toBe(': keep-alive\n\n');
      }

      gate.resolve();
      expect(decoder.decode((await reader.read()).value)).toBe('data: second\n\n');
      expect((await reader.read()).done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not queue an unbounded number of keep-alives for a slow reader', async () => {
    vi.stubEnv('SSE_KEEPALIVE_INTERVAL', '1');
    vi.useFakeTimers();
    try {
      const gate = Promise.withResolvers<void>();
      const server = makeServer({ handler: sseHandler(gate.promise) });
      const response = await server.handle(invoke());
      assert.exists(response.body);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      expect(decoder.decode((await reader.read()).value)).toBe('data: first\n\n');
      await vi.advanceTimersByTimeAsync(5000);
      expect(decoder.decode((await reader.read()).value)).toBe(': keep-alive\n\n');

      let resolved = false;
      const next = reader.read().then((result) => {
        resolved = true;
        return result;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(decoder.decode((await next).value)).toBe(': keep-alive\n\n');

      gate.resolve();
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a stream failure that lands after keep-alives', async () => {
    vi.stubEnv('SSE_KEEPALIVE_INTERVAL', '1');
    vi.useFakeTimers();
    try {
      const gate = Promise.withResolvers<void>();
      const server = makeServer({
        handler: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller): Promise<void> {
                controller.enqueue(new TextEncoder().encode('data: first\n\n'));
                await gate.promise;
                controller.error(new Error('source broke'));
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      });
      const response = await server.handle(invoke());
      assert.exists(response.body);
      const reader = response.body.getReader();

      await reader.read();
      const next = reader.read();
      await vi.advanceTimersByTimeAsync(1000);
      expect(new TextDecoder().decode((await next).value)).toBe(': keep-alive\n\n');

      gate.resolve();
      await expect(reader.read()).rejects.toThrow('source broke');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never injects comments into a non-SSE stream', async () => {
    vi.stubEnv('SSE_KEEPALIVE_INTERVAL', '1');
    vi.useFakeTimers();
    try {
      const gate = Promise.withResolvers<void>();
      const server = makeServer({
        handler: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller): Promise<void> {
                controller.enqueue(new TextEncoder().encode('{"part":1}\n'));
                await gate.promise;
                controller.enqueue(new TextEncoder().encode('{"part":2}\n'));
                controller.close();
              },
            }),
            { headers: { 'content-type': 'application/x-ndjson' } },
          ),
      });
      const response = await server.handle(invoke());
      assert.exists(response.body);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      expect(decoder.decode((await reader.read()).value)).toBe('{"part":1}\n');
      const second = reader.read();
      await vi.advanceTimersByTimeAsync(5000);
      gate.resolve();
      // The next chunk is the payload itself — no comment was interleaved during the silence.
      expect(decoder.decode((await second).value)).toBe('{"part":2}\n');
    } finally {
      vi.useRealTimers();
    }
  });
});
