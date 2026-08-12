import { describe, expect, it } from 'vitest';
import { Agent } from '../agent/agent.js';
import type { AgentSession } from '../agent/session.js';
import type { ChatOptions } from '../client/chat-client.js';
import { MockChatClient } from '../client/test-support.js';
import { ConfigurationError } from '../errors.js';
import { tool } from '../tools/tool.js';
import { textContent } from '../types/content.js';
import type { Message } from '../types/message.js';
import { externalOnly, getMessageSource, notSourceTypes } from '../types/message.js';
import type {
  ContextProvider,
  HistoryProvider,
  ProviderAfterRunContext,
  ProviderRunContext,
} from './context-provider.js';
import { InMemoryHistoryProvider } from './in-memory-history-provider.js';

function client(...texts: string[]): MockChatClient {
  return new MockChatClient(texts.map((text) => ({ contents: [textContent(text)], finishReason: 'stop' })));
}

const lookup = tool({
  name: 'lookup',
  description: 'Looks something up',
  parameters: { type: 'object', properties: {} },
  execute: () => 'found',
});

/** The kind of provider the examples show: reads state, injects context, learns from the result. */
class MemoryProvider implements ContextProvider {
  readonly sourceId = 'memory';
  readonly stateKeys = ['memoryStats'];
  readonly seen: string[] = [];

  beforeRun(ctx: ProviderRunContext): void {
    const facts = (ctx.state.facts as string[] | undefined) ?? [];
    if (facts.length > 0) {
      ctx.extendMessages([{ role: 'user', contents: [textContent(`Known: ${facts.join(', ')}`)] }]);
    }
    ctx.extendInstructions('Answer using the known facts.');
    ctx.extendTools([lookup]);
  }

  afterRun(ctx: ProviderAfterRunContext): void {
    this.seen.push(ctx.error === undefined ? 'success' : 'error');
    const facts = (ctx.state.facts as string[] | undefined) ?? [];
    ctx.state.facts = [...facts, ctx.response?.text ?? 'failed'];
  }
}

describe('state key validation', () => {
  it('rejects two providers claiming the same sourceId', () => {
    const a: ContextProvider = { sourceId: 'shared' };
    const b: ContextProvider = { sourceId: 'shared' };
    expect(() => new Agent({ client: client('x'), contextProviders: [a, b] })).toThrow(ConfigurationError);
  });

  it('rejects a provider whose stateKeys collide with another sourceId', () => {
    const a: ContextProvider = { sourceId: 'alpha' };
    const b: ContextProvider = { sourceId: 'beta', stateKeys: ['alpha'] };
    expect(() => new Agent({ client: client('x'), contextProviders: [a, b] })).toThrow(ConfigurationError);
  });

  it('rejects a collision with the history provider', () => {
    const provider: ContextProvider = { sourceId: 'other', stateKeys: ['in_memory'] };
    expect(() => new Agent({ client: client('x'), contextProviders: [provider] })).toThrow(
      ConfigurationError,
    );
  });

  it('accepts distinct sourceIds and stateKeys', () => {
    const a: ContextProvider = { sourceId: 'alpha', stateKeys: ['alphaExtra'] };
    const b: ContextProvider = { sourceId: 'beta', stateKeys: ['betaExtra'] };
    expect(() => new Agent({ client: client('x'), contextProviders: [a, b] })).not.toThrow();
  });
});

