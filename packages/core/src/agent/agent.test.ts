import { describe, expect, it, vi } from 'vitest';
import type { ChatClient, ChatOptions } from '../client/chat-client.js';
import { MockChatClient } from '../client/test-support.js';
import type { ContextProvider, HistoryProvider } from '../context/context-provider.js';
import { InMemoryHistoryProvider } from '../context/in-memory-history-provider.js';
import { ConfigurationError, StreamConsumedError, UserInputRequiredError } from '../errors.js';
import { createResponseStream } from '../streaming/response-stream.js';
import { approvalResponse } from '../tools/approval.js';
import { invocationCountOf, tool } from '../tools/tool.js';
import { textContent } from '../types/content.js';
import { getMessageSource } from '../types/message.js';
import type { ChatResponse, ChatResponseUpdate } from '../types/response.js';
import { chatResponseUpdate, mergeChatUpdates } from '../types/response.js';
import { Agent } from './agent.js';
import { AgentSession } from './session.js';

function client(...texts: string[]): MockChatClient {
  return new MockChatClient(texts.map((text) => ({ contents: [textContent(text)], finishReason: 'stop' })));
}

/** Narrows away undefined; a missing value fails the test with a clear error. */
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value');
  return value;
}

describe('Agent.run', () => {
  it('returns a response when awaited and updates when iterated', async () => {
    const response = await new Agent({ client: client('Hello!') }).run('hi');
    expect(response.text).toBe('Hello!');

    const stream = new Agent({ client: client('a', 'b') }).run('hi');
    const chunks: string[] = [];
    for await (const update of stream) {
      chunks.push(update.text);
    }
    expect(chunks.join('')).toBe('a');
    expect((await stream.finalResponse()).text).toBe('a');
  });

  it('refuses a second consumption', async () => {
    const stream = new Agent({ client: client('x') }).run('hi');
    await stream;
    expect(() => stream.then(() => undefined)).toThrow(StreamConsumedError);
  });

  it('stamps agentId and falls back to the agent name for authorName', async () => {
    const agent = new Agent({ client: client('x'), id: 'agent-1', name: 'Weatherman' });
    const response = await agent.run('hi');
    expect(response.agentId).toBe('agent-1');
    expect(response.messages[0]?.authorName).toBe('Weatherman');
  });

  it('keeps history across turns in one session', async () => {
    const mock = client('first', 'second');
    const agent = new Agent({ client: mock, instructions: 'Be brief.' });
    const session = agent.createSession();

    await agent.run('one', { session });
    await agent.run('two', { session });

    // Turn two sees: user(one), assistant(first), user(two).
    const secondCall = must(mock.calls[1]);
    expect(secondCall.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(secondCall.messages[0]?.contents).toEqual([{ type: 'text', text: 'one' }]);
    expect(getMessageSource(must(secondCall.messages[0]))?.sourceType).toBe('ChatHistory');
  });

  it('does not grow history geometrically across turns', async () => {
    const mock = client('a', 'b', 'c');
    const agent = new Agent({ client: mock });
    const session = agent.createSession();
    await agent.run('1', { session });
    await agent.run('2', { session });
    await agent.run('3', { session });
    expect(mock.calls[2]?.messages).toHaveLength(5);
  });

  it('round-trips a session through JSON and keeps the transcript', async () => {
    const mock = client('remembered', 'still here');
    const agent = new Agent({ client: mock });
    const session = agent.createSession();
    await agent.run('hello', { session });

    const restored = agent.deserializeSession(JSON.parse(JSON.stringify(session)));
    expect(restored.sessionId).toBe(session.sessionId);

    await agent.run('again', { session: restored });
    expect(mock.calls[1]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('saves history once per run, not once per tool round', async () => {
    const weather = tool({
      name: 'get_weather',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'sunny',
    });
    const mock = new MockChatClient([
      {
        contents: [{ type: 'function_call', callId: 'c1', name: 'get_weather', arguments: '{}' }],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('It is sunny.')], finishReason: 'stop' },
      { contents: [textContent('ok')], finishReason: 'stop' },
    ]);
    const history = new InMemoryHistoryProvider();
    const agent = new Agent({ client: mock, tools: [weather], historyProvider: history });
    const session = agent.createSession();

    await agent.run('weather?', { session });
    const stored = await history.getMessages(session, session.partition(history.sourceId));

    // user + the full assistant/tool transcript of the run.
    expect(stored[0]?.role).toBe('user');
    expect(stored.some((m) => m.role === 'tool')).toBe(true);
    expect(stored.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('totals the usage of every round of a streamed run', async () => {
    // The whole-run total is what a caller logs once per run, so it has to survive both the tool
    // loop (several model calls) and streaming consumption (usage arrives as a trailing content).
    const weather = tool({
      name: 'get_weather',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'sunny',
    });
    const mock = new MockChatClient([
      {
        contents: [{ type: 'function_call', callId: 'c1', name: 'get_weather', arguments: '{}' }],
        finishReason: 'tool_calls',
        usage: { inputTokenCount: 10, outputTokenCount: 4 },
      },
      {
        contents: [textContent('It is sunny.')],
        finishReason: 'stop',
        usage: { inputTokenCount: 20, outputTokenCount: 6 },
      },
    ]);
    const stream = new Agent({ client: mock, tools: [weather] }).run('weather?');

    for await (const _ of stream) {
      // Drained to the end: the total is only complete once the last update has been seen.
    }

    expect((await stream.finalResponse()).usageDetails).toEqual({
      inputTokenCount: 30,
      outputTokenCount: 10,
    });
  });

  it('merges options run-first with agent options filling the blanks', async () => {
    const mock = client('x');
    const agent = new Agent({
      client: mock,
      instructions: 'Agent instructions.',
      tools: [tool({ name: 'agent_tool', description: 'd', parameters: { type: 'object' } })],
      defaultOptions: { temperature: 0.1, maxTokens: 100, stop: ['agent-stop'] },
    });

    await agent.run('hi', {
      options: { temperature: 0.9, instructions: 'Run instructions.', stop: ['run-stop'] },
      tools: [tool({ name: 'run_tool', description: 'd', parameters: { type: 'object' } })],
    });

    const options = mock.calls[0]?.options as ChatOptions;
    expect(options.temperature).toBe(0.9);
    expect(options.maxTokens).toBe(100);
    expect(options.instructions).toBe('Agent instructions.\nRun instructions.');
    expect(options.stop).toEqual(['run-stop', 'agent-stop']);
    expect(options.tools?.map((t) => t.name)).toEqual(['run_tool', 'agent_tool']);
  });

  it('appends context provider instructions, messages and tools', async () => {
    const mock = client('x');
    const provider: ContextProvider = {
      sourceId: 'memories',
      beforeRun(ctx) {
        ctx.extendInstructions('Remember: the user likes tea.');
        ctx.extendMessages([{ role: 'user', contents: [textContent('earlier note')] }]);
        ctx.extendTools([tool({ name: 'recall', description: 'd', parameters: { type: 'object' } })]);
      },
    };
    const agent = new Agent({ client: mock, instructions: 'Base.', contextProviders: [provider] });

    await agent.run('hi');

    const options = mock.calls[0]?.options as ChatOptions;
    expect(options.instructions).toBe('Base.\nRemember: the user likes tea.');
    expect(options.tools?.map((t) => t.name)).toEqual(['recall']);
    const injected = must(mock.calls[0]?.messages[0]);
    expect(getMessageSource(injected)).toEqual({ sourceType: 'AIContextProvider', sourceId: 'memories' });
  });

  it('calls afterRun with the response, exactly once', async () => {
    const afterRun = vi.fn();
    const agent = new Agent({
      client: client('x'),
      contextProviders: [{ sourceId: 'observer', afterRun }],
    });
    const stream = agent.run('hi');
    await stream;
    await stream.finalResponse();
    expect(afterRun).toHaveBeenCalledTimes(1);
    expect(afterRun.mock.calls[0]?.[0].response.text).toBe('x');
  });

  it('calls afterRun with the error when the run fails', async () => {
    const afterRun = vi.fn();
    const failing = {
      metadata: { providerName: 'mock' },
      getResponse: () => {
        throw new Error('provider exploded');
      },
    };
    const agent = new Agent({
      client: failing as never,
      contextProviders: [{ sourceId: 'observer', afterRun }],
    });

    await expect(agent.run('hi')).rejects.toThrow('provider exploded');
    expect(afterRun).toHaveBeenCalledTimes(1);
    expect(afterRun.mock.calls[0]?.[0].error).toBeInstanceOf(Error);
  });

  it('calls afterRun with the error when the run is aborted between pulls', async () => {
    // An abort detected between pulls is raised by the stream wrapper, not by the source
    // generator, so the generator's own `catch` never sees it. .NET reaches the equivalent path
    // through the `catch` around every `MoveNextAsync()` and notifies providers of the failure
    // (`ChatClientAgent.RunCoreStreamingAsync`), so a provider always learns the run is over.
    const afterRun = vi.fn();
    const controller = new AbortController();
    const agent = new Agent({
      client: new MockChatClient([{ contents: [textContent('a'), textContent('b')] }]),
      contextProviders: [{ sourceId: 'observer', afterRun }],
    });

    const stream = agent.run('hi', { signal: controller.signal });
    await expect(
      (async () => {
        for await (const _ of stream) {
          controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(afterRun).toHaveBeenCalledTimes(1);
    expect(afterRun.mock.calls[0]?.[0].error).toMatchObject({ name: 'AbortError' });
    expect(afterRun.mock.calls[0]?.[0].response).toBeUndefined();
  });

  it('calls afterRun with the error when the consumer throws into the stream', async () => {
    const afterRun = vi.fn();
    const agent = new Agent({
      client: new MockChatClient([{ contents: [textContent('a'), textContent('b')] }]),
      contextProviders: [{ sourceId: 'observer', afterRun }],
    });

    const iterator = agent.run('hi')[Symbol.asyncIterator]();
    await iterator.next();
    const boom = new Error('consumer gave up');
    await expect(iterator.throw?.(boom)).rejects.toBe(boom);

    expect(afterRun).toHaveBeenCalledTimes(1);
    expect(afterRun.mock.calls[0]?.[0].error).toBe(boom);
  });

  it('parses structured output into value', async () => {
    const mock = new MockChatClient([
      { contents: [textContent('{"name":"Taro","age":30}')], finishReason: 'stop' },
    ]);
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) => ({ value: value as { name: string; age: number } }),
      },
      toJsonSchema: () => ({
        type: 'object',
        properties: { name: { type: 'string' }, age: { type: 'number' } },
        required: ['name', 'age'],
      }),
    };

    const response = await new Agent({ client: mock }).run('Taro is 30', { responseFormat: schema as never });
    expect(response.value).toEqual({ name: 'Taro', age: 30 });
    expect(must(mock.calls[0]?.options).responseFormat).toBe(schema);
  });

  it('fills value for every responseFormat path', async () => {
    // Regression: defaultOptions and run options used to reach the provider without ever
    // being parsed, so `value` silently stayed undefined on two of the three paths.
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) => ({ value: value as { name: string } }),
      },
      toJsonSchema: () => ({ type: 'object', properties: { name: { type: 'string' } } }),
    };
    const turn = { contents: [textContent('{"name":"Taro"}')], finishReason: 'stop' };

    const explicit = await new Agent({ client: new MockChatClient([turn]) }).run('x', {
      responseFormat: schema as never,
    });
    const viaDefaults = await new Agent({
      client: new MockChatClient([turn]),
      defaultOptions: { responseFormat: schema as never },
    }).run('x');
    const viaRunOptions = await new Agent({ client: new MockChatClient([turn]) }).run('x', {
      options: { responseFormat: schema as never },
    });

    expect(explicit.value).toEqual({ name: 'Taro' });
    expect(viaDefaults.value).toEqual({ name: 'Taro' });
    expect(viaRunOptions.value).toEqual({ name: 'Taro' });
  });

  it('lets the explicit responseFormat parameter win over defaultOptions', async () => {
    const fromDefaults = { toJsonSchema: () => ({ type: 'string' }) };
    const mock = new MockChatClient([{ contents: [textContent('{"a":1}')], finishReason: 'stop' }]);
    const explicit = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) => ({ value }),
      },
      toJsonSchema: () => ({ type: 'object' }),
    };

    const response = await new Agent({
      client: mock,
      defaultOptions: { responseFormat: fromDefaults as never },
    }).run('x', { responseFormat: explicit as never });

    expect(response.value).toEqual({ a: 1 });
    expect(must(mock.calls[0]?.options).responseFormat).toBe(explicit);
  });

  it('fills value when the run is streamed', async () => {
    const mock = new MockChatClient([{ contents: [textContent('{"name":"Taro"}')], finishReason: 'stop' }]);
    const stream = new Agent({ client: mock }).run('x', {
      responseFormat: { toJsonSchema: () => ({ type: 'object' }) } as never,
    });
    const texts: string[] = [];
    for await (const update of stream) {
      texts.push(update.text);
    }
    expect(texts.join('')).toBe('{"name":"Taro"}');
    expect((await stream.finalResponse()).value).toEqual({ name: 'Taro' });
  });

  it('surfaces the approval request instead of failing when responseFormat is set', async () => {
    // Regression: the eager structured-output parse used to throw
    // "the model returned no text" on the approval-interrupted turn, so the caller never saw
    // `userInputRequests`. A suspended response skips the parse; the resumed run parses normally.
    const guarded = tool({
      name: 'wipe',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      approvalMode: 'always_require',
      execute: async () => 'wiped',
    });
    const format = { toJsonSchema: () => ({ type: 'object' }) };
    const mock = new MockChatClient([
      {
        contents: [{ type: 'function_call', callId: 'c1', name: 'wipe', arguments: '{}' }],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('{"ok":true}')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client: mock, tools: [guarded] });
    const session = agent.createSession();

    const first = await agent.run('go', { session, responseFormat: format as never });
    expect(first.userInputRequests).toHaveLength(1);
    expect(first.value).toBeUndefined();

    const [firstRequest] = first.userInputRequests;
    if (firstRequest?.type !== 'function_approval_request') {
      throw new Error('expected an approval request');
    }
    const resumed = await agent.run(approvalResponse(firstRequest, true), {
      session,
      responseFormat: format as never,
    });
    expect(resumed.value).toEqual({ ok: true });
  });

  it('surfaces a plain tool’s user-input request through the parent response', async () => {
    // `UserInputRequiredError` is part of the package's public surface, so an ordinary tool — not
    // only `agent.asTool()` — may raise it. Python raises it from a plain `@tool` in
    // `test_user_input_request_propagates_through_as_tool`, and expects the request on the parent
    // response rather than a rejected run.
    const consenting = tool({
      name: 'connect_mailbox',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        throw new UserInputRequiredError([
          { type: 'oauth_consent_request', consentLink: 'https://example.test/consent' },
        ]);
      },
    });
    const mock = new MockChatClient([
      {
        contents: [{ type: 'function_call', callId: 'c1', name: 'connect_mailbox', arguments: '{}' }],
        finishReason: 'tool_calls',
      },
    ]);

    const response = await new Agent({ client: mock, tools: [consenting] }).run('connect it');

    expect(mock.callCount).toBe(1);
    expect(response.userInputRequests).toEqual([
      expect.objectContaining({
        type: 'oauth_consent_request',
        callId: 'c1',
        id: 'c1',
        userInputRequest: true,
        consentLink: 'https://example.test/consent',
      }),
    ]);
    // Nothing is reported to the model: there is no result it could act on.
    expect(response.messages.flatMap((m) => m.contents).filter((c) => c.type === 'function_result')).toEqual(
      [],
    );
  });

  it('binds every request of one raise to the outer call', async () => {
    // Python `test_user_input_request_multiple_contents_propagate`: all three requests reach the
    // parent response, and the tool is still counted as a single invocation.
    const multi = tool({
      name: 'multi_request',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      maxInvocations: 5,
      execute: async () => {
        throw new UserInputRequiredError([
          { type: 'oauth_consent_request', consentLink: 'https://example.test/1' },
          { type: 'oauth_consent_request', consentLink: 'https://example.test/2' },
          { type: 'oauth_consent_request', consentLink: 'https://example.test/3' },
        ]);
      },
    });
    const mock = new MockChatClient([
      {
        contents: [{ type: 'function_call', callId: 'c1', name: 'multi_request', arguments: '{}' }],
        finishReason: 'tool_calls',
      },
    ]);

    const response = await new Agent({ client: mock, tools: [multi] }).run('do it');

    expect(response.userInputRequests).toHaveLength(3);
    expect(response.userInputRequests.every((request) => request.callId === 'c1')).toBe(true);
    expect(
      response.userInputRequests.map((request) =>
        request.type === 'oauth_consent_request' ? request.consentLink : undefined,
      ),
    ).toEqual(['https://example.test/1', 'https://example.test/2', 'https://example.test/3']);
    expect(invocationCountOf(multi)).toBe(1);
  });

  it('persists history when the caller abandons the stream early', async () => {
    const mock = new MockChatClient([
      { contents: [textContent('a'), textContent('b'), textContent('c')], finishReason: 'stop' },
    ]);
    const history = new InMemoryHistoryProvider();
    const agent = new Agent({ client: mock, historyProvider: history });
    const session = agent.createSession();

    const stream = agent.run('hi', { session });
    for await (const _ of stream) {
      break;
    }

    // The abandoned run still saved the input and the partial response.
    const stored = await history.getMessages(session, session.partition(history.sourceId));
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(stored[0]?.contents).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('does not parse structured output when the caller abandons the stream', async () => {
    // `break` is a legitimate way to stop reading, so it must not throw. The text left behind is
    // truncated wherever the caller stopped, which is not a model failure — both reference
    // implementations parse lazily (.NET `AgentResponse{T}.Result`, Python `AgentResponse.value`)
    // and so never raise here.
    const afterRun = vi.fn();
    const mock = new MockChatClient([
      { contents: [textContent('{"na'), textContent('me":"Taro"}')], finishReason: 'stop' },
    ]);
    const agent = new Agent({
      client: mock,
      contextProviders: [{ sourceId: 'observer', afterRun }],
    });

    const stream = agent.run('hi', { responseFormat: { toJsonSchema: () => ({ type: 'object' }) } as never });
    for await (const _ of stream) {
      break;
    }

    // Abandoned, not failed: providers still saw the partial turn and `value` is simply absent.
    expect(afterRun).toHaveBeenCalledTimes(1);
    expect(afterRun.mock.calls[0]?.[0].error).toBeUndefined();
    expect((await stream.finalResponse()).value).toBeUndefined();
  });

  it('still parses structured output for a stream read to the end', async () => {
    // The abandonment guard must not swallow a real parse failure on a completed run.
    const mock = new MockChatClient([{ contents: [textContent('not json')], finishReason: 'stop' }]);
    const agent = new Agent({ client: mock });
    const stream = agent.run('hi', { responseFormat: { toJsonSchema: () => ({ type: 'object' }) } as never });
    await expect(
      (async () => {
        for await (const _ of stream) {
          // read to exhaustion
        }
      })(),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('persists the turn before parsing structured output, so a parse failure keeps it', async () => {
    const afterRun = vi.fn();
    const mock = new MockChatClient([{ contents: [textContent('not json')], finishReason: 'stop' }]);
    const history = new InMemoryHistoryProvider();
    const agent = new Agent({
      client: mock,
      historyProvider: history,
      contextProviders: [{ sourceId: 'observer', afterRun }],
    });
    const session = agent.createSession();

    await expect(
      agent.run('hi', {
        session,
        responseFormat: { toJsonSchema: () => ({ type: 'object' }) } as never,
      }),
    ).rejects.toThrow(/not valid JSON/);

    // Providers saw the successful run — the model did answer — and the transcript survived, so
    // the next turn can ask the model to correct itself.
    expect(afterRun).toHaveBeenCalledTimes(1);
    expect(afterRun.mock.calls[0]?.[0].error).toBeUndefined();
    expect(afterRun.mock.calls[0]?.[0].response).toBeDefined();
    const stored = await history.getMessages(session, session.partition(history.sourceId));
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('propagates AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new Agent({ client: client('x') }).run('hi', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not complete a run whose provider stream ended silently on an abort', async () => {
    // Both provider SDKs end an interrupted stream by returning rather than throwing, so the
    // interruption reaches the agent as a *clean* end of iteration. Folding that into a normal
    // response would hand the caller a truncated turn with no error attached — and a hosted turn
    // would be persisted as `completed`.
    const controller = new AbortController();
    const silent: ChatClient<ChatOptions> = {
      metadata: { providerName: 'silent-abort' },
      getResponse: (_messages, options) =>
        createResponseStream<ChatResponseUpdate, ChatResponse<undefined>>({
          start: async function* () {
            yield chatResponseUpdate({ role: 'assistant', contents: [textContent('He')] });
            controller.abort();
          },
          finalize: (updates) => mergeChatUpdates<undefined>(updates),
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        }),
    };

    await expect(
      new Agent({ client: silent }).run('hi', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('Agent construction', () => {
  it('rejects colliding provider state keys', () => {
    const a: ContextProvider = { sourceId: 'shared' };
    const b: ContextProvider = { sourceId: 'other', stateKeys: ['shared'] };
    expect(() => new Agent({ client: client('x'), contextProviders: [a, b] })).toThrow(ConfigurationError);
  });

  it('rejects a duplicate sourceId', () => {
    const a: ContextProvider = { sourceId: 'dup' };
    const b: ContextProvider = { sourceId: 'dup' };
    expect(() => new Agent({ client: client('x'), contextProviders: [a, b] })).toThrow(ConfigurationError);
  });

  it('rejects a provider claiming the reserved tool-approval state key', () => {
    const provider: ContextProvider = { sourceId: '_toolApproval' };
    expect(() => new Agent({ client: client('x'), contextProviders: [provider] })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects a history provider passed as a context provider', () => {
    const history = new InMemoryHistoryProvider();
    expect(() => new Agent({ client: client('x'), contextProviders: [history] })).toThrow(ConfigurationError);
  });

  it('rejects anything that is not a middleware object', () => {
    expect(() => new Agent({ client: client('x'), middleware: [{} as never] })).toThrow(ConfigurationError);
    expect(() => new Agent({ client: client('x') }).run('hi', { middleware: [(() => {}) as never] })).toThrow(
      ConfigurationError,
    );
  });
});

describe('service-managed sessions', () => {
  it('errors when an explicit history provider meets a serviceSessionId', async () => {
    const agent = new Agent({ client: client('x'), historyProvider: new InMemoryHistoryProvider() });
    const session = agent.createSession({ serviceSessionId: 'conv_1' });
    await expect(agent.run('hi', { session })).rejects.toThrow(ConfigurationError);
  });

  it('steps the default history provider aside and forwards the conversation id', async () => {
    const mock = client('x');
    const agent = new Agent({ client: mock });
    const session = agent.createSession({ serviceSessionId: 'conv_1' });

    await agent.run('hi', { session });

    expect(must(mock.calls[0]?.options).conversationId).toBe('conv_1');
    expect(session.state).toEqual({});
  });
});

describe('AgentSession', () => {
  it('round-trips through JSON.stringify', () => {
    const session = new AgentSession({ sessionId: 's1', serviceSessionId: 'conv_1' });
    session.partition('provider').a = 1;

    const restored = AgentSession.fromJSON(JSON.parse(JSON.stringify(session)));
    expect(restored.sessionId).toBe('s1');
    expect(restored.serviceSessionId).toBe('conv_1');
    expect(restored.state).toEqual({ provider: { a: 1 } });
  });

  it('rejects data that is not a serialized session', () => {
    expect(() => AgentSession.fromJSON({ nope: true })).toThrow(ConfigurationError);
  });
});

describe('InMemoryHistoryProvider', () => {
  it('never re-saves messages it injected itself', async () => {
    const provider: HistoryProvider = new InMemoryHistoryProvider();
    const mock = client('a', 'b');
    const agent = new Agent({ client: mock, historyProvider: provider });
    const session = agent.createSession();

    await agent.run('one', { session });
    await agent.run('two', { session });

    const stored = await provider.getMessages(session, session.partition(provider.sourceId));
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('partitions state under the Python-compatible default source id', () => {
    // Python `InMemoryHistoryProvider.DEFAULT_SOURCE_ID` is 'in_memory'; the partition name is
    // part of the serialized session, so it has to line up for cross-language session state.
    expect(new InMemoryHistoryProvider().sourceId).toBe('in_memory');
  });
});
