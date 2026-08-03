import type { AccessToken, TokenCredential } from '@azure/identity';
import type { ResponseObject } from '@polymind-inc/agent-framework-agentserver';
import {
  createRequestContext,
  HEADERS,
  runWithRequestContext,
} from '@polymind-inc/agent-framework-agentserver';
import { ConfigurationError } from '@polymind-inc/agent-framework-core';
import { afterEach, describe, expect, it } from 'vitest';
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
}

/** A store whose every request is recorded, with scripted replies. */
function store(
  replies: Array<{ status: number; body?: unknown }>,
  options: { forwardCallId?: boolean } = {},
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
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const reply = replies[Math.min(index, replies.length - 1)] ?? { status: 200 };
    index++;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      ...(reply.body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
    });
  }) as typeof globalThis.fetch;

  return {
    store: new FoundryResponseStore({
      projectEndpoint: PROJECT,
      credential,
      fetch: fetchStub,
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

describe('FoundryResponseStore', () => {
  it('builds the storage URL from the project endpoint', () => {
    const { store: subject } = store([]);
    expect(subject.baseUrl).toBe(`${PROJECT}/storage/`);
  });

  it('refuses to be built without a project endpoint', () => {
    // Cleared explicitly rather than assumed absent: a developer whose shell is configured for a
    // real project (as the integration tests need) would otherwise see this unit test fail.
    const previous = process.env.FOUNDRY_PROJECT_ENDPOINT;
    delete process.env.FOUNDRY_PROJECT_ENDPOINT;
    try {
      expect(() => new FoundryResponseStore({ credential })).toThrow(/needs a project endpoint/);
    } finally {
      if (previous !== undefined) {
        process.env.FOUNDRY_PROJECT_ENDPOINT = previous;
      }
    }
  });

  it('refuses a relative endpoint at construction rather than failing on the first request', () => {
    // A misconfigured endpoint should surface where it was configured, not as a broken URL on the
    // first storage call.
    expect(() => new FoundryResponseStore({ projectEndpoint: '/api/projects/p', credential })).toThrow(
      ConfigurationError,
    );
  });

  it('uses the routes and verbs the service defines', async () => {
    const { store: subject, calls } = store([{ status: 200 }]);

    await subject.put({ response: response(), inputItems: [{ type: 'message', id: 'in_1' }] });

    // Create is `POST responses`, not a PUT on the id.
    expect(calls[0]).toMatchObject({ method: 'POST' });
    expect(calls[0]?.url).toBe(`${PROJECT}/storage/responses?api-version=v1`);
    // Both lists are always present, empty included, matching the reference serializer.
    expect(calls[0]?.body).toEqual({
      response: response(),
      input_items: [{ type: 'message', id: 'in_1' }],
      history_item_ids: [],
    });
  });

  it('sends the create envelope even when there are no input items', async () => {
    const { store: subject, calls } = store([{ status: 200 }]);

    await subject.put({ response: response() });

    expect(calls[0]?.body).toEqual({ response: response(), input_items: [], history_item_ids: [] });
  });

  it('falls back to an update when the response already exists', async () => {
    const { store: subject, calls } = store([{ status: 409 }, { status: 200 }]);

    await subject.put({ response: response() });

    expect(calls.map((c) => c.url)).toEqual([
      `${PROJECT}/storage/responses?api-version=v1`,
      `${PROJECT}/storage/responses/caresp_1?api-version=v1`,
    ]);
    // The update carries the response itself, not the create envelope.
    expect(calls[1]?.body).toEqual(response());
  });

  it('falls back to an update when the conflict arrives as a 400 with a conflict code', async () => {
    // The service expresses duplicate-create as either status; the reference's `_is_conflict`
    // (`store/_foundry_provider.py:41-61`) reads the body, not the status line.
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

  it('uses the sandbox filesystem in a container, even a fully provisioned one', () => {
    // The three variables .NET requires before it activates *its* Foundry provider. We do not:
    // a real deployment answers `POST /storage/responses` with an opaque 500 even from inside the
    // container, which would fail every turn. `FoundryResponseStore` is opt-in.
    process.env.FOUNDRY_PROJECT_ENDPOINT = PROJECT;
    process.env.FOUNDRY_AGENT_NAME = 'weather-agent';
    process.env.FOUNDRY_AGENT_VERSION = '1';

    expect(defaultStore(true).constructor.name).toBe('FileResponseProvider');
  });

  it('uses the sandbox filesystem for a half-configured container too', () => {
    process.env.FOUNDRY_PROJECT_ENDPOINT = PROJECT;
    delete process.env.FOUNDRY_AGENT_NAME;
    delete process.env.FOUNDRY_AGENT_VERSION;

    expect(defaultStore(true).constructor.name).toBe('FileResponseProvider');
  });
});
