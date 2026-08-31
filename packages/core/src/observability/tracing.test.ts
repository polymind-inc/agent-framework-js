import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, assert, beforeAll, describe, expect, it } from 'vitest';
import { Agent } from '../agent/agent.js';
import { withChatTelemetry } from '../client/telemetry.js';
import { MockChatClient } from '../client/test-support.js';
import { tool } from '../tools/tool.js';
import { textContent } from '../types/content.js';
import { message } from '../types/message.js';
import { agentResponse } from '../types/response.js';
import { GEN_AI, MCP, SERVER } from './attributes.js';
import { configureObservability, getTracer } from './settings.js';
import { addMessageEvents, responseFinishReason, setMessageContent, startAgentRunSpan } from './tracing.js';

const exporter = new InMemorySpanExporter();
/** Names of spans that were *started*, whether or not they were ended. */
const startedSpanNames: string[] = [];
const startRecorder: SpanProcessor = {
  onStart(span) {
    startedSpanNames.push(span.name);
  },
  onEnd() {},
  shutdown: () => Promise.resolve(),
  forceFlush: () => Promise.resolve(),
};
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter), startRecorder],
});

const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  // Span nesting needs a context manager, which is what NodeSDK registers in a real deployment.
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

afterEach(() => {
  exporter.reset();
  startedSpanNames.length = 0;
  configureObservability({});
});

/** Finished spans, oldest first. */
function spans(): ReadableSpan[] {
  return exporter.getFinishedSpans();
}

function byName(name: string): ReadableSpan | undefined {
  return spans().find((span) => span.name === name);
}

/** The name of `span`'s parent, or undefined at the root. */
function parentOf(span: ReadableSpan): string | undefined {
  const parentId = span.parentSpanContext?.spanId;
  return spans().find((candidate) => candidate.spanContext().spanId === parentId)?.name;
}

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
  execute: async () => 'sunny',
});

