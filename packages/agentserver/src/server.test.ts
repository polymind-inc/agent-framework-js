import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEADERS } from './context.js';
import { ProtocolError } from './errors.js';
import type { HandlerContext, ResponseHandler } from './server.js';
import { ResponsesServer } from './server.js';
import { encodeEvent } from './sse.js';
import { InMemoryResponseProvider } from './store/memory.js';
import type { CreateResponseRequest, ResponseObject } from './wire.js';

/** The echo handler from the reference samples: one message item, streamed as one delta. */
function echoHandler(): ResponseHandler {
  return async function* (request: CreateResponseRequest, context: HandlerContext) {
    const text = `Echo: ${typeof request.input === 'string' ? request.input : JSON.stringify(request.input)}`;
    const response = (status: ResponseObject['status']): ResponseObject => ({
      ...context.response,
      status,
    });

    yield { type: 'response.created', response: response('queued') };
    yield { type: 'response.in_progress', response: response('in_progress') };
    yield {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] },
    };
    yield {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: text,
    };
    yield {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    };
    yield { type: 'response.completed', response: response('completed') };
  };
}

function makeServer(handler: ResponseHandler = echoHandler(), hosted = false): ResponsesServer {
  return new ResponsesServer({ handler, store: new InMemoryResponseProvider(), hosted });
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:8088/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** Narrows away undefined; a missing value fails the test with a clear error. */
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value');
  return value;
}

/** Parses an SSE body into `{ event, data }` pairs. */
async function readSse(response: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((block) => block.trim() !== '' && !block.startsWith(':'))
    .map((block) => {
      const eventLine = must(block.split('\n').find((line) => line.startsWith('event: ')));
      const dataLine = must(block.split('\n').find((line) => line.startsWith('data: ')));
      return {
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
      };
    });
}

describe('routes', () => {
  it('answers the readiness probe', async () => {
    const response = await makeServer().handle(new Request('http://localhost:8088/readiness'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'healthy' });
  });

  it('creates a response and returns the finished resource', async () => {
    const response = await makeServer().handle(post({ input: 'Hi' }));
    const body = (await response.json()) as ResponseObject;

    expect(response.status).toBe(200);
    expect(body.object).toBe('response');
    expect(body.id).toMatch(/^caresp_[0-9a-f]{16}00[A-Za-z0-9]{32}$/);
    expect(body.status).toBe('completed');
    expect(body.output).toHaveLength(1);
    expect(JSON.stringify(body.output[0])).toContain('Echo: Hi');
  });

  it('stamps the agent identity onto every response resource', async () => {
    // A service-side store validates that every persisted response names its agent — without the
    // stamp, the write dies as an opaque 500. Resolved once at resource construction so every
    // store sees it: the request's own reference first, else the environment, else the default.
    const saved = { name: process.env.FOUNDRY_AGENT_NAME, version: process.env.FOUNDRY_AGENT_VERSION };
    try {
      process.env.FOUNDRY_AGENT_NAME = 'weather-agent';
      process.env.FOUNDRY_AGENT_VERSION = '2';
      const server = makeServer();

      const fromEnv = (await (await server.handle(post({ input: 'Hi' }))).json()) as ResponseObject;
      expect(fromEnv.agent_reference).toEqual({
        type: 'agent_reference',
        name: 'weather-agent',
        version: '2',
      });

      const requested = (await (
        await server.handle(
          post({ input: 'Hi', agent_reference: { type: 'agent_reference', name: 'router', version: '9' } }),
        )
      ).json()) as ResponseObject;
      expect(requested.agent_reference).toEqual({
        type: 'agent_reference',
        name: 'router',
        version: '9',
      });

      delete process.env.FOUNDRY_AGENT_NAME;
      delete process.env.FOUNDRY_AGENT_VERSION;
      const fallback = (await (await server.handle(post({ input: 'Hi' }))).json()) as ResponseObject;
      expect(fallback.agent_reference).toEqual({ type: 'agent_reference', name: 'server-default-agent' });

      // Validation only checks name and version, so a caller can omit the discriminator or send
      // a wrong one — the resolved reference normalizes it to the literal the wire type declares.
      const untyped = (await (
        await server.handle(post({ input: 'Hi', agent_reference: { name: 'router' } }))
      ).json()) as ResponseObject;
      expect(untyped.agent_reference).toEqual({ type: 'agent_reference', name: 'router' });

      const mistyped = (await (
        await server.handle(
          post({ input: 'Hi', agent_reference: { type: 'other', name: 'router', version: '3' } }),
        )
      ).json()) as ResponseObject;
      expect(mistyped.agent_reference).toEqual({ type: 'agent_reference', name: 'router', version: '3' });
    } finally {
      if (saved.name !== undefined) process.env.FOUNDRY_AGENT_NAME = saved.name;
      else delete process.env.FOUNDRY_AGENT_NAME;
      if (saved.version !== undefined) process.env.FOUNDRY_AGENT_VERSION = saved.version;
      else delete process.env.FOUNDRY_AGENT_VERSION;
    }
  });

  it('gets, lists input items for, and deletes a response', async () => {
    const server = makeServer();
    const created = (await (
      await server.handle(post({ input: [{ type: 'message', id: 'in_1' }] }))
    ).json()) as ResponseObject;

    const fetched = await server.handle(new Request(`http://localhost:8088/responses/${created.id}`));
    expect(((await fetched.json()) as ResponseObject).id).toBe(created.id);

    const items = await server.handle(
      new Request(`http://localhost:8088/responses/${created.id}/input_items`),
    );
    const list = (await items.json()) as { object: string; data: unknown[]; has_more: boolean };
    expect(list.object).toBe('list');
    expect(list.data).toHaveLength(1);
    expect(list.has_more).toBe(false);

    const deleted = await server.handle(
      new Request(`http://localhost:8088/responses/${created.id}`, { method: 'DELETE' }),
    );
    expect(await deleted.json()).toEqual({ id: created.id, object: 'response', deleted: true });

    const gone = await server.handle(new Request(`http://localhost:8088/responses/${created.id}`));
    expect(gone.status).toBe(404);
  });

  it('lists input items newest-first by default, and accepts order case-insensitively', async () => {
    const server = makeServer();
    const input = [
      { type: 'message', id: 'in_1' },
      { type: 'message', id: 'in_2' },
      { type: 'message', id: 'in_3' },
    ];
    const created = (await (await server.handle(post({ input }))).json()) as ResponseObject;

    const ids = async (query: string): Promise<unknown> => {
      const response = await server.handle(
        new Request(`http://localhost:8088/responses/${created.id}/input_items${query}`),
      );
      const list = (await response.json()) as { data: Array<{ id: string }> };
      return list.data.map((item) => item.id);
    };

    // Python defaults `order` to `"desc"` and lowercases it before matching
    // (`_endpoint_handler.py`).
    expect(await ids('')).toEqual(['in_3', 'in_2', 'in_1']);
    expect(await ids('?order=asc')).toEqual(['in_1', 'in_2', 'in_3']);
    expect(await ids('?order=ASC')).toEqual(['in_1', 'in_2', 'in_3']);
    expect(await ids('?order=Desc')).toEqual(['in_3', 'in_2', 'in_1']);

    const rejected = await server.handle(
      new Request(`http://localhost:8088/responses/${created.id}/input_items?order=sideways`),
    );
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { error: { param: string } }).error.param).toBe('order');
  });

  it('rejects cancelling a response that is not running', async () => {
    const server = makeServer();
    const created = (await (await server.handle(post({ input: 'x' }))).json()) as ResponseObject;

    const response = await server.handle(
      new Request(`http://localhost:8088/responses/${created.id}/cancel`, { method: 'POST' }),
    );
    expect(response.status).toBe(400);
  });

  it('continues a conversation through previous_response_id', async () => {
    const seenHistory: string[][] = [];
    const server = makeServer(async function* (_request, context) {
      seenHistory.push(context.history.map((item) => String(item.id)));
      yield { type: 'response.created', response: context.response };
      yield { type: 'response.in_progress', response: { ...context.response, status: 'in_progress' } };
      yield {
        type: 'response.output_item.done',
        item: { type: 'message', id: `out_${seenHistory.length}`, role: 'assistant' },
      };
      yield { type: 'response.completed', response: { ...context.response, status: 'completed' } };
    });

    const first = (await (
      await server.handle(post({ input: [{ type: 'message', id: 'in_1' }] }))
    ).json()) as ResponseObject;
    const second = (await (
      await server.handle(post({ input: [{ type: 'message', id: 'in_2' }], previous_response_id: first.id }))
    ).json()) as ResponseObject;

    // A new conversation starts empty; the follow-up replays the first turn's input *and* output.
    expect(seenHistory).toEqual([[], ['in_1', 'out_1']]);
    expect(second.output[0]?.id).toBe('out_2');
    // Both live in the same storage partition, which is what co-locates them in Foundry storage.
    expect(second.id.slice('caresp_'.length, 'caresp_'.length + 18)).toBe(
      first.id.slice('caresp_'.length, 'caresp_'.length + 18),
    );
  });

  it('rejects an unknown previous_response_id before the handler runs', async () => {
    let ran = false;
    const server = makeServer(async function* (_request, context) {
      ran = true;
      yield { type: 'response.completed', response: context.response };
    });
    const missing = `caresp_${'0'.repeat(18)}${'a'.repeat(32)}`;

    const response = await server.handle(post({ input: 'x', previous_response_id: missing }));

    expect(response.status).toBe(404);
    expect(ran).toBe(false);
  });
});

