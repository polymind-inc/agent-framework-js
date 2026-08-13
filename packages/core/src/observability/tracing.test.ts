import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Agent } from '../agent/agent.js';
import { withChatTelemetry } from '../client/telemetry.js';
import { MockChatClient } from '../client/test-support.js';
import { tool } from '../tools/tool.js';
import { textContent } from '../types/content.js';
import { message } from '../types/message.js';
import { agentResponse } from '../types/response.js';
import { GEN_AI } from './attributes.js';
import { configureObservability, getTracer } from './settings.js';
import { startAgentRunSpan } from './tracing.js';

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

/** Narrows away undefined; a missing value fails the test with a clear error. */
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value');
  return value;
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

    const invoke = must(byName('invoke_agent weather-bot'));
    expect(invoke).toBeDefined();
    // Two model rounds, one tool execution, all under the agent span.
    expect(spans().filter((s) => s.name === 'chat mock-model')).toHaveLength(2);
    expect(parentOf(must(byName('execute_tool get_weather')))).toBe('invoke_agent weather-bot');
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
    expect(must(byName('invoke_agent leaky-bot')).status.code).toBe(SpanStatusCode.ERROR);
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

    expect(parentOf(must(byName('execute_tool get_weather')))).toBe('invoke_agent weather-bot');
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

    const invoke = must(byName('invoke_agent bot'));
    expect(invoke.attributes[GEN_AI.operation]).toBe('invoke_agent');
    expect(invoke.attributes[GEN_AI.agentName]).toBe('bot');
    expect(invoke.attributes[GEN_AI.agentDescription]).toBe('a bot');
    expect(invoke.attributes[GEN_AI.agentId]).toBe(agent.id);
    expect(invoke.attributes[GEN_AI.providerName]).toBe('mock');
    expect(invoke.attributes[GEN_AI.finishReasons]).toEqual(['stop']);

    const chat = must(byName('chat mock-model'));
    expect(chat.attributes[GEN_AI.operation]).toBe('chat');
    expect(chat.attributes[GEN_AI.providerName]).toBe('mock');
    expect(chat.attributes[GEN_AI.requestModel]).toBe('mock-model');
    expect(chat.attributes[GEN_AI.temperature]).toBe(0.5);
    expect(chat.attributes[GEN_AI.maxTokens]).toBe(100);
    expect(chat.attributes[GEN_AI.responseId]).toBe('resp_1');
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

    const execute = must(byName('execute_tool get_weather'));
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

    const invoke = must(byName('invoke_agent bot'));
    expect(invoke.attributes[GEN_AI.inputMessages]).toBeUndefined();
    expect(invoke.attributes[GEN_AI.outputMessages]).toBeUndefined();
  });

  it('keeps system instructions off the chat span until content capture is opted in', async () => {
    // Regression: instructions used to be stamped unconditionally, leaking prompt
    // text with capture off. The reference implementations emit the attribute only when
    // sensitive-data capture is enabled.
    const mock = new MockChatClient([{ contents: [textContent('x')], finishReason: 'stop' }]);
    await new Agent({ client: mock, name: 'bot', instructions: 'You are terse.' }).run('q');

    const chat = must(byName('chat mock-model'));
    expect(chat.attributes[GEN_AI.systemInstructions]).toBeUndefined();
  });

  it('records system instructions as a parts array once opted in', async () => {
    configureObservability({ captureMessageContent: true });
    const mock = new MockChatClient([{ contents: [textContent('x')], finishReason: 'stop' }]);
    await new Agent({ client: mock, name: 'bot', instructions: 'You are terse.' }).run('q');

    const chat = must(byName('chat mock-model'));
    expect(chat.attributes[GEN_AI.systemInstructions]).toBe(
      JSON.stringify([{ type: 'text', content: 'You are terse.' }]),
    );
  });

  it('records message content once opted in', async () => {
    configureObservability({ captureMessageContent: true });
    const mock = new MockChatClient([{ contents: [textContent('the answer')], finishReason: 'stop' }]);

    await new Agent({ client: mock, name: 'bot' }).run('the question');

    const invoke = must(byName('invoke_agent bot'));
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

    const execute = must(byName('execute_tool get_weather'));
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

    const invoke = must(byName('invoke_agent bot'));
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

    const invoke = must(byName('invoke_agent bot'));
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

    const chat = must(byName('chat mock-model'));
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

    const run = must(byName('invoke_agent remote-bot'));
    expect(run.attributes[GEN_AI.operation]).toBe('invoke_agent');
    expect(run.attributes[GEN_AI.agentId]).toBe('a1');
    expect(run.attributes[GEN_AI.agentName]).toBe('remote-bot');
    expect(run.attributes[GEN_AI.providerName]).toBe('a2a');
    expect(run.attributes[GEN_AI.conversationId]).toBe('ctx-1');
    expect(run.attributes[GEN_AI.responseId]).toBe('resp-1');
    expect(run.attributes[GEN_AI.finishReasons]).toEqual(['stop']);
    expect(parentOf(must(byName('http POST')))).toBe('invoke_agent remote-bot');
  });

  it('records a failure and ends only once', () => {
    const span = startAgentRunSpan({ id: 'a1', providerName: 'a2a' });

    span.setError(new TypeError('boom'));
    span.end();
    span.end();

    const run = must(byName('invoke_agent a1'));
    expect(run.status.code).toBe(2);
    expect(run.attributes[GEN_AI.errorType]).toBe('TypeError');
    expect(spans().filter((candidate) => candidate.name === 'invoke_agent a1')).toHaveLength(1);
  });

  it('captures messages only when the caller opted in', async () => {
    configureObservability({ captureMessageContent: true });
    const span = startAgentRunSpan({ id: 'a1' }, [{ role: 'user', contents: [textContent('secret')] }]);
    span.end();

    expect(must(byName('invoke_agent a1')).attributes[GEN_AI.inputMessages]).toContain('secret');

    configureObservability({ captureMessageContent: false });
    const quiet = startAgentRunSpan({ id: 'a2' }, [{ role: 'user', contents: [textContent('secret')] }]);
    quiet.end();

    expect(must(byName('invoke_agent a2')).attributes[GEN_AI.inputMessages]).toBeUndefined();
  });

  it('awaits a non-streaming call inside the span', async () => {
    const span = startAgentRunSpan({ id: 'a1' });

    await span.awaited(async () => {
      getTracer().startSpan('http POST').end();
    });
    span.end();

    expect(parentOf(must(byName('http POST')))).toBe('invoke_agent a1');
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
