import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccessToken, TokenCredential } from '@azure/identity';
import type { ResponseObject } from '@polymind-inc/agent-framework-agentserver';
import {
  createRequestContext,
  HEADERS,
  runWithRequestContext,
} from '@polymind-inc/agent-framework-agentserver';
import { ConfigurationError } from '@polymind-inc/agent-framework-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundryProject } from '../project.js';
import { FoundryResponseStore } from './response-store.js';
import { defaultStore } from './server.js';

const PROJECT = 'https://my-resource.services.ai.azure.com/api/projects/my-project';

const credential: TokenCredential = {
  async getToken(): Promise<AccessToken> {
    return { token: 'mi-token', expiresOnTimestamp: Date.now() + 3_600_000 };
  },
};

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** The Response object this call was answered with, absent when the call threw. */
  reply?: Response;
}

/** One shared scratch directory per test file run; each store() call gets its own subdirectory. */
const replayScratch = await mkdtemp(join(tmpdir(), 'afjs-replay-'));
let replayDirCount = 0;

/** A store whose every request is recorded, with scripted replies. */
function store(
  replies: Array<{ status?: number; body?: unknown; networkError?: boolean }>,
  options: { credential?: TokenCredential; forwardCallId?: boolean; replayRoot?: string } = {},
): {
  store: FoundryResponseStore;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(url),
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = replies[Math.min(index, replies.length - 1)] ?? { status: 200 };
    index++;
    if (reply.networkError === true) {
      throw new TypeError('fetch failed');
    }
    call.reply = new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      ...(reply.body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
    });
    return call.reply;
  }) as typeof globalThis.fetch;

  return {
    store: new FoundryResponseStore({
      project: new FoundryProject(PROJECT, options.credential ?? credential),
      fetch: fetchStub,
      replayRoot: options.replayRoot ?? join(replayScratch, `store-${replayDirCount++}`),
      retry: { baseDelayMs: 0 },
      ...(options.forwardCallId === undefined ? {} : { forwardCallId: options.forwardCallId }),
    }),
    calls,
  };
}

function response(id = 'caresp_1'): ResponseObject {
  return { id, object: 'response', created_at: 0, status: 'completed', output: [] };
}

/** Runs `fn` as though it were serving a platform request. */
async function asPlatformRequest<T>(headers: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext(createRequestContext(new Headers(headers)), fn);
}

// The write path stamps the agent identity from the environment when the response carries none, so
// a developer shell configured for a real agent must not leak into the assertions below.
const savedAgentEnv = {
  name: process.env.FOUNDRY_AGENT_NAME,
  version: process.env.FOUNDRY_AGENT_VERSION,
};
beforeEach(() => {
  delete process.env.FOUNDRY_AGENT_NAME;
  delete process.env.FOUNDRY_AGENT_VERSION;
});
afterEach(() => {
  if (savedAgentEnv.name !== undefined) process.env.FOUNDRY_AGENT_NAME = savedAgentEnv.name;
  if (savedAgentEnv.version !== undefined) process.env.FOUNDRY_AGENT_VERSION = savedAgentEnv.version;
});

/** The reference the store stamps when neither the response nor the environment names an agent. */
const DEFAULT_REFERENCE = { type: 'agent_reference', name: 'server-default-agent' };

/** The `agent_reference` a recorded create actually sent. */
function sentReference(call: Call | undefined): unknown {
  return (call?.body as { response?: ResponseObject } | undefined)?.response?.agent_reference;
}

