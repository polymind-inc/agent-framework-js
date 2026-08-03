import { describe, expect, it } from 'vitest';
import { Agent } from '../agent/agent.js';
import type { ChatOptions } from '../client/chat-client.js';
import { MockChatClient } from '../client/test-support.js';
import { ConfigurationError } from '../errors.js';
import { tool } from '../tools/tool.js';
import { textContent } from '../types/content.js';
import type { Message } from '../types/message.js';
import { externalOnly, getMessageSource, notSourceTypes } from '../types/message.js';
import type { ContextProvider, ProviderAfterRunContext, ProviderRunContext } from './context-provider.js';
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