describe('GenAI tracing', () => {
  it('nests chat and execute_tool under invoke_agent', async () => {
    const mock = new MockChatClient([
      {
        contents: [{ type: 'function_call', callId: 'c1', name: 'get_weather', arguments: '{}' }],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('It is sunny.')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client: mock, name: 'weather-bot', tools: [getWeather] });

    await agent.run('weather?');

    const invoke = byName('invoke_agent weather-bot');
    assert.exists(invoke);
    // Two model rounds, one tool execution, all under the agent span.
    expect(spans().filter((s) => s.name === 'chat mock-model')).toHaveLength(2);
    const execute = byName('execute_tool get_weather');
    assert.exists(execute);
    expect(parentOf(execute)).toBe('invoke_agent weather-bot');
    expect(
      spans()
        .filter((s) => s.name === 'chat mock-model')
        .map(parentOf),
    ).toEqual(['invoke_agent weather-bot', 'invoke_agent weather-bot']);
    expect(parentOf(invoke)).toBeUndefined();
  });

  it('ends the run span when capturing the input messages fails', async () => {
    configureObservability({ captureMessageContent: true });
    const mock = new MockChatClient([{ contents: [textContent('ok')], finishReason: 'stop' }]);
    const agent = new Agent({ client: mock, name: 'leaky-bot' });

    // A BigInt has no JSON serialization, so recording the input messages throws after the span
    // has already been started; the failure must still end the span it started.
    const poisoned = message('user', [{ type: 'text', text: 1n as unknown as string }]);
    await expect(agent.run(poisoned)).rejects.toThrow(/BigInt/);

    expect(startedSpanNames).toContain('invoke_agent leaky-bot');
    const invoke = byName('invoke_agent leaky-bot');
    assert.exists(invoke);
    expect(invoke.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('nests the same way when the caller streams', async () => {
    const mock = new MockChatClient([
      {
        contents: [{ type: 'function_call', callId: 'c1', name: 'get_weather', arguments: '{}' }],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('It is sunny.')], finishReason: 'stop' },
    ]);

    for await (const _ of new Agent({ client: mock, name: 'weather-bot', tools: [getWeather] }).run('x')) {
      // drain
    }

    const execute = byName('execute_tool get_weather');
    assert.exists(execute);
    expect(parentOf(execute)).toBe('invoke_agent weather-bot');
    expect(
      spans()
        .filter((s) => s.name === 'chat mock-model')
        .map(parentOf),
    ).toEqual(['invoke_agent weather-bot', 'invoke_agent weather-bot']);
  });

  it('closes each chat span before that round runs its tools', async () => {
    const mock = new MockChatClient([
      {
        contents: [{ type: 'function_call', callId: 'c1', name: 'get_weather', arguments: '{}' }],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);

    await new Agent({ client: mock, tools: [getWeather] }).run('weather?');

    // The exporter records spans in completion order, so this is what proves the placement
    // decision: the first chat is already finished when the tool runs.
    expect(spans().map((s) => s.name.split(' ')[0])).toEqual([
      'chat',
      'execute_tool',
      'chat',
      'invoke_agent',
    ]);
  });

  it('records the required GenAI attributes', async () => {
    const mock = new MockChatClient([{ contents: [textContent('hi')], finishReason: 'stop' }]);
    const agent = new Agent({
      client: mock,
      name: 'bot',
      description: 'a bot',
      defaultOptions: { temperature: 0.5, maxTokens: 100 },
    });

    await agent.run('hello');

    const invoke = byName('invoke_agent bot');
    assert.exists(invoke);
    expect(invoke.attributes[GEN_AI.operation]).toBe('invoke_agent');
    expect(invoke.attributes[GEN_AI.agentName]).toBe('bot');
    expect(invoke.attributes[GEN_AI.agentDescription]).toBe('a bot');
    expect(invoke.attributes[GEN_AI.agentId]).toBe(agent.id);
    expect(invoke.attributes[GEN_AI.providerName]).toBe('mock');
    expect(invoke.attributes[GEN_AI.finishReasons]).toEqual(['stop']);

    const chat = byName('chat mock-model');
    assert.exists(chat);
    expect(chat.attributes[GEN_AI.operation]).toBe('chat');
    expect(chat.attributes[GEN_AI.providerName]).toBe('mock');
    expect(chat.attributes[GEN_AI.requestModel]).toBe('mock-model');
    expect(chat.attributes[GEN_AI.temperature]).toBe(0.5);
    expect(chat.attributes[GEN_AI.maxTokens]).toBe(100);
    expect(chat.attributes[GEN_AI.responseId]).toBe('resp_1');
  });

  it('spells the server keys one way for chat spans and MCP spans alike', () => {
    // `isolatedDeclarations` forbids MCP referencing SERVER for these two, so the duplicate
    // literals are held together here instead: one key, one vocabulary, whichever span carries it.
    expect(MCP.serverAddress).toBe(SERVER.address);
    expect(MCP.serverPort).toBe(SERVER.port);
  });

  it('records the endpoint host as server.address on the chat span', async () => {
    const mock = new MockChatClient([{ contents: [textContent('hi')], finishReason: 'stop' }], {
      providerUri: 'https://api.example.com/openai/v1',
    });

    await new Agent({ client: mock, name: 'bot' }).run('hello');

    const chat = byName('chat mock-model');
    assert.exists(chat);
    expect(chat.attributes[SERVER.address]).toBe('api.example.com');
    // Only the chat span names an endpoint: the agent span describes the agent, not the
    // connection, so the reference implementations leave the address off it.
    expect(byName('invoke_agent bot')?.attributes[SERVER.address]).toBeUndefined();
  });

  it("reports server.address as 'unknown' when the client names no endpoint", async () => {
    const mock = new MockChatClient([{ contents: [textContent('hi')], finishReason: 'stop' }]);

    await new Agent({ client: mock, name: 'bot' }).run('hello');

    const chat = byName('chat mock-model');
    assert.exists(chat);
    expect(chat.attributes[SERVER.address]).toBe('unknown');
  });

  it("reports server.address as 'unknown' when the endpoint is not a parseable URL", async () => {
    const mock = new MockChatClient([{ contents: [textContent('hi')], finishReason: 'stop' }], {
      providerUri: 'api.example.com',
    });

    await new Agent({ client: mock, name: 'bot' }).run('hello');

    expect(byName('chat mock-model')?.attributes[SERVER.address]).toBe('unknown');
  });

  it('records the tool call id and type on execute_tool', async () => {
    const mock = new MockChatClient([
      {
        contents: [{ type: 'function_call', callId: 'call_42', name: 'get_weather', arguments: '{}' }],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);

    await new Agent({ client: mock, tools: [getWeather] }).run('weather?');

    const execute = byName('execute_tool get_weather');
    assert.exists(execute);
    expect(execute.attributes[GEN_AI.toolName]).toBe('get_weather');
    expect(execute.attributes[GEN_AI.toolCallId]).toBe('call_42');
    expect(execute.attributes[GEN_AI.toolType]).toBe('function');
    expect(execute.attributes[GEN_AI.toolDescription]).toBe('Get the weather');
  });

  it('starts no chat span until the stream is consumed', async () => {
    // Regression: the span used to start inside `getResponse`, so an
    // unconsumed stream leaked a started-but-never-ended span.
    const mock = new MockChatClient([{ contents: [textContent('x')], finishReason: 'stop' }]);
    const telemetered = withChatTelemetry(mock);

    const stream = telemetered.getResponse([{ role: 'user', contents: [textContent('hi')] }]);
    expect(startedSpanNames.filter((name) => name.startsWith('chat'))).toHaveLength(0);

    await stream;
    expect(startedSpanNames.filter((name) => name.startsWith('chat'))).toHaveLength(1);
    // And the span that did start was also ended.
    expect(byName('chat mock-model')).toBeDefined();
  });

  it('keeps message content off spans until it is opted in', async () => {
    const mock = new MockChatClient([{ contents: [textContent('secret answer')], finishReason: 'stop' }]);
    await new Agent({ client: mock, name: 'bot' }).run('secret question');

    const invoke = byName('invoke_agent bot');
    assert.exists(invoke);
    expect(invoke.attributes[GEN_AI.inputMessages]).toBeUndefined();
    expect(invoke.attributes[GEN_AI.outputMessages]).toBeUndefined();
  });

  it('keeps system instructions off the chat span until content capture is opted in', async () => {
    // Regression: instructions used to be stamped unconditionally, leaking prompt
    // text with capture off. The reference implementations emit the attribute only when
    // sensitive-data capture is enabled.
    const mock = new MockChatClient([{ contents: [textContent('x')], finishReason: 'stop' }]);
    await new Agent({ client: mock, name: 'bot', instructions: 'You are terse.' }).run('q');

    const chat = byName('chat mock-model');
    assert.exists(chat);
    expect(chat.attributes[GEN_AI.systemInstructions]).toBeUndefined();
  });

  it('records system instructions as a parts array once opted in', async () => {
    configureObservability({ captureMessageContent: true });
    const mock = new MockChatClient([{ contents: [textContent('x')], finishReason: 'stop' }]);
    await new Agent({ client: mock, name: 'bot', instructions: 'You are terse.' }).run('q');

    const chat = byName('chat mock-model');
    assert.exists(chat);
    expect(chat.attributes[GEN_AI.systemInstructions]).toBe(
      JSON.stringify([{ type: 'text', content: 'You are terse.' }]),
    );
  });

  it('records message content once opted in', async () => {
    configureObservability({ captureMessageContent: true });
    const mock = new MockChatClient([{ contents: [textContent('the answer')], finishReason: 'stop' }]);

    await new Agent({ client: mock, name: 'bot' }).run('the question');

    const invoke = byName('invoke_agent bot');
    assert.exists(invoke);
    expect(String(invoke.attributes[GEN_AI.inputMessages])).toContain('the question');
    expect(String(invoke.attributes[GEN_AI.outputMessages])).toContain('the answer');
  });

  it('records tool arguments and results only when opted in', async () => {
    const turns = [
      {
        contents: [
          {
            type: 'function_call' as const,
            callId: 'c1',
            name: 'get_weather',
            arguments: '{"city":"Tokyo"}',
          },
        ],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('done')], finishReason: 'stop' },
    ];

    await new Agent({ client: new MockChatClient(turns), tools: [getWeather] }).run('x');
    expect(byName('execute_tool get_weather')?.attributes[GEN_AI.toolArguments]).toBeUndefined();

    exporter.reset();
    configureObservability({ captureMessageContent: true });
    await new Agent({ client: new MockChatClient(turns), tools: [getWeather] }).run('x');

    const execute = byName('execute_tool get_weather');
    assert.exists(execute);
    expect(execute.attributes[GEN_AI.toolArguments]).toBe('{"city":"Tokyo"}');
    expect(execute.attributes[GEN_AI.toolResult]).toBe('sunny');
  });

  it('marks a failed run on the span', async () => {
    const failing = {
      metadata: { providerName: 'mock' },
      getResponse: () => {
        throw new Error('boom');
      },
    };

    await expect(new Agent({ client: failing as never, name: 'bot' }).run('x')).rejects.toThrow('boom');

    const invoke = byName('invoke_agent bot');
    assert.exists(invoke);
    expect(invoke.attributes[GEN_AI.errorType]).toBe('Error');
    expect(invoke.status.code).toBe(2);
  });

  it('ends the agent span when the caller abandons the stream', async () => {
    const mock = new MockChatClient([
      { contents: [textContent('a'), textContent('b'), textContent('c')], finishReason: 'stop' },
    ]);

    for await (const _ of new Agent({ client: mock, name: 'bot' }).run('x')) {
      break;
    }

    expect(byName('invoke_agent bot')).toBeDefined();
  });

  it('ends both spans when an abort fires between pulls', async () => {
    // Regression: an abort detected in `#next` *before* pulling the source never
    // reaches the generator, so neither the chat span's catch nor `onResult` ran — both the chat
    // and invoke_agent spans leaked. The cleanup hook now receives the failure directly.
    const mock = new MockChatClient([
      { contents: [textContent('a'), textContent('b')], finishReason: 'stop' },
    ]);
    const controller = new AbortController();
    const stream = new Agent({ client: mock, name: 'bot' }).run('x', { signal: controller.signal });

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort(new Error('stop now'));
    await expect(iterator.next()).rejects.toThrow('stop now');

    const invoke = byName('invoke_agent bot');
    assert.exists(invoke);
    expect(invoke.status.code).toBe(2);
    expect(byName('chat mock-model')).toBeDefined();
  });

  it('ends the chat span when the consumer throws into the stream', async () => {
    const mock = new MockChatClient([
      { contents: [textContent('a'), textContent('b')], finishReason: 'stop' },
    ]);
    const stream = withChatTelemetry(mock).getResponse([{ role: 'user', contents: [textContent('hi')] }]);

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.throw?.(new Error('consumer bailed'))).rejects.toThrow('consumer bailed');

    const chat = byName('chat mock-model');
    assert.exists(chat);
    expect(chat.status.code).toBe(2);
  });
});

describe('startAgentRunSpan', () => {
  /** Stands in for an agent implemented against a remote protocol rather than a chat client. */
  async function* remoteUpdates(): AsyncGenerator<string> {
    // A span started while the source is pulled must land under the run span, which only holds if
    // the context is entered around each pull rather than once at construction.
    getTracer().startSpan('http POST').end();
    yield 'part';
  }

  it('reports the same span an agent run does', async () => {
    const span = startAgentRunSpan(
      {
        id: 'a1',
        name: 'remote-bot',
        description: 'Answers remotely',
        providerName: 'a2a',
        conversationId: 'ctx-1',
      },
      [{ role: 'user', contents: [textContent('hi')] }],
    );

    for await (const _ of span.active(remoteUpdates())) {
      // Drain.
    }
    span.setResponse(
      agentResponse({
        messages: [{ role: 'assistant', contents: [textContent('hi back')] }],
        responseId: 'resp-1',
        finishReason: 'stop',
      }),
    );
    span.end();

    const run = byName('invoke_agent remote-bot');
    assert.exists(run);
    expect(run.attributes[GEN_AI.operation]).toBe('invoke_agent');
    expect(run.attributes[GEN_AI.agentId]).toBe('a1');
    expect(run.attributes[GEN_AI.agentName]).toBe('remote-bot');
    expect(run.attributes[GEN_AI.providerName]).toBe('a2a');
    expect(run.attributes[GEN_AI.conversationId]).toBe('ctx-1');
    expect(run.attributes[GEN_AI.responseId]).toBe('resp-1');
    expect(run.attributes[GEN_AI.finishReasons]).toEqual(['stop']);
    const http = byName('http POST');
    assert.exists(http);
    expect(parentOf(http)).toBe('invoke_agent remote-bot');
  });

  it('records a failure and ends only once', () => {
    const span = startAgentRunSpan({ id: 'a1', providerName: 'a2a' });

    span.setError(new TypeError('boom'));
    span.end();
    span.end();

    const run = byName('invoke_agent a1');
    assert.exists(run);
    expect(run.status.code).toBe(2);
    expect(run.attributes[GEN_AI.errorType]).toBe('TypeError');
    expect(spans().filter((candidate) => candidate.name === 'invoke_agent a1')).toHaveLength(1);
  });

  it('captures messages only when the caller opted in', async () => {
    configureObservability({ captureMessageContent: true });
    const span = startAgentRunSpan({ id: 'a1' }, [{ role: 'user', contents: [textContent('secret')] }]);
    span.end();

    const captured = byName('invoke_agent a1');
    assert.exists(captured);
    expect(captured.attributes[GEN_AI.inputMessages]).toContain('secret');

    configureObservability({ captureMessageContent: false });
    const quiet = startAgentRunSpan({ id: 'a2' }, [{ role: 'user', contents: [textContent('secret')] }]);
    quiet.end();

    const quietSpan = byName('invoke_agent a2');
    assert.exists(quietSpan);
    expect(quietSpan.attributes[GEN_AI.inputMessages]).toBeUndefined();
  });

  it('ends the span itself when recording the input messages throws', () => {
    configureObservability({ captureMessageContent: true });
    // `JSON.stringify` throws on a BigInt, standing in for any caller-supplied content the
    // serializer cannot encode.
    const poisoned = [{ role: 'user', contents: [{ type: 'text', text: 1n as unknown as string }] }];

    expect(() => startAgentRunSpan({ id: 'a1' }, poisoned as never)).toThrow(TypeError);

    // The factory never handed the span out, so nobody else could have closed it: an unclosed
    // span here is a leak that outlives the failed run.
    const run = byName('invoke_agent a1');
    assert.exists(run);
    expect(run.status.code).toBe(2);
    expect(startedSpanNames).toContain('invoke_agent a1');
  });

  it('awaits a non-streaming call inside the span', async () => {
    const span = startAgentRunSpan({ id: 'a1' });

    await span.awaited(async () => {
      getTracer().startSpan('http POST').end();
    });
    span.end();

    const http = byName('http POST');
    assert.exists(http);
    expect(parentOf(http)).toBe('invoke_agent a1');
  });
});

describe('v1.36.0 message events', () => {
  /** A tool round followed by a text answer, so every event kind appears somewhere. */
  const toolTurns = [
    {
      contents: [
        {
          type: 'function_call' as const,
          callId: 'c1',
          name: 'get_weather',
          arguments: '{"city":"Tokyo"}',
        },
      ],
      finishReason: 'tool_calls',
    },
    { contents: [textContent('It is sunny.')], finishReason: 'stop' },
  ];

  /** The JSON-decoded `body` attribute of each event on `span`, keyed by event name. */
  function eventBodies(span: ReadableSpan): Array<{ name: string; body: unknown }> {
    return span.events.map((event) => ({
      name: event.name,
      body: JSON.parse(String(event.attributes?.body)),
    }));
  }

  it('keeps message events off the invoke_agent span', async () => {
    configureObservability({ captureMessageContent: true });
    await new Agent({ client: new MockChatClient(toolTurns), name: 'bot', tools: [getWeather] }).run(
      'weather?',
    );

    const invoke = byName('invoke_agent bot');
    assert.exists(invoke);
    // The reference implementations emit message events only for the model invocation; the agent
    // span reports content as span attributes alone.
    expect(invoke.events).toEqual([]);
    expect(invoke.attributes[GEN_AI.inputMessages]).toBeDefined();
    expect(invoke.attributes[GEN_AI.outputMessages]).toBeDefined();
  });

  it('emits v1.36.0-shaped events on each chat span', async () => {
    configureObservability({ captureMessageContent: true });
    await new Agent({
      client: new MockChatClient(toolTurns),
      name: 'bot',
      tools: [getWeather],
      instructions: 'Be terse.',
    }).run('weather?');

    const chats = spans().filter((span) => span.name === 'chat mock-model');
    expect(chats).toHaveLength(2);
    const [firstChat, secondChat] = chats;
    assert.exists(firstChat);
    assert.exists(secondChat);

    // First round: instructions, the user turn, then the model's tool-calling choice.
    expect(eventBodies(firstChat)).toEqual([
      { name: 'gen_ai.system.message', body: { content: 'Be terse.' } },
      { name: 'gen_ai.user.message', body: { content: 'weather?' } },
      {
        name: 'gen_ai.choice',
        body: {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
              },
            ],
          },
        },
      },
    ]);

    // Second round replays the whole exchange: the assistant's call, the tool result, the answer.
    expect(eventBodies(secondChat)).toEqual([
      { name: 'gen_ai.system.message', body: { content: 'Be terse.' } },
      { name: 'gen_ai.user.message', body: { content: 'weather?' } },
      {
        name: 'gen_ai.assistant.message',
        body: {
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
            },
          ],
        },
      },
      { name: 'gen_ai.tool.message', body: { id: 'c1', content: 'sunny' } },
      {
        name: 'gen_ai.choice',
        body: { index: 0, finish_reason: 'stop', message: { content: 'It is sunny.' } },
      },
    ]);
  });

  it('stamps the provider on every event and steps the timestamps', async () => {
    configureObservability({ captureMessageContent: true });
    await new Agent({ client: new MockChatClient(toolTurns), name: 'bot', tools: [getWeather] }).run(
      'weather?',
    );

    const chat = spans().find((span) => span.name === 'chat mock-model');
    assert.exists(chat);
    expect(chat.events.length).toBeGreaterThan(1);
    for (const event of chat.events) {
      expect(event.attributes?.['gen_ai.system']).toBe('mock');
      expect(event.attributes?.['event.name']).toBe(event.name);
    }
    // Compared as [seconds, nanos] tuples: collapsing an epoch hrtime into one number exceeds
    // float64 integer precision and would erase the 1μs steps this asserts.
    for (let i = 1; i < chat.events.length; i++) {
      const previousEvent: ReadableSpan['events'][number] | undefined = chat.events[i - 1];
      const event: ReadableSpan['events'][number] | undefined = chat.events[i];
      assert.exists(previousEvent);
      assert.exists(event);
      const [prevSec, prevNs] = previousEvent.time;
      const [sec, ns] = event.time;
      expect(sec > prevSec || (sec === prevSec && ns > prevNs)).toBe(true);
    }
  });

  it('degrades only the values JSON cannot encode, not the whole body', () => {
    configureObservability({ captureMessageContent: true });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const span = getTracer().startSpan('chat test');
    addMessageEvents(span, {
      providerName: 'mock',
      messages: [
        {
          role: 'assistant',
          contents: [
            textContent('calling'),
            { type: 'function_call', callId: 'c1', name: 'f', arguments: { big: 1n, loop: cyclic } },
          ],
        },
      ],
    });
    span.end();

    // A bigint or a cycle inside caller-built arguments must not cost the event its text and
    // call name; only the offending values degrade.
    const chat = byName('chat test');
    assert.exists(chat);
    const body = JSON.parse(String(chat.events[0]?.attributes?.body));
    expect(body.content).toBe('calling');
    expect(body.tool_calls[0].id).toBe('c1');
    expect(body.tool_calls[0].function.name).toBe('f');
    expect(body.tool_calls[0].function.arguments.big).toBe('1');
    expect(body.tool_calls[0].function.arguments.loop).toEqual({ self: '[circular]' });
  });

  it('falls back to the raw representation for the finish reason', () => {
    const base = agentResponse({ messages: [] });
    expect(responseFinishReason(base)).toBeUndefined();
    // A provider that only reports the reason on the wire object still gets choice events.
    expect(responseFinishReason({ ...base, rawRepresentation: { finish_reason: 'stop' } })).toBe('stop');
    // The normalized field wins over the raw one.
    expect(
      responseFinishReason({ ...base, finishReason: 'length', rawRepresentation: { finish_reason: 'stop' } }),
    ).toBe('length');
    // A non-string raw value is not a finish reason.
    expect(responseFinishReason({ ...base, rawRepresentation: { finish_reason: 42 } })).toBeUndefined();
  });

  it('emits no choice event when the response reports no finish reason', async () => {
    configureObservability({ captureMessageContent: true });
    const mock = new MockChatClient([{ contents: [textContent('hi')] }]);
    await new Agent({ client: mock, name: 'bot' }).run('hello');

    const chat = spans().find((span) => span.name === 'chat mock-model');
    assert.exists(chat);
    expect(chat.events.map((event) => event.name)).toEqual(['gen_ai.user.message']);
  });
});