describe('provider contributions', () => {
  it('injects messages ahead of the caller input, stamped with the source', async () => {
    const mock = client('ok');
    const provider = new MemoryProvider();
    const agent = new Agent({ client: mock, contextProviders: [provider] });
    const session = agent.createSession();

    await agent.run('first', { session });
    await agent.run('second', { session });

    const sent = mock.calls[1]?.messages ?? [];
    const injected = sent.filter((msg) => getMessageSource(msg)?.sourceId === 'memory');
    expect(injected).toHaveLength(1);
    expect(injected[0]?.contents[0]).toMatchObject({ type: 'text', text: 'Known: ok' });
    expect(getMessageSource(injected[0] as Message)).toEqual({
      sourceType: 'AIContextProvider',
      sourceId: 'memory',
    });
    // History comes first, then provider context, then the caller's own message.
    expect(sent.at(-1)?.contents[0]).toMatchObject({ text: 'second' });
  });

  it('appends provider instructions after the agent and run instructions', async () => {
    const mock = client('ok');
    const agent = new Agent({
      client: mock,
      instructions: 'Agent level.',
      contextProviders: [new MemoryProvider()],
    });

    await agent.run('x', { options: { instructions: 'Run level.' } });

    const options = mock.calls[0]?.options as ChatOptions;
    expect(options.instructions).toBe('Agent level.\nRun level.\nAnswer using the known facts.');
  });

  it('adds provider tools last, after the agent and run tools', async () => {
    const mock = client('ok');
    const runTool = tool({
      name: 'run_tool',
      description: 'Run scoped',
      parameters: { type: 'object', properties: {} },
      execute: () => 'ok',
    });
    const agent = new Agent({ client: mock, contextProviders: [new MemoryProvider()] });

    await agent.run('x', { tools: [runTool] });

    const options = mock.calls[0]?.options as ChatOptions;
    expect(options.tools?.map((t) => t.name)).toEqual(['run_tool', 'lookup']);
  });

  it('keeps each provider in its own partition of the session state', async () => {
    const agent = new Agent({
      client: client('a', 'b'),
      contextProviders: [new MemoryProvider()],
    });
    const session = agent.createSession();

    await agent.run('x', { session });

    expect(session.state.memory).toEqual({ facts: ['a'] });
    expect(Object.keys(session.state)).toContain('in_memory');
  });
});

describe('afterRun', () => {
  it('runs in registration order, history first', async () => {
    const order: string[] = [];
    const record = (id: string): ContextProvider => ({
      sourceId: id,
      afterRun: () => {
        order.push(id);
      },
    });
    const history = new InMemoryHistoryProvider();
    const original = history.afterRun.bind(history);
    history.afterRun = async (ctx): Promise<void> => {
      order.push('history');
      await original(ctx);
    };
    const agent = new Agent({
      client: client('x'),
      historyProvider: history,
      contextProviders: [record('alpha'), record('beta')],
    });

    await agent.run('hi');

    expect(order).toEqual(['history', 'alpha', 'beta']);
  });

  it('reports a failed run to the providers', async () => {
    const provider = new MemoryProvider();
    const failing = {
      metadata: { providerName: 'mock' },
      getResponse: (): never => {
        throw new Error('provider down');
      },
    };
    const agent = new Agent({ client: failing as never, contextProviders: [provider] });

    await expect(agent.run('x')).rejects.toThrow('provider down');
    expect(provider.seen).toEqual(['error']);
  });

  it('reports a successful run exactly once, even for a streamed run', async () => {
    const provider = new MemoryProvider();
    const agent = new Agent({ client: client('done'), contextProviders: [provider] });

    const stream = agent.run('x');
    for await (const _update of stream) {
      // drain
    }
    await stream.finalResponse();

    expect(provider.seen).toEqual(['success']);
  });
});

/**
 * The promises every history provider — file, blob, database — is written against.
 *
 * Asserted through a recording provider rather than the in-memory one, so the contract is pinned
 * where an external implementer relies on it and not merely where the bundled implementation
 * happens to satisfy it.
 */