describe('cross-user isolation', () => {
  const alice = { [HEADERS.userId]: 'alice' };
  const mallory = { [HEADERS.userId]: 'mallory' };

  async function createFor(
    server: ResponsesServer,
    headers: Record<string, string>,
    body: Record<string, unknown> = { input: 'mine' },
  ): Promise<ResponseObject> {
    return (await (await server.handle(post(body, headers))).json()) as ResponseObject;
  }

  it('does not hand another user’s conversation to a new turn', async () => {
    const seenHistory: string[][] = [];
    const server = makeServer(async function* (_request, context) {
      seenHistory.push(context.history.map((item) => String(item.id)));
      yield { type: 'response.completed', response: { ...context.response, status: 'completed' } };
    });

    const mine = await createFor(server, alice, { input: [{ type: 'message', id: 'secret_1' }] });
    const stolen = await server.handle(post({ input: 'x', previous_response_id: mine.id }, mallory));

    // 404 rather than 403: whether the id exists is itself Alice's business.
    expect(stolen.status).toBe(404);
    expect(seenHistory).toEqual([[]]);
  });

  it('does not hand another user’s conversation over the conversation id', async () => {
    const seenHistory: string[][] = [];
    const server = makeServer(async function* (_request, context) {
      seenHistory.push(context.history.map((item) => String(item.id)));
      yield { type: 'response.completed', response: { ...context.response, status: 'completed' } };
    });

    await createFor(server, alice, {
      input: [{ type: 'message', id: 'secret_1' }],
      conversation: { id: `caresp_${'c'.repeat(18)}${'d'.repeat(32)}` },
    });
    const stolen = await server.handle(
      post({ input: 'x', conversation: { id: `caresp_${'c'.repeat(18)}${'d'.repeat(32)}` } }, mallory),
    );

    // A conversation id is caller-chosen, so guessing one must not replay someone else's turn —
    // and the refusal comes *before* the model runs, since the turn could never be stored under
    // that id anyway.
    expect(stolen.status).toBe(404);
    expect(seenHistory).toEqual([[]]);
  });

  it('refuses a reused response id before running the turn', async () => {
    let runs = 0;
    const server = makeServer(async function* (_request, context) {
      runs++;
      yield { type: 'response.completed', response: { ...context.response, status: 'completed' } };
    });

    const mine = await createFor(server, alice);
    const stolen = await server.handle(post({ input: 'x', response_id: mine.id }, mallory));

    // The 404 arrives without the handler having been entered: a reused id costs no model call.
    expect(stolen.status).toBe(404);
    expect(runs).toBe(1);
  });

  it('answers 404 for another user’s response, its input items and its deletion', async () => {
    const server = makeServer();
    const mine = await createFor(server, alice);

    const fetched = await server.handle(
      new Request(`http://localhost:8088/responses/${mine.id}`, { headers: mallory }),
    );
    const items = await server.handle(
      new Request(`http://localhost:8088/responses/${mine.id}/input_items`, { headers: mallory }),
    );
    const deleted = await server.handle(
      new Request(`http://localhost:8088/responses/${mine.id}`, { method: 'DELETE', headers: mallory }),
    );
    const cancelled = await server.handle(
      new Request(`http://localhost:8088/responses/${mine.id}/cancel`, { method: 'POST', headers: mallory }),
    );

    expect([fetched.status, items.status, deleted.status, cancelled.status]).toEqual([404, 404, 404, 404]);
    // Still Alice's.
    const own = await server.handle(
      new Request(`http://localhost:8088/responses/${mine.id}`, { headers: alice }),
    );
    expect(own.status).toBe(200);
  });

  it('refuses to overwrite another user’s response through a reused response_id', async () => {
    const server = makeServer();
    const mine = await createFor(server, alice);

    const overwritten = await server.handle(post({ input: 'theirs', response_id: mine.id }, mallory));
    expect(overwritten.status).toBe(404);

    const own = (await (
      await server.handle(new Request(`http://localhost:8088/responses/${mine.id}`, { headers: alice }))
    ).json()) as ResponseObject;
    expect(JSON.stringify(own.output)).toContain('Echo: mine');
  });
});