describe('gen_ai.response.finish_reasons', () => {
  /**
   * The four implementations disagree on this attribute's encoding, so its exact value is pinned
   * here rather than left to the shape assertions above: Python emits the JSON text
   * `'["tool_calls"]'`, .NET emits `'["toolcalls"]'`, and this implementation emits the native
   * string array the semantic conventions define, with the convention's `tool_call` spelling.
   */
  const stopTurn = { contents: [textContent('hi')], finishReason: 'stop' };
  /**
   * A call the service already ran (`informationalOnly`), so the loop has nothing to execute and
   * the run ends on the round that reported `tool_calls` — the only way both spans of one run
   * carry the reason that needs normalizing.
   */
  const toolCallTurn = {
    contents: [
      {
        type: 'function_call' as const,
        callId: 'c1',
        name: 'lookup',
        arguments: '{}',
        informationalOnly: true,
      },
    ],
    finishReason: 'tool_calls',
  };

  async function drain(stream: AsyncIterable<unknown>): Promise<void> {
    for await (const _ of stream) {
      // Consume.
    }
  }

  it('records a native string array on the chat span of an awaited run', async () => {
    await new Agent({ client: new MockChatClient([stopTurn]), name: 'bot' }).run('q');
    expect(byName('chat mock-model')?.attributes[GEN_AI.finishReasons]).toEqual(['stop']);

    exporter.reset();
    await new Agent({ client: new MockChatClient([toolCallTurn]), name: 'bot' }).run('q');
    expect(byName('chat mock-model')?.attributes[GEN_AI.finishReasons]).toEqual(['tool_call']);
  });

  it('records a native string array on the chat span of a streamed run', async () => {
    await drain(new Agent({ client: new MockChatClient([stopTurn]), name: 'bot' }).run('q'));
    expect(byName('chat mock-model')?.attributes[GEN_AI.finishReasons]).toEqual(['stop']);

    exporter.reset();
    await drain(new Agent({ client: new MockChatClient([toolCallTurn]), name: 'bot' }).run('q'));
    expect(byName('chat mock-model')?.attributes[GEN_AI.finishReasons]).toEqual(['tool_call']);
  });

  it('records a native string array on the invoke_agent span of an awaited run', async () => {
    await new Agent({ client: new MockChatClient([stopTurn]), name: 'bot' }).run('q');
    expect(byName('invoke_agent bot')?.attributes[GEN_AI.finishReasons]).toEqual(['stop']);

    exporter.reset();
    await new Agent({ client: new MockChatClient([toolCallTurn]), name: 'bot' }).run('q');
    expect(byName('invoke_agent bot')?.attributes[GEN_AI.finishReasons]).toEqual(['tool_call']);
  });

  it('records a native string array on the invoke_agent span of a streamed run', async () => {
    await drain(new Agent({ client: new MockChatClient([stopTurn]), name: 'bot' }).run('q'));
    expect(byName('invoke_agent bot')?.attributes[GEN_AI.finishReasons]).toEqual(['stop']);

    exporter.reset();
    await drain(new Agent({ client: new MockChatClient([toolCallTurn]), name: 'bot' }).run('q'));
    expect(byName('invoke_agent bot')?.attributes[GEN_AI.finishReasons]).toEqual(['tool_call']);
  });

  it('reads a reason the provider reported only on its wire object', async () => {
    // The resolution that finds it there also feeds the output messages and the choice events, so
    // the attribute has to come from the same reading — otherwise one response is described by a
    // reason on two surfaces and by nothing on the third.
    const wireOnly = {
      contents: [textContent('hi')],
      rawRepresentation: { finish_reason: 'tool_calls' },
    };
    await new Agent({ client: new MockChatClient([wireOnly]), name: 'bot' }).run('q');

    expect(byName('chat mock-model')?.attributes[GEN_AI.finishReasons]).toEqual(['tool_call']);
  });
});