describe('FoundryResponseStore', () => {
  it('builds the storage URL from the project endpoint', () => {
    const { store: subject } = store([]);
    expect(subject.baseUrl).toBe(`${PROJECT}/storage/`);
  });

  it('refuses a relative endpoint at construction rather than failing on the first request', () => {
    // A misconfigured endpoint should surface where it was configured, not as a broken URL on the
    // first storage call.
    expect(() => new FoundryProject('/api/projects/p', credential)).toThrow(ConfigurationError);
  });

  it('uses the routes and verbs the service defines', async () => {
    const { store: subject, calls } = store([{ status: 200 }]);

    await subject.put({ response: response(), inputItems: [{ type: 'message', id: 'in_1' }] });

    // Create is `POST responses`, not a PUT on the id.
    expect(calls[0]).toMatchObject({ method: 'POST' });
    expect(calls[0]?.url).toBe(`${PROJECT}/storage/responses?api-version=v1`);
    // Both lists are always present, empty included, matching the reference serializer. The
    // response gains the agent reference the service requires on every write.
    expect(calls[0]?.body).toEqual({
      response: { ...response(), agent_reference: DEFAULT_REFERENCE },
      input_items: [{ type: 'message', id: 'in_1' }],
      history_item_ids: [],
    });
  });

  it('sends the create envelope even when there are no input items', async () => {
    const { store: subject, calls } = store([{ status: 200 }]);

    await subject.put({ response: response() });

    expect(calls[0]?.body).toEqual({
      response: { ...response(), agent_reference: DEFAULT_REFERENCE },
      input_items: [],
      history_item_ids: [],
    });
  });

  it('falls back to an update when the response already exists', async () => {
    const { store: subject, calls } = store([{ status: 409 }, { status: 200 }]);

    await subject.put({ response: response() });

    expect(calls.map((c) => c.url)).toEqual([
      `${PROJECT}/storage/responses?api-version=v1`,
      `${PROJECT}/storage/responses/caresp_1?api-version=v1`,
    ]);
    // The update carries the response itself, not the create envelope — with the same stamp,
    // because the service validates the agent reference on updates too.
    expect(calls[1]?.body).toEqual({ ...response(), agent_reference: DEFAULT_REFERENCE });
  });

  it('falls back to an update when the conflict arrives as a 400 with a conflict code', async () => {
    // The service expresses duplicate-create as either status; the reference's `_is_conflict`
    // (`store/_foundry_provider.py`) reads the body, not the status line.
    const { store: subject, calls } = store([
      { status: 400, body: { error: { code: 'already_exists', message: 'nope' } } },
      { status: 200 },
    ]);

    await subject.put({ response: response() });

    expect(calls.map((c) => c.url)).toEqual([
      `${PROJECT}/storage/responses?api-version=v1`,
      `${PROJECT}/storage/responses/caresp_1?api-version=v1`,
    ]);
  });

  it('falls back to an update when a 400 says the response already exists', async () => {
    const { store: subject, calls } = store([
      {
        status: 400,
        body: { error: { code: 'invalid_request', message: 'Response caresp_1 already exists.' } },
      },
      { status: 200 },
    ]);

    await subject.put({ response: response() });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(`${PROJECT}/storage/responses/caresp_1?api-version=v1`);
  });

  it('still raises on a 400 that is a genuine bad request', async () => {
    const { store: subject, calls } = store([
      { status: 400, body: { error: { code: 'invalid_payload', message: 'Invalid payload' } } },
    ]);

    await expect(subject.put({ response: response() })).rejects.toThrow(/returned 400/);
    // No blind update retry: a malformed create must not turn into a write on the id.
    expect(calls).toHaveLength(1);
  });

  it('treats an unparseable 400 body as a bad request, not a conflict', async () => {
    const { store: subject, calls } = store([{ status: 400 }]);

    await expect(subject.put({ response: response() })).rejects.toThrow(/returned 400/);
    expect(calls).toHaveLength(1);
  });

  it('reads a response and its input items', async () => {
    const { store: subject, calls } = store([
      { status: 200, body: response() },
      { status: 200, body: { object: 'list', data: [{ type: 'message', id: 'in_1' }] } },
    ]);

    const stored = await subject.get('caresp_1', 'alice');

    expect(stored?.response.id).toBe('caresp_1');
    expect(stored?.inputItems).toEqual([{ type: 'message', id: 'in_1' }]);
    expect(calls[1]?.url).toContain('/responses/caresp_1/input_items?');
  });

  it('reports a missing response as undefined rather than an error', async () => {
    const { store: subject } = store([{ status: 404 }]);
    expect(await subject.get('caresp_missing', 'alice')).toBeUndefined();
  });

  it('reports a missing response as not deleted', async () => {
    const { store: subject } = store([{ status: 404 }]);
    expect(await subject.delete('caresp_missing', 'alice')).toBe(false);
  });

  it('raises on a storage failure rather than losing the conversation silently', async () => {
    const { store: subject } = store([{ status: 500 }]);
    await expect(subject.put({ response: response() })).rejects.toThrow(/returned 500/);
  });

  it('follows the input_items pagination cursor instead of truncating at one page', async () => {
    // A long conversation's transcript exceeds one page; stopping after the first would silently
    // hand the model a truncated history.
    const { store: subject, calls } = store([
      { status: 200, body: response() },
      {
        status: 200,
        body: {
          object: 'list',
          data: [
            { type: 'message', id: 'in_1' },
            { type: 'message', id: 'in_2' },
          ],
          has_more: true,
          last_id: 'in_2',
        },
      },
      {
        status: 200,
        body: { object: 'list', data: [{ type: 'message', id: 'in_3' }], has_more: false, last_id: 'in_3' },
      },
    ]);

    const stored = await subject.get('caresp_1', 'alice');

    expect(stored?.inputItems?.map((item) => item.id)).toEqual(['in_1', 'in_2', 'in_3']);
    // The second page picks up after the first page's cursor.
    expect(calls[2]?.url).toContain('after=in_2');
  });

  it('raises when an input_items page fails rather than passing off a short transcript', async () => {
    const { store: subject } = store([{ status: 200, body: response() }, { status: 503 }]);
    await expect(subject.get('caresp_1', 'alice')).rejects.toThrow(/input_items/);
  });

  it('assembles the transcript from the input items and the output', async () => {
    const answered: ResponseObject = { ...response(), output: [{ type: 'message', id: 'out_1' }] };
    const { store: subject } = store([
      { status: 200, body: answered },
      { status: 200, body: { object: 'list', data: [{ type: 'message', id: 'in_1' }] } },
    ]);

    expect(await subject.history('caresp_1', 'alice')).toEqual([
      { type: 'message', id: 'in_1' },
      { type: 'message', id: 'out_1' },
    ]);
  });
});

