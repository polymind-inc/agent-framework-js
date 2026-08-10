import type { AccessToken, TokenCredential } from '@azure/identity';
import type { AgentSession, Message } from '@polymind-inc/agent-framework-core';
import { Agent, ConfigurationError, none, textContent } from '@polymind-inc/agent-framework-core';
import { MockChatClient } from '@polymind-inc/agent-framework-core/testing';
import { describe, expect, it } from 'vitest';
import { FoundryMemoryError } from './client.js';
import type { FoundryMemoryFailure, FoundryMemoryProviderConfig, FoundryMemoryScope } from './provider.js';
import { FoundryMemoryProvider } from './provider.js';

const PROJECT = 'https://my-resource.services.ai.azure.com/api/projects/my-project';

const credential: TokenCredential = {
  async getToken(): Promise<AccessToken> {
    return { token: 'mi-token', expiresOnTimestamp: Date.now() + 3_600_000 };
  },
};

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/** A memory search answer holding `contents`. */
function memories(contents: string[], searchId = 'srch_1'): unknown {
  return { search_id: searchId, memories: contents.map((content) => ({ memory_item: { content } })) };
}

/**
 * A provider whose transport is scripted.
 *
 * Replies are matched by route, so a test states what search and update answer without having to
 * predict how many calls a run makes.
 */