describe('route-level errors', () => {
  it('answers an unknown route with the standard envelope', async () => {
    const response = await makeServer().handle(new Request('http://localhost:8088/nope'));
    const body = (await response.json()) as { error: { additionalInfo: { request_id: string } } };

    expect(response.status).toBe(404);
    // The same envelope as every other error, so a platform log line has the same shape whatever
    // failed: source header, and the correlation id in the body.
    expect(response.headers.get(HEADERS.errorSource)).toBe('user');
    expect(body.error.additionalInfo.request_id).toBe(response.headers.get(HEADERS.requestId));
  });

  it('answers the wrong verb with 405, Allow, and the standard envelope', async () => {
    const response = await makeServer().handle(new Request('http://localhost:8088/responses'));

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(response.headers.get(HEADERS.errorSource)).toBe('user');
    expect(
      ((await response.json()) as { error: { additionalInfo: { request_id?: string } } }).error.additionalInfo
        .request_id,
    ).toBeDefined();
  });

  it('routes a slash-heavy path in linear time', async () => {
    // Trimming the trailing slash with `/\/+$/` rescans the run from every start position, so a
    // path made of slashes that does *not* end in one costs O(n²). At 100k characters the
    // backtracking alone runs for seconds, and an unauthenticated GET is enough to buy it.
    const request = new Request(`http://localhost:8088/${'/'.repeat(100_000)}a`);

    const started = performance.now();
    const response = await makeServer().handle(request);
    const elapsed = performance.now() - started;

    expect(response.status).toBe(404);
    expect(elapsed).toBeLessThan(500);
  });

  it('does not claim a path that merely starts with the prefix', async () => {
    const server = new ResponsesServer({ handler: echoHandler(), prefix: '/api' });

    expect((await server.handle(post({ input: 'x' }))).status).toBe(404);
    expect(
      (await server.handle(new Request('http://localhost:8088/apiary/responses', { method: 'POST' }))).status,
    ).toBe(404);
    expect(
      (
        await server.handle(
          new Request('http://localhost:8088/api/responses', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ input: 'x' }),
          }),
        )
      ).status,
    ).toBe(200);
  });

  it('answers a malformed percent-escape with 400 rather than an opaque 500', async () => {
    const response = await makeServer().handle(new Request('http://localhost:8088/responses/%E0%A4%A'));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_parameters');
  });

  it('rejects a path id that cannot be a storage key with 400, not a store-dependent error', async () => {
    const response = await makeServer().handle(new Request('http://localhost:8088/responses/..%2F..%2Fetc'));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_parameters');
    expect(JSON.stringify(body)).not.toContain('etc');
  });

  it('rejects a storage-safe but non-canonical response id on every response route', async () => {
    const server = makeServer();
    const routes = [
      new Request('http://localhost:8088/responses/not-a-response-id'),
      new Request('http://localhost:8088/responses/not-a-response-id/input_items'),
      new Request('http://localhost:8088/responses/not-a-response-id', { method: 'DELETE' }),
      new Request('http://localhost:8088/responses/not-a-response-id/cancel', { method: 'POST' }),
    ];

    for (const request of routes) {
      const response = await server.handle(request);
      expect(response.status).toBe(400);
      expect((await response.json()) as { error: { code: string; param: string } }).toMatchObject({
        error: { code: 'invalid_parameters', param: 'response_id' },
      });
    }
  });

  it('does not let extra path segments alias a known route', async () => {
    const server = makeServer();
    const created = (await (await server.handle(post({ input: 'x' }))).json()) as ResponseObject;

    const cancel = await server.handle(
      new Request(`http://localhost:8088/responses/${created.id}/cancel/extra`, { method: 'POST' }),
    );
    const items = await server.handle(
      new Request(`http://localhost:8088/responses/${created.id}/input_items/extra`),
    );

    expect(cancel.status).toBe(404);
    expect(items.status).toBe(404);
  });
});