describe('FoundryResponseStore request headers', () => {
  it('sends the managed-identity token and forwards the call id', async () => {
    const { store: subject, calls } = store([{ status: 200 }]);

    await asPlatformRequest({ [HEADERS.foundryCallId]: 'call-1', [HEADERS.userId]: 'alice' }, () =>
      subject.put({ response: response() }),
    );

    expect(calls[0]?.headers.authorization).toBe('Bearer mi-token');
    expect(calls[0]?.headers[HEADERS.foundryCallId]).toBe('call-1');
  });

  it('can withhold the call id, the way Python’s storage pipeline does', async () => {
    // The references disagree; measured against a live project the header changes nothing, so
    // this is an option rather than a behaviour change.
    const { store: subject, calls } = store([{ status: 200 }], { forwardCallId: false });

    await asPlatformRequest({ [HEADERS.foundryCallId]: 'call-1' }, () =>
      subject.put({ response: response() }),
    );

    expect(calls[0]?.headers.authorization).toBe('Bearer mi-token');
    expect(calls[0]?.headers[HEADERS.foundryCallId]).toBeUndefined();
  });

  it('never forwards the end user id to the storage service', async () => {
    const { store: subject, calls } = store([{ status: 200 }]);

    await asPlatformRequest({ [HEADERS.foundryCallId]: 'call-1', [HEADERS.userId]: 'alice' }, () =>
      subject.put({ response: response() }),
    );

    // The user id is a global cross-agent identifier; the service partitions from the call id.
    expect(calls[0]?.headers[HEADERS.userId]).toBeUndefined();
    expect(JSON.stringify(calls[0])).not.toContain('alice');
  });

  it('takes the call id from the request in flight, not from construction', async () => {
    const { store: subject, calls } = store([{ status: 200 }, { status: 200 }]);

    await asPlatformRequest({ [HEADERS.foundryCallId]: 'call-1' }, () =>
      subject.put({ response: response('caresp_1') }),
    );
    await asPlatformRequest({ [HEADERS.foundryCallId]: 'call-2' }, () =>
      subject.put({ response: response('caresp_2') }),
    );

    // One long-lived store serves many requests; a captured call id would mis-attribute the second.
    expect(calls.map((c) => c.headers[HEADERS.foundryCallId])).toEqual(['call-1', 'call-2']);
  });

  it('works outside a request context, with no platform headers to add', async () => {
    const { store: subject, calls } = store([{ status: 200 }]);

    await subject.put({ response: response() });

    expect(calls[0]?.headers.authorization).toBe('Bearer mi-token');
    expect(calls[0]?.headers[HEADERS.foundryCallId]).toBeUndefined();
  });
});