describe('message-content attributes', () => {
  /** One transcript carrying every part kind the convention names. */
  const transcript = [
    message('user', [
      textContent('hello'),
      { type: 'text_reasoning' as const, text: 'deliberating' },
      { type: 'data' as const, uri: 'data:image/png;base64,QUFBQQ==', mediaType: 'image/png' },
      { type: 'uri' as const, uri: 'https://example.test/photo.png', mediaType: 'image/png' },
    ]),
    message('assistant', [
      {
        type: 'function_call' as const,
        callId: 'c1',
        name: 'lookup',
        arguments: '{"token":"s3cr3t"}',
        informationalOnly: true,
      },
    ]),
    message('tool', [{ type: 'function_result' as const, callId: 'c1', result: 'confidential answer' }]),
  ];

  it('names the parts with the convention vocabulary rather than the framework content types', async () => {
    configureObservability({ captureMessageContent: true });
    const mock = new MockChatClient([{ contents: [textContent('ok')], finishReason: 'stop' }]);

    await new Agent({ client: mock, name: 'bot' }).run(transcript);

    const chat = byName('chat mock-model');
    assert.exists(chat);
    expect(JSON.parse(String(chat.attributes[GEN_AI.inputMessages]))).toEqual([
      {
        role: 'user',
        parts: [{ type: 'text', content: 'hello' }, { type: 'reasoning' }, { type: 'blob' }, { type: 'uri' }],
      },
      { role: 'assistant', parts: [{ type: 'tool_call' }] },
      { role: 'tool', parts: [{ type: 'tool_call_response' }] },
    ]);
    // The same vocabulary reaches the agent span, which serializes the same messages.
    expect(JSON.parse(String(byName('invoke_agent bot')?.attributes[GEN_AI.inputMessages]))).toEqual(
      JSON.parse(String(chat.attributes[GEN_AI.inputMessages])),
    );
  });

  it('keeps tool payloads, blob bytes and URIs out of the serialized parts', async () => {
    configureObservability({ captureMessageContent: true });
    const mock = new MockChatClient([{ contents: [textContent('ok')], finishReason: 'stop' }]);

    await new Agent({ client: mock, name: 'bot' }).run(transcript);

    // What the compact form deliberately drops: a dashboard reads these from the transcript, not
    // from a trace, so credentials inside tool arguments never reach a span.
    const serialized = String(byName('chat mock-model')?.attributes[GEN_AI.inputMessages]);
    expect(serialized).not.toContain('s3cr3t');
    expect(serialized).not.toContain('confidential answer');
    expect(serialized).not.toContain('QUFBQQ==');
    expect(serialized).not.toContain('example.test');
    expect(serialized).not.toContain('image/png');
    expect(serialized).not.toContain('c1');
    expect(serialized).not.toContain('lookup');
  });

  it('stamps the finish reason on the final output message of the chat span only', async () => {
    configureObservability({ captureMessageContent: true });
    const mock = new MockChatClient([{ contents: [textContent('done')], finishReason: 'tool_calls' }]);

    await new Agent({ client: mock, name: 'bot' }).run('q');

    const chat = byName('chat mock-model');
    assert.exists(chat);
    expect(JSON.parse(String(chat.attributes[GEN_AI.outputMessages]))).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'done' }], finish_reason: 'tool_call' },
    ]);
    // Input messages describe what was sent, so they never carry one.
    for (const input of JSON.parse(String(chat.attributes[GEN_AI.inputMessages]))) {
      expect(input).not.toHaveProperty('finish_reason');
    }
    // The agent span leaves it off: the reference implementations pass the reason to the chat
    // serialization alone.
    expect(JSON.parse(String(byName('invoke_agent bot')?.attributes[GEN_AI.outputMessages]))).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'done' }] },
    ]);
  });

  it('stamps the finish reason on the last message only', () => {
    configureObservability({ captureMessageContent: true });
    const span = getTracer().startSpan('chat test');
    setMessageContent(
      span,
      GEN_AI.outputMessages,
      [message('assistant', [textContent('a')]), message('assistant', [textContent('b')])],
      'stop',
    );
    span.end();

    expect(JSON.parse(String(byName('chat test')?.attributes[GEN_AI.outputMessages]))).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'a' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'b' }], finish_reason: 'stop' },
    ]);
  });

  it('omits the message attributes on the chat span until capture is opted in', async () => {
    const mock = new MockChatClient([{ contents: [textContent('secret answer')], finishReason: 'stop' }]);

    await new Agent({ client: mock, name: 'bot' }).run('secret question');

    const chat = byName('chat mock-model');
    assert.exists(chat);
    expect(chat.attributes[GEN_AI.inputMessages]).toBeUndefined();
    expect(chat.attributes[GEN_AI.outputMessages]).toBeUndefined();
    expect(chat.attributes[GEN_AI.systemInstructions]).toBeUndefined();
  });
});