describe('HistoryProvider contract', () => {
  class RecordingHistoryProvider implements HistoryProvider {
    readonly sourceId = 'recording';
    readonly saved: Message[][] = [];
    readonly afterRunCalls: Array<{ hasResponse: boolean; hasError: boolean }> = [];
    #stored: Message[] = [];

    async getMessages(): Promise<Message[]> {
      return [...this.#stored];
    }

    async saveMessages(_session: AgentSession, messages: Message[]): Promise<void> {
      this.saved.push([...messages]);
      this.#stored = [...this.#stored, ...messages];
    }

    async beforeRun(ctx: ProviderRunContext): Promise<void> {
      const history = await this.getMessages();
      if (history.length > 0) {
        ctx.extendMessages(history);
      }
    }

    async afterRun(ctx: ProviderAfterRunContext): Promise<void> {
      this.afterRunCalls.push({ hasResponse: ctx.response !== undefined, hasError: ctx.error !== undefined });
      if (ctx.response === undefined) {
        return;
      }
      await this.saveMessages(ctx.session, [...ctx.inputMessages, ...ctx.response.messages]);
    }
  }

  it('passes only the messages new to each turn, never the whole transcript', async () => {
    const history = new RecordingHistoryProvider();
    const agent = new Agent({ client: client('one', 'two'), historyProvider: history });
    const session = agent.createSession();

    await agent.run('first', { session });
    await agent.run('second', { session });

    // Two appends of one exchange each. A provider that re-sent the transcript would make the
    // second call four messages long, and an append-only store would then double every turn.
    expect(history.saved.map((batch) => batch.map((message) => message.role))).toEqual([
      ['user', 'assistant'],
      ['user', 'assistant'],
    ]);
  });

  it('replays what getMessages returned, oldest first, ahead of the caller input', async () => {
    const history = new RecordingHistoryProvider();
    const mock = client('one', 'two');
    const agent = new Agent({ client: mock, historyProvider: history });
    const session = agent.createSession();

    await agent.run('first', { session });
    await agent.run('second', { session });

    expect(mock.calls[1]?.messages.map((message) => message.contents[0])).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'one' },
      { type: 'text', text: 'second' },
    ]);
  });

  it('loads history before any other provider contributes', async () => {
    const order: string[] = [];
    const history = new RecordingHistoryProvider();
    const originalBefore = history.beforeRun.bind(history);
    history.beforeRun = async (ctx): Promise<void> => {
      order.push('history');
      await originalBefore(ctx);
    };
    const other: ContextProvider = {
      sourceId: 'other',
      beforeRun: () => {
        order.push('other');
      },
    };
    const agent = new Agent({ client: client('x'), historyProvider: history, contextProviders: [other] });

    await agent.run('hi', { session: agent.createSession() });

    expect(order).toEqual(['history', 'other']);
  });

  it('reports a failed turn with the error and no response', async () => {
    const history = new RecordingHistoryProvider();
    const failing = {
      metadata: { providerName: 'mock' },
      getResponse: (): never => {
        throw new Error('provider down');
      },
    };
    const agent = new Agent({ client: failing as never, historyProvider: history });

    await expect(agent.run('x', { session: agent.createSession() })).rejects.toThrow('provider down');

    expect(history.afterRunCalls).toEqual([{ hasResponse: false, hasError: true }]);
    expect(history.saved).toEqual([]);
  });

  it('stores nothing for a failed turn, so the transcript has no unanswered question in it', async () => {
    const history = new InMemoryHistoryProvider();
    const failing = {
      metadata: { providerName: 'mock' },
      getResponse: (): never => {
        throw new Error('provider down');
      },
    };
    const agent = new Agent({ client: failing as never, historyProvider: history });
    const session = agent.createSession();

    await expect(agent.run('x', { session })).rejects.toThrow('provider down');

    expect(await history.getMessages(session, session.partition(history.sourceId))).toEqual([]);
  });
});