describe('default store selection', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('keeps a local run in memory', () => {
    expect(defaultStore(false).constructor.name).toBe('InMemoryResponseProvider');
  });

  it('activates the Foundry storage service in a container, the way Python does', () => {
    process.env.FOUNDRY_PROJECT_ENDPOINT = PROJECT;
    process.env.FOUNDRY_AGENT_NAME = 'weather-agent';
    process.env.FOUNDRY_AGENT_VERSION = '1';

    expect(defaultStore(true).constructor.name).toBe('FoundryResponseStore');
  });

  it('activates it on the project endpoint alone — the agent identity has a default', () => {
    process.env.FOUNDRY_PROJECT_ENDPOINT = PROJECT;
    delete process.env.FOUNDRY_AGENT_NAME;
    delete process.env.FOUNDRY_AGENT_VERSION;

    expect(defaultStore(true).constructor.name).toBe('FoundryResponseStore');
  });

  it('falls back to the sandbox filesystem when a hosted container has no endpoint', () => {
    // Should not happen — the platform injects FOUNDRY_PROJECT_ENDPOINT — but a misconfigured
    // container serving turns off its sandbox beats one that cannot start.
    delete process.env.FOUNDRY_PROJECT_ENDPOINT;

    expect(defaultStore(true).constructor.name).toBe('FileResponseProvider');
  });
});

describe('agent reference stamping', () => {
  // The storage service validates that every create and update carries an agent reference with a
  // non-empty name, and rejects one without it as an opaque 500 (measured against a live project
  // from inside a hosted container). The store therefore never sends a response without one.

  it('stamps the environment agent identity onto a response that lacks one', async () => {
    process.env.FOUNDRY_AGENT_NAME = 'weather-agent';
    process.env.FOUNDRY_AGENT_VERSION = '3';
    const { store: subject, calls } = store([{ status: 201 }]);

    await subject.put({ response: response() });

    expect(sentReference(calls[0])).toEqual({
      type: 'agent_reference',
      name: 'weather-agent',
      version: '3',
    });
  });

  it('falls back to the default agent name when the environment has none', async () => {
    const { store: subject, calls } = store([{ status: 201 }]);

    await subject.put({ response: response() });

    expect(sentReference(calls[0])).toEqual(DEFAULT_REFERENCE);
  });

  it('passes a caller-supplied agent reference through unchanged', async () => {
    process.env.FOUNDRY_AGENT_NAME = 'weather-agent';
    const { store: subject, calls } = store([{ status: 201 }]);
    const supplied = { type: 'agent_reference' as const, name: 'router-agent', version: '2' };

    await subject.put({ response: { ...response(), agent_reference: supplied } });

    expect(sentReference(calls[0])).toEqual(supplied);
  });

  it('normalizes a malformed discriminator from a direct caller', async () => {
    const { store: subject, calls } = store([{ status: 201 }]);

    await subject.put({
      response: {
        ...response(),
        agent_reference: { type: 'other', name: 'router' } as never,
      },
    });

    expect(sentReference(calls[0])).toEqual({ type: 'agent_reference', name: 'router' });
  });

  it('treats a blank agent name as absent rather than sending it to fail', async () => {
    const { store: subject, calls } = store([{ status: 201 }]);

    await subject.put({
      response: { ...response(), agent_reference: { type: 'agent_reference', name: '  ' } },
    });

    expect(sentReference(calls[0])).toEqual(DEFAULT_REFERENCE);
  });
});