describe('server.port', () => {
  it('is emitted by no span this framework starts', async () => {
    const mock = new MockChatClient([{ contents: [textContent('hi')], finishReason: 'stop' }], {
      providerUri: 'https://api.example.com:8443/v1',
    });

    await new Agent({ client: mock, name: 'bot' }).run('hello');

    // Deliberate: the endpoint's port is not reported anywhere, on any span, even when the
    // endpoint names one. The key stays in the metric dimension allowlist as a forward
    // declaration, and `metricDimensions` skips a key with no value.
    //
    // Known non-conformance: the semantic conventions make `server.port` conditionally required
    // once `server.address` is present. Emitting it is a separate decision, because the port is
    // also a histogram dimension and the reference implementations disagree on whether to report
    // it at all.
    for (const span of spans()) {
      expect(span.attributes[SERVER.port]).toBeUndefined();
    }
    expect(byName('chat mock-model')?.attributes[SERVER.address]).toBe('api.example.com');
  });
});

describe('no-op behaviour without an SDK', () => {
  it('runs unchanged when no tracer provider is registered', async () => {
    trace.disable();
    try {
      const mock = new MockChatClient([{ contents: [textContent('hi')], finishReason: 'stop' }]);
      const response = await new Agent({ client: mock }).run('hello');

      expect(response.text).toBe('hi');
      expect(spans()).toHaveLength(0);
    } finally {
      trace.setGlobalTracerProvider(provider);
    }
  });
});
