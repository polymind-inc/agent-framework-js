import type { AccessToken, TokenCredential } from '@azure/identity';
import { describe, expect, it } from 'vitest';
import { FoundryMemoryError, MemoryStoreClient } from './client.js';

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

/** A client whose every request is recorded, answered by the scripted replies in order. */
function client(replies: Array<{ status?: number; body?: unknown; text?: string }> = [{}]): {
  client: MemoryStoreClient;
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
    const reply = replies[Math.min(index, replies.length - 1)] ?? {};
    index++;
    const payload = reply.text ?? (reply.body === undefined ? null : JSON.stringify(reply.body));
    return new Response(payload, {
      status: reply.status ?? 200,
      ...(payload === null ? {} : { headers: { 'content-type': 'application/json' } }),
    });
  }) as typeof globalThis.fetch;

  return {
    client: new MemoryStoreClient({ projectEndpoint: PROJECT, credential, fetch: fetchStub }),
    calls,
  };
}

describe('MemoryStoreClient', () => {
  it('searches with the store name in the path and the scope in the body', async () => {
    const { client: memory, calls } = client([{ body: { search_id: 'srch_1', memories: [] } }]);

    await memory.searchMemories({ name: 'my-store', scope: 'user-1', maxMemories: 3 });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${PROJECT}/memory_stores/my-store:search_memories?api-version=v1`);
    expect(calls[0]?.body).toEqual({ scope: 'user-1', options: { max_memories: 3 } });
  });

  it('sends the required preview opt-in and the bearer token on every call', async () => {
    const { client: memory, calls } = client();

    await memory.searchMemories({ name: 'my-store', scope: 'user-1' });

    expect(calls[0]?.headers['foundry-features']).toBe('MemoryStores=V1Preview');
    expect(calls[0]?.headers.authorization).toBe('Bearer mi-token');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('encodes the store name without swallowing the action separator', async () => {
    const { client: memory, calls } = client();

    await memory.searchMemories({ name: 'store/one two', scope: 'user-1' });

    expect(calls[0]?.url).toBe(`${PROJECT}/memory_stores/store%2Fone%20two:search_memories?api-version=v1`);
  });

  it('carries the previous search id and the items when they are supplied', async () => {
    const { client: memory, calls } = client();

    await memory.searchMemories({
      name: 'my-store',
      scope: 'user-1',
      items: [{ type: 'message', role: 'user', content: 'hello' }],
      previousSearchId: 'srch_0',
    });

    expect(calls[0]?.body).toEqual({
      scope: 'user-1',
      items: [{ type: 'message', role: 'user', content: 'hello' }],
      previous_search_id: 'srch_0',
    });
  });

  it('updates memories with the delay and the previous update id', async () => {
    const { client: memory, calls } = client([{ status: 202, body: { update_id: 'upd_1' } }]);

    const result = await memory.updateMemories({
      name: 'my-store',
      scope: 'user-1',
      items: [{ type: 'message', role: 'assistant', content: 'noted' }],
      previousUpdateId: 'upd_0',
      updateDelay: 0,
    });

    expect(calls[0]?.url).toBe(`${PROJECT}/memory_stores/my-store:update_memories?api-version=v1`);
    expect(calls[0]?.body).toEqual({
      scope: 'user-1',
      items: [{ type: 'message', role: 'assistant', content: 'noted' }],
      previous_update_id: 'upd_0',
      update_delay: 0,
    });
    expect(result.update_id).toBe('upd_1');
  });

  it('reads an update result by id', async () => {
    const { client: memory, calls } = client([{ body: { update_id: 'upd 1', status: 'completed' } }]);

    const result = await memory.getUpdateResult('my-store', 'upd 1');

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`${PROJECT}/memory_stores/my-store/updates/upd%201?api-version=v1`);
    expect(result.status).toBe('completed');
  });

  it('reports a deleted scope, and reports an absent one as nothing to delete', async () => {
    const { client: deleted } = client([{ status: 200, body: { deleted: true } }]);
    expect(await deleted.deleteScope('my-store', 'user-1')).toBe(true);

    const { client: missing, calls } = client([{ status: 404, body: { error: { code: 'not_found' } } }]);
    expect(await missing.deleteScope('my-store', 'user-1')).toBe(false);
    expect(calls[0]?.url).toBe(`${PROJECT}/memory_stores/my-store:delete_scope?api-version=v1`);
    expect(calls[0]?.body).toEqual({ scope: 'user-1' });
  });

  it('answers an unknown store with undefined rather than an error', async () => {
    const { client: memory } = client([{ status: 404, body: { error: { code: 'not_found' } } }]);

    expect(await memory.getMemoryStore('my-store')).toBeUndefined();
  });

  it('creates a store with its definition', async () => {
    const { client: memory, calls } = client([{ body: { name: 'my-store' } }]);

    await memory.createMemoryStore({
      name: 'my-store',
      description: 'demo',
      definition: { kind: 'default', chat_model: 'gpt-4o', embedding_model: 'text-embedding-3-small' },
    });

    expect(calls[0]?.url).toBe(`${PROJECT}/memory_stores?api-version=v1`);
    expect(calls[0]?.body).toEqual({
      name: 'my-store',
      definition: { kind: 'default', chat_model: 'gpt-4o', embedding_model: 'text-embedding-3-small' },
      description: 'demo',
    });
  });

  it('raises a typed error naming the operation, the status and the service message', async () => {
    const { client: memory } = client([{ status: 500, body: { error: { message: 'boom' } } }]);

    const error = await memory.searchMemories({ name: 'my-store', scope: 'user-1' }).catch((e) => e);

    expect(error).toBeInstanceOf(FoundryMemoryError);
    expect((error as FoundryMemoryError).operation).toBe('search');
    expect((error as FoundryMemoryError).status).toBe(500);
    expect((error as FoundryMemoryError).message).toContain('boom');
  });

  it('raises the failure of the operation that made the call, not of the last route shape', async () => {
    const { client: memory } = client([{ status: 403 }]);

    const error = await memory.getUpdateResult('my-store', 'upd_1').catch((e) => e);

    expect((error as FoundryMemoryError).operation).toBe('updateResult');
  });

  it('reads an accepted update that carries no body as an empty result', async () => {
    const { client: memory } = client([{ status: 202 }]);

    expect(
      await memory.updateMemories({
        name: 'my-store',
        scope: 'user-1',
        items: [{ type: 'message', role: 'user', content: 'hi' }],
      }),
    ).toEqual({});
  });

  it('raises when a successful call answers with something that is not JSON', async () => {
    const { client: memory } = client([{ status: 200, text: '<html>gateway</html>' }]);

    const error = await memory.searchMemories({ name: 'my-store', scope: 'user-1' }).catch((e) => e);

    expect(error).toBeInstanceOf(FoundryMemoryError);
    expect((error as FoundryMemoryError).message).toContain('not JSON');
  });

  it('passes the caller signal to the transport', async () => {
    const controller = new AbortController();
    controller.abort();
    const memory = new MemoryStoreClient({
      projectEndpoint: PROJECT,
      credential,
      fetch: (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        init?.signal?.throwIfAborted();
        return new Response('{}');
      }) as typeof globalThis.fetch,
    });

    await expect(
      memory.searchMemories({ name: 'my-store', scope: 'user-1' }, controller.signal),
    ).rejects.toThrow();
  });
});