describe('history references', () => {
  it('sends already-stored items as references and only new ones as input items', async () => {
    // Re-sending a stored item under its own id makes the create fail with an "already exists"
    // body that masquerades as a duplicate create (measured live); the split is the fix.
    const { store: subject, calls } = store([{ status: 201 }]);

    await subject.put({
      response: response(),
      inputItems: [
        { type: 'message', id: 'msg_old1' },
        { type: 'message', id: 'msg_old2' },
        { type: 'message', id: 'msg_new1' },
      ],
      historyItemIds: ['msg_old1', 'msg_old2'],
    });

    expect(calls[0]?.body).toMatchObject({
      input_items: [{ type: 'message', id: 'msg_new1' }],
      history_item_ids: ['msg_old1', 'msg_old2'],
    });
  });

  it('surfaces the create failure when the conflict reading proves wrong', async () => {
    // A duplicate-*item* failure arrives dressed as a duplicate create; the update fallback then
    // 404s because nothing exists under the id. The create's own answer is the diagnostic — a
    // bare 404 would point at the wrong problem entirely.
    const { store: subject, calls } = store([
      { status: 400, body: { error: { code: 'invalid_request', message: 'Item msg_1 already exists.' } } },
      { status: 404, body: { error: { code: 'not_found', message: 'Response caresp_1 not found.' } } },
    ]);

    await expect(subject.put({ response: response() })).rejects.toThrow(/returned 400.*already exists/s);
    expect(calls).toHaveLength(2);
  });

  it('resolves a conversation id through the service linkage without trying it as a response', async () => {
    // A conversation-shaped id goes straight to the linkage routes: no alias record exists, so a
    // `GET responses/{id}` first would be a guaranteed miss on every conversation turn.
    const { store: subject, calls } = store([
      { status: 200, body: ['msg_1', 'msg_2'] },
      {
        status: 200,
        body: [{ type: 'message', id: 'msg_1' }, null, { type: 'message', id: 'msg_2' }],
      },
    ]);

    const items = await subject.history('caconv_1', 'alice');

    expect(items?.map((item) => item.id)).toEqual(['msg_1', 'msg_2']);
    expect(calls[0]?.url).toContain('history/item_ids?');
    expect(calls[0]?.url).toContain('conversation_id=caconv_1');
    expect(calls[1]?.url).toContain('items/batch/retrieve');
    expect(calls[1]?.body).toEqual({ item_ids: ['msg_1', 'msg_2'] });
  });

  it('reports an unknown conversation as absent', async () => {
    const { store: subject } = store([{ status: 404 }, { status: 404 }]);
    expect(await subject.history('caconv_missing', 'alice')).toBeUndefined();
  });
});