describe('storeContextMessages', () => {
  /** Injects one message, so a run always has something for the opt-in to pick up. */
  const injector = (sourceId: string, text: string): ContextProvider => ({
    sourceId,
    beforeRun: (ctx: ProviderRunContext) => {
      ctx.extendMessages([{ role: 'user', contents: [textContent(text)] }]);
    },
  });

  async function storedTexts(history: InMemoryHistoryProvider): Promise<string[]> {
    const agent = new Agent({
      client: client('answer'),
      historyProvider: history,
      contextProviders: [injector('memory', 'remembered'), injector('docs', 'retrieved')],
    });
    const session = agent.createSession();
    await agent.run('question', { session });
    const stored = await history.getMessages(session, session.partition(history.sourceId));
    return stored.flatMap((message) =>
      message.contents.map((content) => (content.type === 'text' ? content.text : content.type)),
    );
  }

  it('leaves injected context out of the transcript by default', async () => {
    expect(await storedTexts(new InMemoryHistoryProvider())).toEqual(['question', 'answer']);
  });

  it('stores every injected message when opted in', async () => {
    const stored = await storedTexts(new InMemoryHistoryProvider({ storeContextMessages: true }));
    expect(stored).toEqual(['remembered', 'retrieved', 'question', 'answer']);
  });

  it('stores only the named sources when given a list', async () => {
    const stored = await storedTexts(new InMemoryHistoryProvider({ storeContextMessages: ['docs'] }));
    expect(stored).toEqual(['retrieved', 'question', 'answer']);
  });

  it('never stores the history it replayed itself, even when opted in', async () => {
    const history = new InMemoryHistoryProvider({ storeContextMessages: true });
    const agent = new Agent({ client: client('one', 'two'), historyProvider: history });
    const session = agent.createSession();

    await agent.run('first', { session });
    await agent.run('second', { session });

    const stored = await history.getMessages(session, session.partition(history.sourceId));
    expect(stored.map((message) => message.contents[0])).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'one' },
      { type: 'text', text: 'second' },
      { type: 'text', text: 'two' },
    ]);
  });
});

describe('message filters', () => {
  const external: Message = { role: 'user', contents: [textContent('caller')] };
  const fromHistory: Message = {
    role: 'assistant',
    contents: [textContent('replayed')],
    additionalProperties: { _attribution: { sourceType: 'ChatHistory', sourceId: 'in_memory' } },
  };
  const fromProvider: Message = {
    role: 'user',
    contents: [textContent('memory')],
    additionalProperties: { _attribution: { sourceType: 'AIContextProvider', sourceId: 'memory' } },
  };

  it('externalOnly keeps unstamped and External messages', () => {
    expect(externalOnly([external, fromHistory, fromProvider])).toEqual([external]);
  });

  it('notSourceTypes rejects the listed types', () => {
    expect(notSourceTypes('ChatHistory')([external, fromHistory, fromProvider])).toEqual([
      external,
      fromProvider,
    ]);
  });

  it('drives what a history provider stores', async () => {
    // Messages the model produced carry no stamp, so a source filter alone keeps them; this is a
    // role filter to show that the seam takes any MessageFilter.
    const history = new InMemoryHistoryProvider({
      storeFilter: (messages) => messages.filter((msg) => msg.role === 'user'),
    });
    const agent = new Agent({ client: client('a', 'b'), historyProvider: history });
    const session = agent.createSession();

    await agent.run('first', { session });
    await agent.run('second', { session });

    const stored = await history.getMessages(session, session.partition('in_memory'));
    expect(stored.map((msg) => msg.contents[0])).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
  });

  it('drives what a history provider replays', async () => {
    const mock = client('a', 'b', 'c');
    const history = new InMemoryHistoryProvider({ provideFilter: (messages) => messages.slice(-1) });
    const agent = new Agent({ client: mock, historyProvider: history });
    const session = agent.createSession();

    await agent.run('first', { session });
    await agent.run('second', { session });
    await agent.run('third', { session });

    const replayed = (mock.calls[2]?.messages ?? []).filter(
      (msg) => getMessageSource(msg)?.sourceType === 'ChatHistory',
    );
    expect(replayed.map((msg) => msg.contents[0])).toEqual([{ type: 'text', text: 'b' }]);
  });
});