function provider(
  options: {
    search?: Array<{ status?: number; body?: unknown }>;
    update?: Array<{ status?: number; body?: unknown }>;
    store?: Array<{ status?: number; body?: unknown }>;
    scope?: FoundryMemoryScope;
    config?: Partial<FoundryMemoryProviderConfig>;
  } = {},
): { memory: FoundryMemoryProvider; calls: Call[] } {
  const calls: Call[] = [];
  const taken = { search: 0, update: 0, store: 0 };
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    calls.push({ url: target, body });
    const route = target.includes(':search_memories')
      ? 'search'
      : target.includes(':update_memories')
        ? 'update'
        : 'store';
    const scripted = options[route] ?? [];
    const reply = scripted[Math.min(taken[route], scripted.length - 1)] ?? {};
    taken[route]++;
    const payload =
      reply.body === undefined
        ? JSON.stringify(route === 'update' ? { update_id: `upd_${taken.update}` } : { memories: [] })
        : JSON.stringify(reply.body);
    return new Response(payload, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  return {
    memory: new FoundryMemoryProvider({
      projectEndpoint: PROJECT,
      credential,
      memoryStoreName: 'my-store',
      scope: options.scope ?? 'user-1',
      fetch: fetchStub,
      ...options.config,
    }),
    calls,
  };
}

/** An agent that answers every turn with `reply` and carries `memory`, with the model it talks to. */
function agentWith(
  memory: FoundryMemoryProvider,
  reply = 'ok',
): { agent: Agent; model: MockChatClient; messagesOf: (run?: number) => Message[] } {
  const model = new MockChatClient([{ contents: [textContent(reply)] }]);
  return {
    agent: new Agent({ client: model, contextProviders: [memory] }),
    model,
    messagesOf: (run = 0) => model.calls[run]?.messages ?? [],
  };
}

/** The message the provider injected, or `undefined` when it injected none. */
function injected(messages: Message[]): Message | undefined {
  return messages.find((message) =>
    message.contents.some((content) => content.type === 'text' && content.text.startsWith('## Memories')),
  );
}

const searchCalls = (calls: Call[]): Call[] => calls.filter((call) => call.url.includes(':search_memories'));
const updateCalls = (calls: Call[]): Call[] => calls.filter((call) => call.url.includes(':update_memories'));

describe('FoundryMemoryProvider', () => {
  describe('configuration', () => {
    it('rejects an empty store name', () => {
      expect(
        () => new FoundryMemoryProvider({ projectEndpoint: PROJECT, memoryStoreName: ' ', scope: 'user-1' }),
      ).toThrow(ConfigurationError);
    });

    it('rejects an empty scope', () => {
      expect(
        () =>
          new FoundryMemoryProvider({ projectEndpoint: PROJECT, memoryStoreName: 'my-store', scope: ' ' }),
      ).toThrow(ConfigurationError);
    });

    it('rejects a missing project endpoint', () => {
      const saved = process.env.FOUNDRY_PROJECT_ENDPOINT;
      delete process.env.FOUNDRY_PROJECT_ENDPOINT;
      try {
        expect(() => new FoundryMemoryProvider({ memoryStoreName: 'my-store', scope: 'user-1' })).toThrow(
          ConfigurationError,
        );
      } finally {
        if (saved !== undefined) {
          process.env.FOUNDRY_PROJECT_ENDPOINT = saved;
        }
      }
    });

    it('names its state partition foundry_memory unless told otherwise', () => {
      const { memory } = provider();
      expect(memory.sourceId).toBe('foundry_memory');
      expect(provider({ config: { sourceId: 'mine' } }).memory.sourceId).toBe('mine');
    });
  });

  describe('retrieval', () => {
    it('injects the retrieved memories as one user message under the context prompt', async () => {
      const { memory, calls } = provider({
        search: [{ body: memories(['likes black coffee']) }, { body: memories(['is called Rin']) }],
      });
      const { agent, messagesOf } = agentWith(memory);

      await agent.run('order me a coffee');

      const memoryMessage = injected(messagesOf());
      expect(memoryMessage?.role).toBe('user');
      expect(memoryMessage?.contents[0]).toMatchObject({
        type: 'text',
        text: '## Memories\nConsider the following memories when answering user questions:\nlikes black coffee\nis called Rin',
      });
      // The profile search carries no items; the contextual one carries the turn's input.
      expect(searchCalls(calls)[0]?.body.items).toBeUndefined();
      expect(searchCalls(calls)[1]?.body.items).toEqual([
        { type: 'message', role: 'user', content: 'order me a coffee' },
      ]);
    });

    it('asks for the profile memories once per session and replays them on later runs', async () => {
      const { memory, calls } = provider({ search: [{ body: memories(['likes black coffee']) }] });
      const { agent, messagesOf } = agentWith(memory);
      const session = agent.createSession();

      await agent.run('one', { session });
      await agent.run('two', { session });

      const withoutItems = searchCalls(calls).filter((call) => call.body.items === undefined);
      expect(withoutItems).toHaveLength(1);
      // Replayed: the second run's injection still opens with the profile memory.
      expect(injected(messagesOf(1))?.contents[0]).toMatchObject({
        text: expect.stringContaining('likes black coffee'),
      });
    });

    it('injects nothing when the store holds no relevant memories', async () => {
      const { memory } = provider({ search: [{ body: memories([]) }] });
      const { agent, messagesOf } = agentWith(memory);

      await agent.run('hello');

      expect(messagesOf()).toHaveLength(1);
      expect(messagesOf()[0]?.contents[0]).toMatchObject({ text: 'hello' });
    });

    it('does not search for context when the run carries no text', async () => {
      const { memory, calls } = provider();
      const { agent } = agentWith(memory);

      await agent.run([{ role: 'user', contents: [] }]);

      expect(searchCalls(calls)).toHaveLength(1);
      expect(searchCalls(calls)[0]?.body.items).toBeUndefined();
    });

    it('advances the incremental search anchor only when a search found something', async () => {
      const { memory, calls } = provider({
        search: [
          { body: memories([], 'srch_static') },
          { body: memories([], 'srch_empty') },
          { body: memories(['a fact'], 'srch_hit') },
          { body: memories(['another'], 'srch_last') },
        ],
      });
      const { agent } = agentWith(memory);
      const session = agent.createSession();

      await agent.run('one', { session });
      await agent.run('two', { session });
      await agent.run('three', { session });

      const contextual = searchCalls(calls).filter((call) => call.body.items !== undefined);
      expect(contextual[0]?.body.previous_search_id).toBeUndefined();
      // The empty answer's id is not carried forward; the one that found memories is.
      expect(contextual[1]?.body.previous_search_id).toBeUndefined();
      expect(contextual[2]?.body.previous_search_id).toBe('srch_hit');
    });

    it('honours the search filter', async () => {
      const { memory, calls } = provider({ config: { searchFilter: none } });
      const { agent } = agentWith(memory);

      await agent.run('hello');

      expect(searchCalls(calls)).toHaveLength(1);
    });

    it('replays the profile memories even when there is nothing to search contextually', async () => {
      const { memory, calls } = provider({
        search: [{ body: memories(['likes tea']) }],
        config: { searchFilter: none },
      });
      const { agent, messagesOf } = agentWith(memory);

      await agent.run('hello');

      expect(searchCalls(calls)).toHaveLength(1);
      expect(injected(messagesOf())?.contents[0]).toMatchObject({
        text: expect.stringContaining('likes tea'),
      });
    });
  });

  describe('storage', () => {
    it('sends the request and response of the turn, with the roles the service models', async () => {
      const { memory, calls } = provider();
      const { agent } = agentWith(memory, 'one black coffee');

      await agent.run('order me a coffee');

      expect(updateCalls(calls)).toHaveLength(1);
      expect(updateCalls(calls)[0]?.body).toMatchObject({
        scope: 'user-1',
        update_delay: 0,
        items: [
          { type: 'message', role: 'user', content: 'order me a coffee' },
          { type: 'message', role: 'assistant', content: 'one black coffee' },
        ],
      });
    });

    it('stores nothing for a turn with no conversational text', async () => {
      const { memory, calls } = provider();
      const agent = new Agent({
        client: new MockChatClient([{ contents: [] }]),
        contextProviders: [memory],
      });

      await agent.run([{ role: 'tool', contents: [textContent('tool output')] }]);

      expect(updateCalls(calls)).toHaveLength(0);
    });

    it('does not store a failed run', async () => {
      const { memory, calls } = provider();
      const failing = new Agent({
        client: {
          metadata: { providerName: 'boom' },
          getResponse: () => {
            throw new Error('model exploded');
          },
        } as never,
        contextProviders: [memory],
      });

      await expect(failing.run('remember this')).rejects.toThrow('model exploded');
      expect(updateCalls(calls)).toHaveLength(0);
    });

    it('chains updates through the previous update id', async () => {
      const { memory, calls } = provider({
        update: [
          { status: 202, body: { update_id: 'upd_a' } },
          { status: 202, body: { update_id: 'upd_b' } },
        ],
      });
      const { agent } = agentWith(memory);
      const session = agent.createSession();

      await agent.run('one', { session });
      await agent.run('two', { session });

      expect(updateCalls(calls)[0]?.body.previous_update_id).toBeUndefined();
      expect(updateCalls(calls)[1]?.body.previous_update_id).toBe('upd_a');
    });

    it('stores a system message with its role preserved', async () => {
      const { memory, calls } = provider();
      const { agent } = agentWith(memory, 'noted');

      await agent.run([
        { role: 'system', contents: [textContent('The user is called Rin.')] },
        { role: 'user', contents: [textContent('remember me')] },
      ]);

      expect(updateCalls(calls)[0]?.body.items).toEqual([
        { type: 'message', role: 'system', content: 'The user is called Rin.' },
        { type: 'message', role: 'user', content: 'remember me' },
        { type: 'message', role: 'assistant', content: 'noted' },
      ]);
    });

    it('sends the configured update delay', async () => {
      const { memory, calls } = provider({ config: { updateDelay: 300 } });

      await agentWith(memory).agent.run('hello');

      expect(updateCalls(calls)[0]?.body.update_delay).toBe(300);
    });

    it('honours the response filter', async () => {
      const { memory, calls } = provider({ config: { storeResponseFilter: none } });

      await agentWith(memory, 'one black coffee').agent.run('order me a coffee');

      expect(updateCalls(calls)[0]?.body.items).toEqual([
        { type: 'message', role: 'user', content: 'order me a coffee' },
      ]);
    });
  });

  describe('scope', () => {
    it('resolves a function scope on every run', async () => {
      const seen: string[] = [];
      const { memory, calls } = provider({
        scope: (ctx) => {
          seen.push(ctx.session.sessionId);
          return 'user-7';
        },
      });
      const { agent } = agentWith(memory);
      const session = agent.createSession();

      await agent.run('one', { session });
      await agent.run('two', { session });

      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(searchCalls(calls).every((call) => call.body.scope === 'user-7')).toBe(true);
    });

    it('fails the run when a session resolves a second scope', async () => {
      let current = 'user-1';
      const { memory } = provider({ scope: () => current });
      const { agent } = agentWith(memory);
      const session = agent.createSession();

      await agent.run('one', { session });
      current = 'user-2';

      await expect(agent.run('two', { session })).rejects.toThrow(ConfigurationError);
    });

    it('fails the run when no scope can be resolved', async () => {
      const { memory } = provider({ scope: () => '' });

      await expect(agentWith(memory).agent.run('one')).rejects.toThrow(ConfigurationError);
    });

    it('keeps the pinned scope in its own partition of the session', async () => {
      const { memory } = provider();
      const { agent } = agentWith(memory);
      const session: AgentSession = agent.createSession();

      await agent.run('one', { session });

      expect((session.state.foundry_memory as { scope?: string }).scope).toBe('user-1');
    });
  });

  describe('failures', () => {
    it('runs without memories when the search fails, and reports the failure', async () => {
      const failures: FoundryMemoryFailure[] = [];
      const { memory } = provider({
        search: [{ status: 500, body: { error: { message: 'down' } } }],
        config: { onFailure: (failure) => failures.push(failure) },
      });
      const { agent, messagesOf } = agentWith(memory);

      const response = await agent.run('hello');

      expect(response.text).toBe('ok');
      expect(messagesOf()).toHaveLength(1);
      expect(failures.map((failure) => failure.operation)).toEqual(['search', 'search']);
      expect(failures[0]?.error).toBeInstanceOf(FoundryMemoryError);
    });

    it('still injects the profile memories when the contextual search fails and the run continues', async () => {
      const failures: FoundryMemoryFailure[] = [];
      const { memory } = provider({
        search: [{ body: memories(['likes tea']) }, { status: 500 }],
        config: { onFailure: (failure) => failures.push(failure) },
      });
      const { agent, messagesOf } = agentWith(memory);

      const response = await agent.run('hello');

      expect(response.text).toBe('ok');
      expect(failures.map((failure) => failure.operation)).toEqual(['search']);
      expect(injected(messagesOf())?.contents[0]).toMatchObject({
        text: expect.stringContaining('likes tea'),
      });
    });

    it('fails the run when the contextual search fails and the mode is to fail closed', async () => {
      const { memory } = provider({
        search: [{ body: memories(['likes tea']) }, { status: 500 }],
        config: { failureMode: 'throw' },
      });

      await expect(agentWith(memory).agent.run('hello')).rejects.toBeInstanceOf(FoundryMemoryError);
    });

    it('fails the run instead when configured to fail closed', async () => {
      const { memory } = provider({
        search: [{ status: 500 }],
        config: { failureMode: 'throw' },
      });

      await expect(agentWith(memory).agent.run('hello')).rejects.toBeInstanceOf(FoundryMemoryError);
    });

    it('keeps a failed run intact when the update fails and the mode is to continue', async () => {
      const failures: FoundryMemoryFailure[] = [];
      const { memory } = provider({
        update: [{ status: 503 }],
        config: { onFailure: (failure) => failures.push(failure) },
      });

      const response = await agentWith(memory).agent.run('hello');

      expect(response.text).toBe('ok');
      expect(failures.map((failure) => failure.operation)).toEqual(['update']);
    });

    it('retries the profile search on the next run when its failure failed the run', async () => {
      const { memory, calls } = provider({
        search: [
          { status: 500 },
          { body: memories(['likes black coffee'], 'srch_profile') },
          { body: memories([], 'srch_ctx') },
        ],
        config: { failureMode: 'throw' },
      });
      const { agent, messagesOf } = agentWith(memory);
      const session = agent.createSession();

      await expect(agent.run('one', { session })).rejects.toBeInstanceOf(FoundryMemoryError);
      await agent.run('two', { session });

      // The failure failed the run, so the run that replaces it asks for the profile again.
      expect(searchCalls(calls).filter((call) => call.body.items === undefined)).toHaveLength(2);
      expect(injected(messagesOf(0))?.contents[0]).toMatchObject({
        text: expect.stringContaining('likes black coffee'),
      });
    });

    it('does not retry the profile search on later runs of a session that already failed it', async () => {
      const { memory, calls } = provider({ search: [{ status: 500 }] });
      const { agent } = agentWith(memory);
      const session = agent.createSession();

      await agent.run('one', { session });
      await agent.run('two', { session });

      expect(searchCalls(calls).filter((call) => call.body.items === undefined)).toHaveLength(1);
    });
  });

  describe('store maintenance', () => {
    it('creates the store only when it is missing', async () => {
      const definition = {
        kind: 'default' as const,
        chat_model: 'gpt-4o',
        embedding_model: 'text-embedding-3-small',
      };

      const existing = provider({ store: [{ status: 200, body: { name: 'my-store' } }] });
      expect(await existing.memory.ensureMemoryStoreCreated(definition)).toBe(false);
      expect(existing.calls).toHaveLength(1);

      const missing = provider({
        store: [{ status: 404, body: { error: { code: 'not_found' } } }, { body: { name: 'my-store' } }],
      });
      expect(await missing.memory.ensureMemoryStoreCreated(definition, { description: 'demo' })).toBe(true);
      expect(missing.calls).toHaveLength(2);
      expect(missing.calls[1]?.body).toMatchObject({ name: 'my-store', definition, description: 'demo' });
    });

    it('deletes the memories of a scope the caller names', async () => {
      const { memory, calls } = provider({ store: [{ status: 200, body: { deleted: true } }] });

      expect(await memory.deleteStoredMemories('user-9')).toBe(true);
      expect(calls[0]?.url).toContain(':delete_scope');
      expect(calls[0]?.body).toEqual({ scope: 'user-9' });
    });

    it('waits for the queued extraction, and stops waiting once it completed', async () => {
      const { memory, calls } = provider({
        update: [{ status: 202, body: { update_id: 'upd_a' } }],
        store: [
          { body: { update_id: 'upd_a', status: 'in_progress' } },
          { body: { update_id: 'upd_a', status: 'completed' } },
        ],
      });

      await agentWith(memory).agent.run('hello');
      await memory.whenUpdatesCompleted({ pollIntervalMs: 0 });

      expect(calls.filter((call) => call.url.includes('/updates/'))).toHaveLength(2);

      // Nothing is pending any more, so a second wait does not poll again.
      await memory.whenUpdatesCompleted({ pollIntervalMs: 0 });
      expect(calls.filter((call) => call.url.includes('/updates/'))).toHaveLength(2);
    });

    it('waits for nothing when no update was queued', async () => {
      const { memory, calls } = provider();

      await memory.whenUpdatesCompleted({ pollIntervalMs: 0 });

      expect(calls).toHaveLength(0);
    });

    it('stops waiting as soon as the caller aborts, not at the next poll', async () => {
      const { memory } = provider({
        update: [{ status: 202, body: { update_id: 'upd_a' } }],
        store: [{ body: { update_id: 'upd_a', status: 'in_progress' } }],
      });
      await agentWith(memory).agent.run('hello');

      const controller = new AbortController();
      const started = Date.now();
      const waiting = memory.whenUpdatesCompleted({ pollIntervalMs: 5_000, signal: controller.signal });
      setTimeout(() => controller.abort(), 20);

      await expect(waiting).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('raises when the extraction failed', async () => {
      const { memory } = provider({
        update: [{ status: 202, body: { update_id: 'upd_a' } }],
        store: [{ body: { update_id: 'upd_a', status: 'failed', error: { message: 'quota' } } }],
      });

      await agentWith(memory).agent.run('hello');

      await expect(memory.whenUpdatesCompleted({ pollIntervalMs: 0 })).rejects.toThrow('quota');
    });

    it('raises on a status it does not model rather than polling forever', async () => {
      const { memory } = provider({
        update: [{ status: 202, body: { update_id: 'upd_a' } }],
        store: [{ body: { update_id: 'upd_a', status: 'sideways' } }],
      });

      await agentWith(memory).agent.run('hello');

      await expect(memory.whenUpdatesCompleted({ pollIntervalMs: 0 })).rejects.toThrow('sideways');
    });
  });
});