describe('write reconciliation', () => {
  it('treats a retried create whose first attempt actually landed as success', async () => {
    // The first POST persists server-side but the connection drops before the answer arrives.
    // The retry then reads as a duplicate, the update fallback is refused because the stored
    // response is already terminal — and yet the service holds exactly what we wrote. That is
    // success, not a storage error.
    const { store: subject, calls } = store([
      { networkError: true },
      { status: 409, body: { error: { code: 'conflict', message: 'already exists' } } },
      {
        status: 400,
        body: { error: { code: 'bad_request', message: 'terminal state: Completed' } },
      },
      { status: 200, body: response() },
    ]);

    await expect(subject.put({ response: response() })).resolves.toBeUndefined();
    // create (failed) → create (conflict) → update (refused) → reconciling GET.
    expect(calls).toHaveLength(4);
    expect(calls[3]).toMatchObject({ method: 'GET' });
  });

  it('does not mistake another turn under the same id for a retried success', async () => {
    // A clean conflict — no ambiguous failure preceded it — is an id collision, not a lost
    // answer. Reconciliation must not even be attempted: a stored response that happens to share
    // the status would otherwise be claimed as this write's outcome.
    const { store: subject, calls } = store([
      { status: 409, body: { error: { code: 'conflict', message: 'already exists' } } },
      {
        status: 400,
        body: { error: { code: 'bad_request', message: 'terminal state: Completed' } },
      },
    ]);

    await expect(subject.put({ response: response() })).rejects.toThrow(/returned 400/);
    // No reconciling GET: create (conflict) → update (refused) → failure.
    expect(calls).toHaveLength(2);
  });

  it('still fails when the stored outcome is not the one this write described', async () => {
    // The ambiguity is real, but what the service holds is a *different* completed turn — same
    // status, different output. Claiming it as ours would leave the service holding the other
    // turn while this caller believes its own was stored.
    const { store: subject } = store([
      { networkError: true },
      { status: 409, body: { error: { code: 'conflict', message: 'already exists' } } },
      {
        status: 400,
        body: { error: { code: 'bad_request', message: 'terminal state: Completed' } },
      },
      {
        status: 200,
        body: { ...response(), output: [{ type: 'message', id: 'msg_other' }] },
      },
    ]);

    await expect(subject.put({ response: response() })).rejects.toThrow(/returned 400/);
  });
});

describe('replay mirror integrity', () => {
  it('keeps the generation when the service still holds this turn, output included', async () => {
    const terminal = { ...response(), output: [{ type: 'message', id: 'msg_1' }] };
    const { store: subject } = store([
      { status: 201 },
      { status: 200, body: terminal },
      { status: 200, body: { object: 'list', data: [] } },
    ]);

    await subject.put({ response: terminal, userId: 'alice', generation: 'gen-1' });

    expect((await subject.get('caresp_1', 'alice'))?.generation).toBe('gen-1');
  });

  it('does not pair a stale log with a reused id even inside one second', async () => {
    // `created_at` is whole-second, so a delete-and-recreate can land on the same value. The
    // output item ids cannot collide — the service rejects a duplicate item id outright — so
    // they are the identity that survives the tie.
    const oldTurn = { ...response(), output: [{ type: 'message', id: 'msg_old' }] };
    const newTurn = { ...response(), output: [{ type: 'message', id: 'msg_new' }] };
    const { store: subject } = store([
      { status: 201 },
      { status: 200, body: newTurn },
      { status: 200, body: { object: 'list', data: [] } },
    ]);

    await subject.put({ response: oldTurn, userId: 'alice', generation: 'gen-old' });
    await subject.putEvents('caresp_1', 'alice', [{ type: 'response.created' }], 'gen-old');

    const stored = await subject.get('caresp_1', 'alice');
    expect(stored?.generation).toBeUndefined();
  });

  it('serves the remote response when the mirror record is unreadable', async () => {
    const replayRoot = join(replayScratch, `corrupt-${replayDirCount++}`);
    await mkdir(replayRoot, { recursive: true });
    await writeFile(join(replayRoot, 'caresp_1.json'), '{not json');
    const { store: subject } = store(
      [
        { status: 200, body: response() },
        { status: 200, body: { object: 'list', data: [] } },
      ],
      { replayRoot },
    );

    const stored = await subject.get('caresp_1', 'alice');

    expect(stored?.response.id).toBe('caresp_1');
    expect(stored?.generation).toBeUndefined();
  });

  it('answers replay as unavailable when the events log is unreadable', async () => {
    const replayRoot = join(replayScratch, `corrupt-events-${replayDirCount++}`);
    await mkdir(join(replayRoot, 'events'), { recursive: true });
    await writeFile(join(replayRoot, 'events', 'caresp_1.json'), '{not json');
    const { store: subject } = store([{ status: 201 }], { replayRoot });

    await subject.put({ response: response(), userId: 'alice', generation: 'gen-1' });

    expect(await subject.getEvents('caresp_1', 'alice', 'gen-1')).toBeUndefined();
  });

  it('keeps a remote delete a success when the mirror cannot be cleaned', async () => {
    const blockedRoot = join(replayScratch, `blocked-del-${replayDirCount++}`);
    await writeFile(blockedRoot, 'a file where the directory should be');
    const { store: subject } = store([{ status: 204 }], { replayRoot: blockedRoot });

    await expect(subject.delete('caresp_1', 'alice')).resolves.toBe(true);
  });

  it('does not attach a stale generation to a response the service replaced', async () => {
    // Another sandbox deleted the id and reused it for a new turn; this sandbox's mirror still
    // holds the old turn. The service response and the mirror no longer describe the same turn,
    // so the generation must not transfer — otherwise the old events replay as the new stream.
    const { store: subject } = store([
      { status: 201 },
      // The service now answers with a *different* turn under the same id.
      { status: 200, body: { ...response(), created_at: 999 } },
      { status: 200, body: { object: 'list', data: [] } },
    ]);

    await subject.put({ response: response(), userId: 'alice', generation: 'gen-old' });
    await subject.putEvents('caresp_1', 'alice', [{ type: 'response.created' }], 'gen-old');

    const stored = await subject.get('caresp_1', 'alice');
    expect(stored?.generation).toBeUndefined();
  });

  it('keeps remote persistence a success when the local mirror cannot be written', async () => {
    // The mirror is auxiliary: replay becomes unavailable (fail closed), but the response is
    // durably stored and the turn must not be reported as a storage failure.
    const blockedRoot = join(replayScratch, `blocked-${replayDirCount++}`);
    await writeFile(blockedRoot, 'a file where the directory should be');
    const { store: subject } = store(
      [
        { status: 201 },
        { status: 200, body: response() },
        { status: 200, body: { object: 'list', data: [] } },
      ],
      { replayRoot: blockedRoot },
    );

    await expect(
      subject.put({ response: response(), userId: 'alice', generation: 'gen-1' }),
    ).resolves.toBeUndefined();
    expect(await subject.getEvents('caresp_1', 'alice', 'gen-1')).toBeUndefined();
  });
});