describe('validation', () => {
  it('reports the offending parameter in the documented envelope', async () => {
    const response = await makeServer().handle(post({ input: 'x', background: true, store: false }));
    const body = (await response.json()) as { error: Record<string, unknown> };

    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({
      code: 'unsupported_parameter',
      message: 'background=true requires store=true',
      param: 'background',
    });
    // The `type` stays `invalid_request_error` however specific the `code` gets — Python's
    // `RequestValidationError` fixes it there for every validation failure.
    expect(body.error.type).toBe('invalid_request_error');
    expect(response.headers.get(HEADERS.errorSource)).toBe('user');
  });

  it('requires stream=true for stream_options', async () => {
    const response = await makeServer().handle(post({ input: 'x', stream_options: {} }));
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_mode');
  });

  it('rejects a malformed previous_response_id without echoing it back', async () => {
    const response = await makeServer().handle(post({ input: 'x', previous_response_id: '../../etc' }));
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_parameters');
    expect(body.error.message).toBe('Malformed identifier.');
    expect(JSON.stringify(body)).not.toContain('etc');
  });

  it('rejects a malformed client-chosen response_id', async () => {
    const response = await makeServer().handle(post({ input: 'x', response_id: '../../etc/passwd' }));
    const body = (await response.json()) as { error: { code: string; param: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_parameters');
    expect(body.error.param).toBe('response_id');
    expect(JSON.stringify(body)).not.toContain('passwd');
  });

  it('enforces the metadata limits', async () => {
    const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']));
    const response = await makeServer().handle(post({ input: 'x', metadata: tooMany }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { param: string } }).error.param).toBe('metadata');
  });

  it('rejects a non-object body', async () => {
    const response = await makeServer().handle(
      new Request('http://localhost:8088/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '"just a string"',
      }),
    );
    expect(response.status).toBe(400);
  });

  it('rejects mistyped fields with one 400 carrying field-level details', async () => {
    // `store: 0` is falsy but not `false` — without the schema pass, one code path would read it
    // as "don't store" and another as "store". `input: 42` would flow into the handler raw.
    const response = await makeServer().handle(post({ input: 42, store: 0, metadata: { a: 1 } }));
    const body = (await response.json()) as {
      error: { code: string; message: string; details: Array<{ code: string; param: string; type: string }> };
    };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toBe('request body failed schema validation');
    const params = body.error.details.map((d) => d.param);
    expect(params).toContain('$.input');
    expect(params).toContain('$.store');
    expect(params).toContain("$.metadata['a']");
    for (const detail of body.error.details) {
      expect(detail.code).toBe('invalid_value');
      // Detail entries carry their own `type`, always `invalid_request_error` (models/errors.py).
      expect(detail.type).toBe('invalid_request_error');
    }
  });

  it('rejects an input item without a type', async () => {
    const response = await makeServer().handle(post({ input: [{ id: 'no_type' }] }));
    const body = (await response.json()) as { error: { details: Array<{ param: string }> } };

    expect(response.status).toBe(400);
    expect(body.error.details.map((d) => d.param)).toContain('$.input[0]');
  });

  it('rejects a conversation id that cannot be a storage key', async () => {
    // With a file-backed store this id would otherwise become a path and die as an opaque 500 —
    // possibly only at persist time, after the handler ran.
    const response = await makeServer().handle(post({ input: 'x', conversation: { id: 'a/b' } }));
    const body = (await response.json()) as { error: { code: string; param: string; message: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_parameters');
    expect(body.error.param).toBe('conversation');
    expect(body.error.message).toBe('Malformed identifier.');
  });

  it('rejects an agent_session_id the response header could not carry', async () => {
    // The value is echoed on `x-agent-session-id`; a newline would make building the response
    // throw — a 500 after the handler already ran.
    const response = await makeServer().handle(post({ input: 'x', agent_session_id: 'abc\ndef' }));
    const body = (await response.json()) as { error: { code: string; param: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_parameters');
    expect(body.error.param).toBe('agent_session_id');
  });
});

describe('request limits', () => {
  it('answers 413 for a body over the configured bound, before the handler runs', async () => {
    let ran = false;
    const server = new ResponsesServer({
      handler: async function* (_request, context) {
        ran = true;
        yield { type: 'response.completed', response: context.response };
      },
      limits: { maxBodyBytes: 64 },
    });

    const response = await server.handle(post({ input: 'x'.repeat(500) }));

    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('request_too_large');
    expect(ran).toBe(false);
  });

  it('bounds the number of input items', async () => {
    const server = new ResponsesServer({ handler: echoHandler(), limits: { maxInputItems: 2 } });
    const items = Array.from({ length: 3 }, (_, i) => ({ type: 'message', id: `in_${i}` }));

    const response = await server.handle(post({ input: items }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { param: string } }).error.param).toBe('input');
  });
});

describe('SSE', () => {
  it('frames events and numbers them from zero without gaps', async () => {
    const response = await makeServer().handle(post({ input: 'Hi', stream: true }));

    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const events = await readSse(response);
    expect(events.map((e) => e.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.output_text.delta',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events.map((e) => e.data.sequence_number)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('names the SSE event after the event type', async () => {
    const events = await readSse(await makeServer().handle(post({ input: 'Hi', stream: true })));
    for (const { event, data } of events) {
      expect(data.type).toBe(event);
    }
  });

  it('does not let an event name break out of its own line', () => {
    // The name is written raw, so a newline in it would close the line and let whatever follows
    // be parsed as further SSE fields — a forged event, in the worst case.
    const encoded = encodeEvent({
      type: 'response.completed\ndata: {"forged":true}\n\nevent: response.failed',
    } as never);

    expect(encoded.split('\n').filter((line) => line.startsWith('event: '))).toHaveLength(1);
    expect(encoded.split('\n').filter((line) => line.startsWith('data: '))).toHaveLength(1);
  });
});

describe('lifecycle enforcement', () => {
  it('supplies created and in_progress for a handler that skips them', async () => {
    const violations: string[] = [];
    const server = new ResponsesServer({
      handler: async function* (_request, context) {
        yield { type: 'response.completed', response: { ...context.response, status: 'completed' } };
      },
      onViolation: (v) => violations.push(v.kind),
    });

    const events = await readSse(await server.handle(post({ input: 'x', stream: true })));

    expect(events.map((e) => e.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.completed',
    ]);
    expect(violations).toEqual(['missing_created', 'missing_in_progress']);
  });

  it('fails a response whose handler ends without a terminal event', async () => {
    const violations: string[] = [];
    const server = new ResponsesServer({
      handler: async function* (_request, context) {
        yield { type: 'response.created', response: context.response };
        yield { type: 'response.in_progress', response: { ...context.response, status: 'in_progress' } };
      },
      onViolation: (v) => violations.push(v.kind),
    });

    const events = await readSse(await server.handle(post({ input: 'x', stream: true })));

    expect(events.at(-1)?.event).toBe('response.failed');
    expect(violations).toEqual(['missing_terminal']);
  });

  it('emits exactly one terminal event', async () => {
    const violations: string[] = [];
    const server = new ResponsesServer({
      handler: async function* (_request, context) {
        yield { type: 'response.created', response: context.response };
        yield { type: 'response.in_progress', response: context.response };
        yield { type: 'response.completed', response: context.response };
        yield { type: 'response.failed', response: context.response };
        yield { type: 'response.output_text.delta', delta: 'late' };
      },
      onViolation: (v) => violations.push(v.kind),
    });

    const events = await readSse(await server.handle(post({ input: 'x', stream: true })));

    expect(events.filter((e) => e.event.startsWith('response.completed'))).toHaveLength(1);
    expect(events.map((e) => e.event)).not.toContain('response.failed');
    expect(violations).toEqual(['events_after_terminal', 'events_after_terminal']);
  });

  it('turns a handler exception into response.failed carrying the real message', async () => {
    const violations: Array<{ kind: string; detail?: string }> = [];
    const server = new ResponsesServer({
      handler: async function* (_request, context) {
        yield { type: 'response.created', response: context.response };
        yield { type: 'response.in_progress', response: context.response };
        throw new Error('the model deployment rejected the request');
      },
      onViolation: (v) => violations.push(v),
    });

    const events = await readSse(await server.handle(post({ input: 'x', stream: true })));
    const terminal = must(events.at(-1));

    // The caller already holds a 200 by now, so the terminal event is the only place it can learn
    // why the turn failed. Both hosting references surface the exception's own message there
    // (.NET `EmitFailed(ServerError, ex.Message)`, Python `str(ex) or type name`).
    expect(terminal.event).toBe('response.failed');
    expect((terminal.data.response as ResponseObject).error).toEqual({
      code: 'server_error',
      message: 'the model deployment rejected the request',
      type: 'server_error',
    });
    expect(violations[0]).toMatchObject({ kind: 'handler_error' });
  });

  it('falls back to the error name when the thrown message is empty', async () => {
    const server = new ResponsesServer({
      handler: async function* (_request, context) {
        yield { type: 'response.created', response: context.response };
        yield { type: 'response.in_progress', response: context.response };
        throw new RangeError('');
      },
    });

    const events = await readSse(await server.handle(post({ input: 'x', stream: true })));
    const terminal = must(events.at(-1));

    // Python's fallback: `str(ex) or type(ex).__name__`.
    expect((terminal.data.response as ResponseObject).error?.message).toBe('RangeError');
  });

  it('ends a cancelled turn as incomplete rather than failed', async () => {
    const violations: string[] = [];
    const server = new ResponsesServer({
      handler: async function* (_request, context) {
        yield { type: 'response.created', response: context.response };
        yield { type: 'response.in_progress', response: context.response };
        // What SIGTERM and a client hang-up both look like to a handler: the `DOMException` an
        // `AbortController` carries as its reason, which is also what the framework's providers
        // propagate for an interrupted model call. A hand-named `Error` would pass this test
        // while missing the shape that actually occurs.
        throw new DOMException('This operation was aborted', 'AbortError');
      },
      onViolation: (v) => violations.push(v.kind),
    });

    const events = await readSse(await server.handle(post({ input: 'x', stream: true })));
    const terminal = must(events.at(-1));

    // `failed` would tell the platform the agent broke, and invite a retry against a container
    // that is going away. The turn is unfinished, and resumable with previous_response_id.
    expect(terminal.event).toBe('response.incomplete');
    expect((terminal.data.response as ResponseObject).incomplete_details).toEqual({
      reason: 'interrupted',
    });
    expect(violations).toEqual(['aborted']);
  });

  it('records the same resource whether the caller streamed or not', async () => {
    const streamed = await readSse(await makeServer().handle(post({ input: 'Hi', stream: true })));
    const collected = (await (await makeServer().handle(post({ input: 'Hi' }))).json()) as ResponseObject;

    const final = streamed.at(-1)?.data.response as ResponseObject;
    expect(final.status).toBe(collected.status);
    expect(final.output).toEqual(collected.output);
  });
});

describe('header contract', () => {
  it('echoes the correlation id and identifies the server', async () => {
    const response = await makeServer().handle(post({ input: 'x' }, { [HEADERS.requestId]: 'req-123' }));

    expect(response.headers.get(HEADERS.requestId)).toBe('req-123');
    expect(response.headers.get(HEADERS.serverVersion)).toContain('protocol/responses-2.0.0');
  });

  it('mints a correlation id when the caller sent none', async () => {
    const response = await makeServer().handle(post({ input: 'x' }));
    expect(response.headers.get(HEADERS.requestId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns a session id that is stable for a conversation', async () => {
    const server = makeServer();

    const first = await server.handle(post({ input: 'x' }));
    const firstId = must(first.headers.get(HEADERS.sessionId));
    // A session id names the sandbox the turn runs in, so it must not be the response id — that
    // would send every turn of one conversation to a different filesystem.
    expect(firstId).toMatch(/^[0-9a-f]{63}$/);
    expect(firstId).not.toBe(((await first.json()) as ResponseObject).id);

    const conversation = { id: `caresp_${'e'.repeat(18)}${'f'.repeat(32)}` };
    const turnOne = await server.handle(post({ input: 'one', conversation }));
    const turnTwo = await server.handle(post({ input: 'two', conversation }));
    expect(turnTwo.headers.get(HEADERS.sessionId)).toBe(turnOne.headers.get(HEADERS.sessionId));
  });

  it('lets the caller pin the session id', async () => {
    const response = await makeServer().handle(post({ input: 'x', agent_session_id: 'trip-001' }));
    expect(response.headers.get(HEADERS.sessionId)).toBe('trip-001');
  });

  it('follows the platform-assigned session id when there is one', async () => {
    process.env.FOUNDRY_AGENT_SESSION_ID = 'platform-session';
    try {
      const created = await makeServer().handle(post({ input: 'x' }));
      expect(created.headers.get(HEADERS.sessionId)).toBe('platform-session');
      // Routes with no request body to derive from report the container's own session.
      const probe = await makeServer().handle(new Request('http://localhost:8088/readiness'));
      expect(probe.headers.get(HEADERS.sessionId)).toBe('platform-session');
    } finally {
      delete process.env.FOUNDRY_AGENT_SESSION_ID;
    }
  });

  it('lets the platform choose the response id', async () => {
    const chosen = `caresp_${'a'.repeat(18)}${'b'.repeat(32)}`;
    const response = await makeServer().handle(post({ input: 'x' }, { [HEADERS.responseId]: chosen }));

    expect(((await response.json()) as ResponseObject).id).toBe(chosen);
  });

  it('rejects a malformed response id chosen by the platform before the handler runs', async () => {
    let ran = false;
    const server = makeServer(async function* (_request, context) {
      ran = true;
      yield { type: 'response.completed', response: context.response };
    });

    const response = await server.handle(post({ input: 'x' }, { [HEADERS.responseId]: 'not-a-response-id' }));

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { code: string; param: string } }).toMatchObject({
      error: { code: 'invalid_parameters', param: HEADERS.responseId },
    });
    expect(ran).toBe(false);
  });

  it('ignores an empty platform response id and generates one', async () => {
    const response = await makeServer().handle(post({ input: 'x' }, { [HEADERS.responseId]: '' }));
    expect(((await response.json()) as ResponseObject).id).toMatch(/^caresp_/);
  });

  it('gives the handler the user id and the call id', async () => {
    let seen: { userId: string | undefined; callId: string | undefined } = {
      userId: undefined,
      callId: undefined,
    };
    const server = makeServer(async function* (_request, context) {
      seen = { userId: context.request.userId, callId: context.request.foundryCallId };
      yield { type: 'response.completed', response: context.response };
    });

    await server.handle(
      post({ input: 'x' }, { [HEADERS.userId]: 'user-1', [HEADERS.foundryCallId]: 'call-1' }),
    );

    expect(seen).toEqual({ userId: 'user-1', callId: 'call-1' });
  });

  it('forwards only the call id outbound, never the user id', async () => {
    let outbound: Record<string, string> = {};
    const server = makeServer(async function* (_request, context) {
      outbound = context.request.platformHeaders();
      yield { type: 'response.completed', response: context.response };
    });

    await server.handle(
      post({ input: 'x' }, { [HEADERS.userId]: 'user-1', [HEADERS.foundryCallId]: 'call-1' }),
    );

    expect(outbound).toEqual({ [HEADERS.foundryCallId]: 'call-1' });
    expect(outbound[HEADERS.userId]).toBeUndefined();
  });

  it('forwards the caller’s tracestate alongside its traceparent', async () => {
    // With no OTel SDK registered `propagation.inject` writes nothing and the inbound pair passes
    // through verbatim. W3C requires the two to travel together: a `traceparent` forwarded without
    // its `tracestate` silently drops every vendor's sampling and routing state at this hop.
    let outbound: Record<string, string> = {};
    const server = makeServer(async function* (_request, context) {
      outbound = context.request.platformHeaders();
      yield { type: 'response.completed', response: context.response };
    });

    await server.handle(
      post(
        { input: 'x' },
        {
          traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
          tracestate: 'vendor1=abc,vendor2=def',
        },
      ),
    );

    expect(outbound.traceparent).toBe('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
    expect(outbound.tracestate).toBe('vendor1=abc,vendor2=def');
  });

  it('sends no tracestate when the caller sent none', async () => {
    let outbound: Record<string, string> = {};
    const server = makeServer(async function* (_request, context) {
      outbound = context.request.platformHeaders();
      yield { type: 'response.completed', response: context.response };
    });

    await server.handle(
      post({ input: 'x' }, { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' }),
    );

    expect(outbound.tracestate).toBeUndefined();
  });
});

describe('protocol version fail-close', () => {
  it('refuses a hosted request with no call id', async () => {
    const response = await makeServer(echoHandler(), true).handle(
      post({ input: 'x' }, { [HEADERS.userId]: 'user-1' }),
    );
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(501);
    expect(body.error.code).toBe('unsupported_container_protocol_version');
    expect(response.headers.get(HEADERS.errorSource)).toBe('platform');
  });

  it('serves a hosted request that carries a call id', async () => {
    const response = await makeServer(echoHandler(), true).handle(
      post({ input: 'x' }, { [HEADERS.foundryCallId]: 'call-1' }),
    );
    expect(response.status).toBe(200);
  });

  it('does not require a call id outside a hosted environment', async () => {
    const response = await makeServer(echoHandler(), false).handle(post({ input: 'x' }));
    expect(response.status).toBe(200);
  });
});

describe('handler exceptions before streaming starts', () => {
  it('answers 500 with a fixed message, classified as an upstream failure', async () => {
    const server = new ResponsesServer({
      // Throws synchronously, before any event, so the response is still a plain HTTP error.
      handler: () => {
        throw new Error('Internal connection string: sk-secret');
      },
    });

    const response = await server.handle(post({ input: 'x' }));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body).error).toMatchObject({ code: 'server_error', message: 'internal server error' });
    expect(body).not.toContain('sk-secret');
    // An uncaught exception from the developer's handler is `upstream`, not `platform`
    // (PlatformHeaders.cs, _validation.error_response) — and the diagnostics header is reserved
    // for platform-source failures.
    expect(response.headers.get(HEADERS.errorSource)).toBe('upstream');
    expect(response.headers.get(HEADERS.errorDetail)).toBeNull();
  });

  it('classifies an async handler failure before the first event as upstream too', async () => {
    const server = new ResponsesServer({
      handler: async function* () {
        throw new Error('agent setup failed');
        // biome-ignore lint/correctness/noUnreachable: never runs; the yield only makes this function a generator
        yield { type: 'response.created' };
      },
    });

    const response = await server.handle(post({ input: 'x', stream: true }));

    expect(response.status).toBe(500);
    expect(response.headers.get(HEADERS.errorSource)).toBe('upstream');
  });

  it('keeps a ProtocolError thrown by the handler, including its own source', async () => {
    const server = new ResponsesServer({
      handler: async function* () {
        throw new ProtocolError(400, 'the platform did not identify the user', {
          code: 'missing_user_id',
          source: 'platform',
        });
        // biome-ignore lint/correctness/noUnreachable: never runs; the yield only makes this function a generator
        yield { type: 'response.created' };
      },
    });

    const response = await server.handle(post({ input: 'x' }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('missing_user_id');
    expect(response.headers.get(HEADERS.errorSource)).toBe('platform');
  });
});

describe('persistence failure', () => {
  class FailingPutProvider extends InMemoryResponseProvider {
    override async put(): Promise<void> {
      throw new Error('disk full: /var/secret/state');
    }
  }

  it('answers a non-streaming turn as failed with storage_error, not an opaque 500', async () => {
    const server = new ResponsesServer({ handler: echoHandler(), store: new FailingPutProvider() });

    const response = await server.handle(post({ input: 'x' }));
    const body = (await response.json()) as ResponseObject;

    // .NET's Persistence Failures contract: the handler finished, so the caller gets the resource
    // — marked failed, output cleared — and never the store's internals.
    expect(response.status).toBe(200);
    expect(body.status).toBe('failed');
    expect(body.error?.code).toBe('storage_error');
    expect(body.output).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('disk full');
  });

  it('replaces the streamed terminal event instead of delivering a completed that was never stored', async () => {
    const server = new ResponsesServer({ handler: echoHandler(), store: new FailingPutProvider() });

    const events = await readSse(await server.handle(post({ input: 'x', stream: true })));
    const terminal = must(events.at(-1));

    // Persist happens *before* the terminal goes out; a client that reads `response.completed`
    // must be able to come back with `previous_response_id`, and this one could not.
    expect(events.map((e) => e.event)).not.toContain('response.completed');
    expect(terminal.event).toBe('response.failed');
    const resource = terminal.data.response as ResponseObject;
    expect(resource.error?.code).toBe('storage_error');
    expect(JSON.stringify(terminal.data)).not.toContain('disk full');
  });

  it('does not report storage_error when the caller opted out of storage', async () => {
    const server = new ResponsesServer({ handler: echoHandler(), store: new FailingPutProvider() });

    const response = await server.handle(post({ input: 'x', store: false }));
    const body = (await response.json()) as ResponseObject;

    expect(response.status).toBe(200);
    expect(body.status).toBe('completed');
  });
});

describe('resource hygiene', () => {
  it('removes its abort listeners from the request signal once a non-streaming turn is over', async () => {
    const server = makeServer();
    const request = post({ input: 'x' });

    await (await server.handle(request)).text();

    // The same release covers the server's own shutdown signal — the listener that, left behind,
    // grows with every request served for the life of the container.
    expect(getEventListeners(request.signal, 'abort')).toHaveLength(0);
  });

  it('removes its abort listeners once a streamed turn is over', async () => {
    const server = makeServer();
    const request = post({ input: 'x', stream: true });

    await (await server.handle(request)).text();

    expect(getEventListeners(request.signal, 'abort')).toHaveLength(0);
  });

  it('removes its abort listeners when the handler fails before streaming starts', async () => {
    const server = new ResponsesServer({
      handler: () => {
        throw new Error('setup failed');
      },
    });
    const request = post({ input: 'x', stream: true });

    const response = await server.handle(request);

    expect(response.status).toBe(500);
    expect(getEventListeners(request.signal, 'abort')).toHaveLength(0);
  });
});

describe('a request that was already aborted when it arrived', () => {
  /** The documented well-behaved handler: it races the signal and rethrows its reason. */
  function abortAwareHandler(seen: { aborted: boolean[] }): ResponseHandler {
    return async function* (_request: CreateResponseRequest, context: HandlerContext) {
      seen.aborted.push(context.signal.aborted);
      const response = (status: ResponseObject['status']): ResponseObject => ({
        ...context.response,
        status,
      });
      yield { type: 'response.created', response: response('queued') };
      yield { type: 'response.in_progress', response: response('in_progress') };
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) {
          resolve();
          return;
        }
        context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      context.signal.throwIfAborted();
      yield { type: 'response.completed', response: response('completed') };
    };
  }

  function abortedPost(body: unknown): Request {
    return new Request('http://localhost:8088/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // Already aborted before the server ever sees it — the client hung up between writing the
      // request and this container routing it.
      signal: AbortSignal.abort(),
    });
  }

  it('hands the foreground handler an aborted signal, and ends the turn as incomplete', async () => {
    const seen = { aborted: [] as boolean[] };
    const server = makeServer(abortAwareHandler(seen));

    const response = await server.handle(abortedPost({ input: 'x' }));

    // `addEventListener` never fires for a signal that is already aborted, so the handler used to
    // be told the caller was still there and the turn was reported `completed`.
    expect(seen.aborted).toEqual([true]);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ResponseObject;
    expect(body.status).toBe('incomplete');
    expect(body.incomplete_details?.reason).toBe('interrupted');
  });

  it('keeps a background turn independent of the request that started it', async () => {
    const seen = { aborted: [] as boolean[] };
    const server = makeServer(async function* (_request, context) {
      seen.aborted.push(context.signal.aborted);
      const response = (status: ResponseObject['status']): ResponseObject => ({
        ...context.response,
        status,
      });
      yield { type: 'response.created', response: response('queued') };
      yield { type: 'response.in_progress', response: response('in_progress') };
      yield { type: 'response.completed', response: response('completed') };
    });

    const response = await server.handle(abortedPost({ input: 'x', background: true }));

    // A consumer disconnect must not cancel a background run, so the re-check must not
    // reach one either.
    expect(seen.aborted).toEqual([false]);
    expect(response.status).toBe(200);
  });
});

describe('input_items paging', () => {
  /** Five caller-supplied items with stable ids, the anchor for every cursor assertion. */
  const inputs = ['i1', 'i2', 'i3', 'i4', 'i5'].map((id) => ({
    type: 'message',
    id,
    role: 'user',
    content: [{ type: 'input_text', text: id }],
  }));

  async function pagedServer(): Promise<{ server: ResponsesServer; id: string }> {
    const server = makeServer();
    const created = await server.handle(post({ input: inputs }));
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as ResponseObject;
    return { server, id };
  }

  async function page(
    server: ResponsesServer,
    id: string,
    query: string,
  ): Promise<{
    status: number;
    ids: string[];
    first_id: string | null;
    last_id: string | null;
    has_more: boolean;
  }> {
    const response = await server.handle(
      new Request(`http://localhost:8088/responses/${id}/input_items${query}`),
    );
    const body = (await response.json()) as {
      data?: Array<{ id?: string }>;
      first_id?: string | null;
      last_id?: string | null;
      has_more?: boolean;
      error?: { param?: string | null; message?: string };
    };
    return {
      status: response.status,
      ids: (body.data ?? []).map((item) => item.id ?? ''),
      first_id: body.first_id ?? null,
      last_id: body.last_id ?? null,
      has_more: body.has_more ?? false,
    };
  }

  it('pages forward with after in both orders, with correct first/last/has_more', async () => {
    const { server, id } = await pagedServer();

    const ascFirst = await page(server, id, '?order=asc&limit=2');
    expect(ascFirst.ids).toEqual(['i1', 'i2']);
    expect(ascFirst.first_id).toBe('i1');
    expect(ascFirst.last_id).toBe('i2');
    expect(ascFirst.has_more).toBe(true);

    // Cursor identity is the id, not an index: the next page starts after `last_id`.
    const ascSecond = await page(server, id, '?order=asc&limit=2&after=i2');
    expect(ascSecond.ids).toEqual(['i3', 'i4']);
    expect(ascSecond.has_more).toBe(true);

    const ascLast = await page(server, id, '?order=asc&limit=2&after=i4');
    expect(ascLast.ids).toEqual(['i5']);
    expect(ascLast.has_more).toBe(false);

    const descFirst = await page(server, id, '?limit=2');
    expect(descFirst.ids).toEqual(['i5', 'i4']);
    expect(descFirst.first_id).toBe('i5');
    expect(descFirst.last_id).toBe('i4');
    expect(descFirst.has_more).toBe(true);

    const descSecond = await page(server, id, '?limit=2&after=i4');
    expect(descSecond.ids).toEqual(['i3', 'i2']);
    expect(descSecond.has_more).toBe(true);
  });

  it('bounds a page with before, applied after the after cursor', async () => {
    const { server, id } = await pagedServer();

    expect((await page(server, id, '?order=asc&before=i4')).ids).toEqual(['i1', 'i2', 'i3']);
    expect((await page(server, id, '?order=desc&before=i2')).ids).toEqual(['i5', 'i4', 'i3']);
    // Both cursors together bound an exclusive window, in the requested order.
    expect((await page(server, id, '?order=asc&after=i1&before=i5')).ids).toEqual(['i2', 'i3', 'i4']);
    // `has_more` reports the window, not the whole list.
    const windowed = await page(server, id, '?order=asc&before=i5&limit=2');
    expect(windowed.ids).toEqual(['i1', 'i2']);
    expect(windowed.has_more).toBe(true);
  });

  it('ignores an unknown cursor id, like the reference', async () => {
    const { server, id } = await pagedServer();

    // Python `_apply_item_cursors`: a cursor that matches nothing leaves the window unchanged.
    expect((await page(server, id, '?order=asc&after=zzz')).ids).toEqual(['i1', 'i2', 'i3', 'i4', 'i5']);
    expect((await page(server, id, '?order=asc&before=zzz')).ids).toEqual(['i1', 'i2', 'i3', 'i4', 'i5']);
  });

  it('answers an empty page with null ids and has_more false', async () => {
    const { server, id } = await pagedServer();

    const empty = await page(server, id, '?order=asc&after=i5');
    expect(empty.ids).toEqual([]);
    expect(empty.first_id).toBeNull();
    expect(empty.last_id).toBeNull();
    expect(empty.has_more).toBe(false);
  });

  it('rejects a malformed limit and order with the reference messages', async () => {
    const { server, id } = await pagedServer();

    const notInteger = await server.handle(
      new Request(`http://localhost:8088/responses/${id}/input_items?limit=abc`),
    );
    expect(notInteger.status).toBe(400);
    expect(((await notInteger.json()) as { error: { message: string; param: string } }).error).toMatchObject({
      message: 'limit must be an integer between 1 and 100',
      param: 'limit',
    });

    // `parseInt`'s partial parse must not accept what Python's `int()` refuses.
    const partial = await server.handle(
      new Request(`http://localhost:8088/responses/${id}/input_items?limit=12abc`),
    );
    expect(partial.status).toBe(400);

    for (const bad of ['0', '101']) {
      const outOfRange = await server.handle(
        new Request(`http://localhost:8088/responses/${id}/input_items?limit=${bad}`),
      );
      expect(outOfRange.status).toBe(400);
      expect(((await outOfRange.json()) as { error: { message: string } }).error.message).toBe(
        'limit must be between 1 and 100',
      );
    }

    const badOrder = await server.handle(
      new Request(`http://localhost:8088/responses/${id}/input_items?order=sideways`),
    );
    expect(badOrder.status).toBe(400);
    expect(((await badOrder.json()) as { error: { param: string } }).error.param).toBe('order');
  });
});

describe('draining', () => {
  let server: ResponsesServer;

  beforeEach(() => {
    server = makeServer();
  });

  afterEach(() => {
    void server.drain();
  });

  it('rejects new work while draining but keeps answering the probe', async () => {
    void server.drain();

    const rejected = await server.handle(post({ input: 'x' }));
    expect(rejected.status).toBe(503);

    const probe = await server.handle(new Request('http://localhost:8088/readiness'));
    expect(probe.status).toBe(200);
  });
});