describe('bounded retry', () => {
  it('retries a transient credential failure before sending the request', async () => {
    let tokenAttempts = 0;
    const transientCredential: TokenCredential = {
      async getToken(): Promise<AccessToken> {
        tokenAttempts++;
        if (tokenAttempts === 1) throw new Error('credential temporarily unavailable');
        return { token: 'refreshed-token', expiresOnTimestamp: Date.now() + 3_600_000 };
      },
    };
    const { store: subject, calls } = store([{ status: 201 }], { credential: transientCredential });

    await subject.put({ response: response() });

    expect(tokenAttempts).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.authorization).toBe('Bearer refreshed-token');
  });

  it('retries a transient failure and succeeds', async () => {
    const { store: subject, calls } = store([{ status: 503 }, { status: 201 }]);

    await subject.put({ response: response() });

    expect(calls).toHaveLength(2);
  });

  it('retries with no timer at all when baseDelayMs is 0', async () => {
    // "Zero base delay" means no waiting — not even a zero-millisecond timer task, which is why
    // this runs under fake timers that are never advanced.
    vi.useFakeTimers();
    try {
      const { store: subject, calls } = store([{ status: 503 }, { status: 201 }]);

      await subject.put({ response: response() });

      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the attempt budget and surfaces the last failure', async () => {
    const { store: subject, calls } = store([{ status: 503 }]);

    await expect(subject.put({ response: response() })).rejects.toThrow(/returned 503/);
    expect(calls).toHaveLength(3);
  });

  it('does not retry a genuine bad request', async () => {
    const { store: subject, calls } = store([
      { status: 400, body: { error: { code: 'invalid_payload', message: 'Invalid payload' } } },
    ]);

    await expect(subject.put({ response: response() })).rejects.toThrow(/returned 400/);
    expect(calls).toHaveLength(1);
  });

  it('cancels the body of a response it discards for a retry', async () => {
    // An unconsumed body keeps its connection busy in undici; a reply the loop moves past must
    // release it rather than leave that to GC.
    const { store: subject, calls } = store([
      { status: 503, body: { error: { code: 'server_error', message: 'busy' } } },
      { status: 201 },
    ]);

    await subject.put({ response: response() });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.reply?.bodyUsed).toBe(true);
  });

  it('retries reads as well as writes', async () => {
    const { store: subject, calls } = store([
      { status: 502 },
      { status: 200, body: response() },
      { status: 200, body: { object: 'list', data: [] } },
    ]);

    const stored = await subject.get('caresp_1', 'alice');

    expect(stored?.response.id).toBe('caresp_1');
    expect(calls).toHaveLength(3);
  });
});

describe('local replay log', () => {
  // Foundry storage has no events route — the current reference (Python agentserver 2.0.0) keeps
  // stream events on the sandbox filesystem and only the response resource in the service. The
  // store mirrors that split: `putEvents`/`getEvents` persist next to the sandbox state, fenced by
  // the generation the mirror recorded at `put`.

  it('persists and replays the event stream of the stored generation', async () => {
    const { store: subject } = store([{ status: 201 }]);
    const events = [
      { type: 'response.created', sequence_number: 0 },
      { type: 'response.completed', sequence_number: 1 },
    ];

    await subject.put({ response: response(), userId: 'alice', generation: 'gen-1' });
    await subject.putEvents('caresp_1', 'alice', events, 'gen-1');

    expect(await subject.getEvents('caresp_1', 'alice', 'gen-1')).toEqual(events);
  });

  it('round-trips the generation through get, as the events contract requires', async () => {
    const { store: subject } = store([
      { status: 201 },
      { status: 200, body: response() },
      { status: 200, body: { object: 'list', data: [] } },
    ]);

    await subject.put({ response: response(), userId: 'alice', generation: 'gen-1' });
    const stored = await subject.get('caresp_1', 'alice');

    expect(stored?.generation).toBe('gen-1');
  });

  it('discards a replay log for a turn that no longer holds the id', async () => {
    const { store: subject } = store([{ status: 201 }, { status: 201 }]);

    await subject.put({ response: response(), userId: 'alice', generation: 'gen-1' });
    await subject.put({ response: response(), userId: 'alice', generation: 'gen-2' });
    await subject.putEvents('caresp_1', 'alice', [{ type: 'response.created' }], 'gen-1');

    expect(await subject.getEvents('caresp_1', 'alice', 'gen-1')).toBeUndefined();
    expect(await subject.getEvents('caresp_1', 'alice', 'gen-2')).toBeUndefined();
  });

  it('fails closed when the sandbox never saw the turn', async () => {
    // A fresh sandbox (or a recycled container) has no mirror record: the fence cannot pass, so
    // the write is a no-op and the read stays empty rather than fabricating a log.
    const { store: subject } = store([{ status: 201 }]);

    await subject.putEvents('caresp_ghost', 'alice', [{ type: 'response.created' }], 'gen-1');

    expect(await subject.getEvents('caresp_ghost', 'alice', 'gen-1')).toBeUndefined();
  });

  it('drops the replay log with the response', async () => {
    const { store: subject } = store([{ status: 201 }, { status: 200 }]);

    await subject.put({ response: response(), userId: 'alice', generation: 'gen-1' });
    await subject.putEvents('caresp_1', 'alice', [{ type: 'response.created' }], 'gen-1');
    await subject.delete('caresp_1', 'alice');

    expect(await subject.getEvents('caresp_1', 'alice', 'gen-1')).toBeUndefined();
  });

  it('keeps one user’s replay log invisible to another', async () => {
    const { store: subject } = store([{ status: 201 }]);

    await subject.put({ response: response(), userId: 'alice', generation: 'gen-1' });
    await subject.putEvents('caresp_1', 'alice', [{ type: 'response.created' }], 'gen-1');

    expect(await subject.getEvents('caresp_1', 'mallory', 'gen-1')).toBeUndefined();
  });
});
