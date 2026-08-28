import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { ConfigurationError, SchemaResolutionError, UserInputRequiredError } from '../errors.js';
import { functionMiddleware } from '../middleware/middleware.js';
import { createResponseStream } from '../streaming/response-stream.js';
import { invocationCountOf, resetInvocationCount, tool } from '../tools/tool.js';
import type {
  Content,
  FunctionApprovalRequestContent,
  FunctionCallContent,
  FunctionResultContent,
  UserInputRequestContent,
} from '../types/content.js';
import { textContent } from '../types/content.js';
import { chatResponseUpdate, mergeChatUpdates } from '../types/response.js';
import type { ChatClient, ChatClientMetadata, ChatOptions } from './chat-client.js';
import { FunctionInvocationLimitError } from './function-execution.js';
import { withFunctionInvocation } from './function-invocation.js';
import { MockChatClient, must } from './test-support.js';

function call(
  callId: string,
  name: string,
  args: string | Record<string, unknown> = '{}',
): FunctionCallContent {
  return { type: 'function_call', callId, name, arguments: args };
}

function resultsOf(contents: readonly Content[]): FunctionResultContent[] {
  return contents.filter((c): c is FunctionResultContent => c.type === 'function_result');
}

const echoSchema = {
  type: 'object',
  properties: { value: { type: 'string' } },
  additionalProperties: false,
} as const;

describe('withFunctionInvocation', () => {
  it('executes a tool and feeds the result back to the model', async () => {
    const execute = vi.fn(async ({ location }: { location: string }) => `${location} is sunny`);
    const weather = tool({
      name: 'get_weather',
      description: 'weather',
      parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
      execute: execute as never,
    });

    const inner = new MockChatClient([
      { contents: [call('c1', 'get_weather', '{"location":"Tokyo"}')], finishReason: 'tool_calls' },
      { contents: [textContent('It is sunny in Tokyo.')], finishReason: 'stop' },
    ]);
    const client = withFunctionInvocation(inner);

    const response = await client.getResponse([{ role: 'user', contents: [textContent('weather?')] }], {
      tools: [weather],
    } as ChatOptions);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(inner.callCount).toBe(2);
    expect(response.text).toBe('It is sunny in Tokyo.');

    const allContents = response.messages.flatMap((m) => m.contents);
    expect(resultsOf(allContents).map((r) => r.result)).toEqual(['Tokyo is sunny']);

    // The second model call sees user -> assistant(tool_call) -> tool(result).
    const secondCall = must(inner.calls[1]);
    expect(secondCall.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('produces the same transcript when streamed', async () => {
    const weather = tool({
      name: 'get_weather',
      description: 'weather',
      parameters: { type: 'object', properties: { location: { type: 'string' } } },
      execute: async () => 'sunny',
    });
    const makeClient = () =>
      withFunctionInvocation(
        new MockChatClient([
          { contents: [call('c1', 'get_weather', '{"location":"Tokyo"}')], finishReason: 'tool_calls' },
          { contents: [textContent('Sunny.')], finishReason: 'stop' },
        ]),
      );

    const awaited = await makeClient().getResponse([], { tools: [weather] } as ChatOptions);

    const streamed = makeClient().getResponse([], { tools: [weather] } as ChatOptions);
    const updates = [];
    for await (const update of streamed) {
      updates.push(update);
    }
    const streamedFinal = await streamed.finalResponse();

    expect(streamedFinal.text).toBe(awaited.text);
    expect(streamedFinal.messages.flatMap((m) => m.contents.map((c) => c.type))).toEqual(
      awaited.messages.flatMap((m) => m.contents.map((c) => c.type)),
    );
    // The generated tool result is visible in the stream, not only in the final fold.
    expect(updates.some((u) => u.contents.some((c) => c.type === 'function_result'))).toBe(true);
  });

  it('returns an error result for an unknown tool and keeps going', async () => {
    const inner = new MockChatClient([
      { contents: [call('c1', 'nope')], finishReason: 'tool_calls' },
      { contents: [textContent('sorry')], finishReason: 'stop' },
    ]);
    const known = tool({ name: 'known', description: 'd', parameters: echoSchema, execute: async () => 'x' });

    const response = await withFunctionInvocation(inner).getResponse([], { tools: [known] } as ChatOptions);

    const results = resultsOf(response.messages.flatMap((m) => m.contents));
    expect(results[0]?.result).toBe('Error: Requested function "nope" not found.');
    expect(inner.callCount).toBe(2);
  });

  it('keeps the caller options object isolated from the inner client', async () => {
    const inner = new MockChatClient([{ contents: [textContent('ok')], finishReason: 'stop' }]);
    const options = { temperature: 0.5 } as ChatOptions;

    await withFunctionInvocation(inner).getResponse([], options);

    // The inner client must receive a copy: a client that retains or mutates what it was given
    // must not be able to reach the caller's object.
    const received = inner.calls[0]?.options as Record<string, unknown>;
    expect(received).not.toBe(options);
    expect(received.temperature).toBe(0.5);
    received.temperature = 99;
    expect(options.temperature).toBe(0.5);
  });

  it('stops on an unknown tool when terminateOnUnknownCalls is set', async () => {
    const inner = new MockChatClient([{ contents: [call('c1', 'nope')], finishReason: 'tool_calls' }]);
    const known = tool({ name: 'known', description: 'd', parameters: echoSchema, execute: async () => 'x' });

    const response = await withFunctionInvocation(inner, { terminateOnUnknownCalls: true }).getResponse([], {
      tools: [known],
    } as ChatOptions);

    expect(inner.callCount).toBe(1);
    expect(resultsOf(response.messages.flatMap((m) => m.contents))).toHaveLength(0);
  });

  it('stops on a declaration-only tool so the caller can handle the call', async () => {
    const declarationOnly = tool({ name: 'manual', description: 'd', parameters: echoSchema });
    const inner = new MockChatClient([{ contents: [call('c1', 'manual')], finishReason: 'tool_calls' }]);

    const response = await withFunctionInvocation(inner).getResponse([], {
      tools: [declarationOnly],
    } as ChatOptions);

    expect(inner.callCount).toBe(1);
    expect(response.messages.flatMap((m) => m.contents).some((c) => c.type === 'function_call')).toBe(true);
  });

  it('returns a validation error to the model instead of invoking the tool', async () => {
    const execute = vi.fn(async () => 'never');
    const validating = tool({
      name: 'strict',
      description: 'd',
      parameters: {
        '~standard': {
          version: 1 as const,
          vendor: 'test',
          validate: (value: unknown) =>
            typeof (value as { value?: unknown }).value === 'string'
              ? { value }
              : { issues: [{ message: 'value must be a string', path: ['value'] }] },
        },
        toJsonSchema: () => echoSchema,
      } as never,
      execute,
    });

    const inner = new MockChatClient([
      { contents: [call('c1', 'strict', '{"value":123}')], finishReason: 'tool_calls' },
      { contents: [call('c2', 'strict', '{"value":"ok"}')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);

    const response = await withFunctionInvocation(inner, { includeDetailedErrors: true }).getResponse([], {
      tools: [validating],
    } as ChatOptions);

    expect(execute).toHaveBeenCalledTimes(1);
    const results = resultsOf(response.messages.flatMap((m) => m.contents));
    expect(results[0]?.exception).toContain('value must be a string');
    expect(results[0]?.result).toContain('Exception: ');
    expect(response.text).toBe('done');
  });

  it('validates raw JSON Schema arguments before invoking the tool', async () => {
    const execute = vi.fn(async () => 'ok');
    const validating = tool({
      name: 'strict_raw',
      description: 'd',
      parameters: {
        type: 'object',
        properties: { resource: { type: 'string' } },
        required: ['resource'],
        additionalProperties: false,
      },
      execute,
    });
    const inner = new MockChatClient([
      { contents: [call('c1', 'strict_raw', 'null')], finishReason: 'tool_calls' },
      { contents: [call('c2', 'strict_raw', '{"resource":"safe"}')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);

    const response = await withFunctionInvocation(inner, { includeDetailedErrors: true }).getResponse([], {
      tools: [validating],
    } as ChatOptions);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ resource: 'safe' }, expect.anything());
    expect(resultsOf(response.messages.flatMap((m) => m.contents))[0]?.exception).toContain(
      'expected object',
    );
  });

  it('aborts the run after maxConsecutiveErrors failing rounds', async () => {
    const failing = tool({
      name: 'boom',
      description: 'd',
      parameters: echoSchema,
      execute: async () => {
        throw new Error('kaboom');
      },
    });
    const inner = new MockChatClient([{ contents: [call('c1', 'boom')], finishReason: 'tool_calls' }]);

    await expect(
      withFunctionInvocation(inner, { maxConsecutiveErrors: 2 }).getResponse([], {
        tools: [failing],
      } as ChatOptions),
    ).rejects.toThrow(/2 times in a row|kaboom/);
    // 2 tolerated rounds, then the third failure is fatal.
    expect(inner.callCount).toBe(3);
  });

  it('throws FunctionInvocationLimitError once a concurrent round exhausts the budget', async () => {
    // The serial path rethrows the raw tool error on the fatal round; the concurrent path is the
    // one that aggregates the round's failures into the limit error. The thrown type is public
    // API — callers catch it with `instanceof` — so this test pins the class, not just a message.
    const failing = tool({
      name: 'boom',
      description: 'd',
      parameters: echoSchema,
      execute: async () => {
        throw new Error('kaboom');
      },
    });
    const inner = new MockChatClient([
      { contents: [call('c1', 'boom'), call('c2', 'boom')], finishReason: 'tool_calls' },
      { contents: [call('c3', 'boom'), call('c4', 'boom')], finishReason: 'tool_calls' },
    ]);

    await expect(
      withFunctionInvocation(inner, {
        maxConsecutiveErrors: 1,
        allowConcurrentInvocations: true,
      }).getResponse([], { tools: [failing] } as ChatOptions),
    ).rejects.toThrow(FunctionInvocationLimitError);
  });

  it('does not count unknown-tool rounds toward the consecutive-error budget', async () => {
    const known = tool({ name: 'known', description: 'd', parameters: echoSchema, execute: async () => 'x' });
    const inner = new MockChatClient([
      { contents: [call('c1', 'nope')], finishReason: 'tool_calls' },
      { contents: [call('c2', 'nope')], finishReason: 'tool_calls' },
      { contents: [call('c3', 'nope')], finishReason: 'tool_calls' },
      { contents: [textContent('gave up')], finishReason: 'stop' },
    ]);

    const response = await withFunctionInvocation(inner, { maxConsecutiveErrors: 1 }).getResponse([], {
      tools: [known],
    } as ChatOptions);

    // Three unknown-call rounds exceed the budget of 1, but the run still completes.
    expect(inner.callCount).toBe(4);
    expect(response.text).toBe('gave up');
    expect(resultsOf(response.messages.flatMap((m) => m.contents))).toHaveLength(3);
  });

  it('resets the error counter on a round with only unknown-tool results', async () => {
    const failing = tool({
      name: 'boom',
      description: 'd',
      parameters: echoSchema,
      execute: async () => {
        throw new Error('kaboom');
      },
    });
    const inner = new MockChatClient([
      { contents: [call('c1', 'boom')], finishReason: 'tool_calls' },
      { contents: [call('c2', 'boom')], finishReason: 'tool_calls' },
      { contents: [call('c3', 'nope')], finishReason: 'tool_calls' },
      { contents: [call('c4', 'boom')], finishReason: 'tool_calls' },
      { contents: [call('c5', 'boom')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);

    // Four failing rounds would exceed maxConsecutiveErrors: 2 if the unknown-call round in the
    // middle did not reset the counter, exactly as a successful round does.
    const response = await withFunctionInvocation(inner, { maxConsecutiveErrors: 2 }).getResponse([], {
      tools: [failing],
    } as ChatOptions);
    expect(response.text).toBe('done');
    expect(inner.callCount).toBe(6);
  });

  it('resets the error counter after a successful round', async () => {
    let shouldFail = true;
    const flaky = tool({
      name: 'flaky',
      description: 'd',
      parameters: echoSchema,
      execute: async () => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('once');
        }
        return 'ok';
      },
    });
    const inner = new MockChatClient([
      { contents: [call('c1', 'flaky')], finishReason: 'tool_calls' },
      { contents: [call('c2', 'flaky')], finishReason: 'tool_calls' },
      { contents: [textContent('recovered')], finishReason: 'stop' },
    ]);

    const response = await withFunctionInvocation(inner).getResponse([], { tools: [flaky] } as ChatOptions);
    expect(response.text).toBe('recovered');
  });

  it('makes one final tool-free call when maxIterations is reached', async () => {
    const looping = tool({
      name: 'loop',
      description: 'd',
      parameters: echoSchema,
      execute: async () => 'again',
    });
    const inner = new MockChatClient([{ contents: [call('c1', 'loop')], finishReason: 'tool_calls' }]);

    await withFunctionInvocation(inner, { maxIterations: 2 }).getResponse([], {
      tools: [looping],
    } as ChatOptions);

    // Rounds 0 and 1 execute tools; round 2 is the final call made without tools.
    expect(inner.callCount).toBe(3);
    expect(inner.calls[0]?.options?.tools).toHaveLength(1);
    expect(inner.calls[2]?.options?.tools).toBeUndefined();
    expect(inner.calls[2]?.options?.toolChoice).toBe('auto');
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maxIterations value %s',
    (maxIterations) => {
      expect(() => withFunctionInvocation(new MockChatClient([]), { maxIterations })).toThrow(
        ConfigurationError,
      );
    },
  );

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maxConsecutiveErrors value %s',
    (maxConsecutiveErrors) => {
      expect(() => withFunctionInvocation(new MockChatClient([]), { maxConsecutiveErrors })).toThrow(
        ConfigurationError,
      );
    },
  );

  it('defaults to 40 iterations and 3 consecutive errors', async () => {
    const looping = tool({
      name: 'loop',
      description: 'd',
      parameters: echoSchema,
      execute: async () => 'again',
    });
    const inner = new MockChatClient([{ contents: [call('c1', 'loop')], finishReason: 'tool_calls' }]);
    await withFunctionInvocation(inner).getResponse([], { tools: [looping] } as ChatOptions);
    expect(inner.callCount).toBe(41);

    const failing = tool({
      name: 'boom',
      description: 'd',
      parameters: echoSchema,
      execute: async () => {
        throw new Error('kaboom');
      },
    });
    const errorClient = new MockChatClient([{ contents: [call('c1', 'boom')], finishReason: 'tool_calls' }]);
    await expect(
      withFunctionInvocation(errorClient).getResponse([], { tools: [failing] } as ChatOptions),
    ).rejects.toThrow();
    expect(errorClient.callCount).toBe(4);
  });

  it('relaxes a required tool choice after the first round', async () => {
    const t = tool({ name: 't', description: 'd', parameters: echoSchema, execute: async () => 'x' });
    const inner = new MockChatClient([
      { contents: [call('c1', 't')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);

    await withFunctionInvocation(inner).getResponse([], {
      tools: [t],
      toolChoice: 'required',
    } as ChatOptions);

    expect(inner.calls[0]?.options?.toolChoice).toBe('required');
    expect(inner.calls[1]?.options?.toolChoice).toBe('auto');
  });

  it('drops the continuation token once the resumed response has been consumed', async () => {
    // A resumed background response is fetched, not posted. If the token survives into round two,
    // the provider keeps re-fetching that same finished response and never sees the tool results,
    // so the loop spins until maxIterations with nothing to show for it (Go
    // `updateOptionsForNextIteration`).
    const t = tool({ name: 't', description: 'd', parameters: echoSchema, execute: async () => 'x' });
    const inner = new MockChatClient([
      { contents: [call('c1', 't')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);

    const response = await withFunctionInvocation(inner).getResponse([], {
      tools: [t],
      continuationToken: { responseId: 'resp_1' },
    } as ChatOptions);

    expect(inner.calls[0]?.options?.continuationToken).toEqual({ responseId: 'resp_1' });
    expect(inner.calls).toHaveLength(2);
    expect(inner.calls[1]?.options?.continuationToken).toBeUndefined();
    expect(response.text).toBe('done');
  });

  it('runs calls serially by default and in parallel when configured', async () => {
    const order: string[] = [];
    const slow = tool({
      name: 'slow',
      description: 'd',
      parameters: echoSchema,
      execute: async (input) => {
        const value = input.value as string;
        order.push(`start:${value}`);
        await new Promise((resolve) => setTimeout(resolve, value === 'a' ? 10 : 0));
        order.push(`end:${value}`);
        return 'ok';
      },
    });
    const turns = [
      {
        contents: [call('c1', 'slow', '{"value":"a"}'), call('c2', 'slow', '{"value":"b"}')],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('done')], finishReason: 'stop' },
    ];

    await withFunctionInvocation(new MockChatClient(turns)).getResponse([], { tools: [slow] } as ChatOptions);
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);

    order.length = 0;
    await withFunctionInvocation(new MockChatClient(turns), {
      allowConcurrentInvocations: true,
    }).getResponse([], { tools: [slow] } as ChatOptions);
    expect(order).toEqual(['start:a', 'start:b', 'end:b', 'end:a']);
  });

  it('bypasses the loop when disabled', async () => {
    const t = tool({ name: 't', description: 'd', parameters: echoSchema, execute: async () => 'x' });
    const inner = new MockChatClient([{ contents: [call('c1', 't')], finishReason: 'tool_calls' }]);
    await withFunctionInvocation(inner, { enabled: false }).getResponse([], { tools: [t] } as ChatOptions);
    expect(inner.callCount).toBe(1);
  });

  it('skips calls the provider already answered', async () => {
    const execute = vi.fn(async () => 'local');
    const t = tool({ name: 'hosted', description: 'd', parameters: echoSchema, execute });
    const inner = new MockChatClient([
      {
        contents: [
          call('c1', 'hosted'),
          { type: 'function_result', callId: 'c1', result: 'server-side' },
          textContent('done'),
        ],
        finishReason: 'stop',
      },
    ]);

    await withFunctionInvocation(inner).getResponse([], { tools: [t] } as ChatOptions);
    expect(execute).not.toHaveBeenCalled();
    expect(inner.callCount).toBe(1);
  });

  it('can execute tools that are not advertised to the model', async () => {
    const hidden = tool({
      name: 'hidden',
      description: 'd',
      parameters: echoSchema,
      execute: async () => 'ok',
    });
    const inner = new MockChatClient([
      { contents: [call('c1', 'hidden')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);

    const response = await withFunctionInvocation(inner, { additionalTools: [hidden] }).getResponse([], {});
    expect(resultsOf(response.messages.flatMap((m) => m.contents))[0]?.result).toBe('ok');
  });
});

describe('tool()', () => {
  it('rejects parameters that cannot become a JSON Schema', () => {
    expect(() => tool({ name: 'x', description: 'd', parameters: { notASchema: true } as never })).toThrow(
      SchemaResolutionError,
    );
  });

  it('resolves a raw JSON Schema and strips the root $schema keyword', () => {
    const t = tool({
      name: 'x',
      description: 'd',
      parameters: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {} },
    });
    expect(t.jsonSchema).toEqual({ type: 'object', properties: {} });
  });

  it('uses a toJSONSchema() method when present', () => {
    const t = tool({
      name: 'x',
      description: 'd',
      parameters: {
        toJSONSchema: () => ({ type: 'object', properties: { a: { type: 'number' } } }),
      } as never,
    });
    expect(t.jsonSchema).toEqual({ type: 'object', properties: { a: { type: 'number' } } });
  });

  it('does not claim a non-object raw JSON Schema produces a Record input', () => {
    tool({
      name: 'string_input',
      description: 'd',
      parameters: { type: 'string' },
      execute: (input) => {
        expectTypeOf(input).toEqualTypeOf<unknown>();
        return String(input);
      },
    });
  });

  it('defaults approvalMode to never_require', () => {
    expect(tool({ name: 'x', description: 'd', parameters: echoSchema }).approvalMode).toBe('never_require');
  });

  it('rejects a maxInvocations below 1', () => {
    // Python raises "max_invocations must be at least 1 or None." at construction; a 0 cap would
    // otherwise declare a tool the model can see but never use.
    expect(() => tool({ name: 'x', description: 'd', parameters: echoSchema, maxInvocations: 0 })).toThrow(
      ConfigurationError,
    );
    expect(() => tool({ name: 'x', description: 'd', parameters: echoSchema, maxInvocations: -1 })).toThrow(
      ConfigurationError,
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'rejects a non-finite or fractional maxInvocations value (%s)',
    (maxInvocations) => {
      expect(() => tool({ name: 'x', description: 'd', parameters: echoSchema, maxInvocations })).toThrow(
        ConfigurationError,
      );
    },
  );
});

describe('maxInvocations', () => {
  function capped(execute: () => Promise<string>, maxInvocations: number) {
    return tool({
      name: 'limited',
      description: 'A tool with a call budget',
      parameters: { type: 'object', properties: {} },
      maxInvocations,
      execute: execute as never,
    });
  }

  it('stops executing the tool once its budget is spent', async () => {
    const execute = vi.fn(async () => 'ok');
    const limited = capped(execute, 2);
    const inner = new MockChatClient([
      { contents: [call('c1', 'limited')], finishReason: 'tool_calls' },
      { contents: [call('c2', 'limited')], finishReason: 'tool_calls' },
      { contents: [call('c3', 'limited')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);

    const response = await withFunctionInvocation(inner, { includeDetailedErrors: true }).getResponse(
      [{ role: 'user', contents: [textContent('go')] }],
      { tools: [limited] } as ChatOptions,
    );

    // The body ran twice; the third call is refused without running it.
    expect(execute).toHaveBeenCalledTimes(2);
    const results = resultsOf(response.messages.flatMap((m) => m.contents));
    expect(results).toHaveLength(3);
    // The refusal reaches the model as a result, not as a failed run — the model is told to stop
    // using the tool rather than being left with an unanswered call (Python wording).
    expect(results[2]?.exception).toContain('has reached its maximum invocation limit');
    expect(response.text).toBe('done');
  });

  it('counts calls of one round and refuses only what exceeds the budget', async () => {
    const execute = vi.fn(async () => 'ok');
    const limited = capped(execute, 2);
    const inner = new MockChatClient([
      {
        contents: [call('c1', 'limited'), call('c2', 'limited'), call('c3', 'limited')],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);

    await withFunctionInvocation(inner).getResponse([{ role: 'user', contents: [textContent('go')] }], {
      tools: [limited],
    } as ChatOptions);

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('spends the budget across runs, not per run', async () => {
    // Python: "across the lifetime of this tool instance ... never automatically reset".
    const execute = vi.fn(async () => 'ok');
    const limited = capped(execute, 1);
    const runOnce = async () => {
      const inner = new MockChatClient([
        { contents: [call('c1', 'limited')], finishReason: 'tool_calls' },
        { contents: [textContent('done')], finishReason: 'stop' },
      ]);
      await withFunctionInvocation(inner).getResponse([{ role: 'user', contents: [textContent('go')] }], {
        tools: [limited],
      } as ChatOptions);
    };

    await runOnce();
    await runOnce();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(invocationCountOf(limited)).toBe(1);

    resetInvocationCount(limited);
    await runOnce();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not spend the budget on arguments the tool never received', async () => {
    // Python parses arguments in `invoke` *before* `__call__` runs the limit check, so a call the
    // tool never saw cannot consume its budget.
    const execute = vi.fn(async () => 'ok');
    const limited = tool({
      name: 'limited',
      description: 'A tool with a call budget',
      parameters: echoSchema,
      maxInvocations: 1,
      execute: execute as never,
    });
    const inner = new MockChatClient([
      { contents: [call('c1', 'limited', 'not json')], finishReason: 'tool_calls' },
      { contents: [call('c2', 'limited', '{"value":"x"}')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);

    await withFunctionInvocation(inner).getResponse([{ role: 'user', contents: [textContent('go')] }], {
      tools: [limited],
    } as ChatOptions);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('leaves an uncapped tool unlimited', async () => {
    const execute = vi.fn(async () => 'ok');
    const free = tool({
      name: 'limited',
      description: 'No budget',
      parameters: { type: 'object', properties: {} },
      execute: execute as never,
    });
    const inner = new MockChatClient([
      { contents: [call('c1', 'limited')], finishReason: 'tool_calls' },
      { contents: [call('c2', 'limited')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);

    await withFunctionInvocation(inner).getResponse([{ role: 'user', contents: [textContent('go')] }], {
      tools: [free],
    } as ChatOptions);

    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('call deduplication and rich tool output', () => {
  it('executes a repeated call id only once', async () => {
    const execute = vi.fn().mockResolvedValue('sunny');
    const weather = tool({
      name: 'get_weather',
      description: 'Weather',
      parameters: { type: 'object', properties: {} },
      execute: execute as never,
    });
    // A round carrying the same call id several times — echoed input, a provider quirk, or a
    // crafted transcript. Only one result can ever be bound to that id, so only one execution is
    // answerable; running it once per copy is amplification the caller controls.
    const client = withFunctionInvocation(
      new MockChatClient([
        {
          contents: Array.from({ length: 5 }, () => ({
            type: 'function_call' as const,
            callId: 'call_1',
            name: 'get_weather',
            arguments: {},
          })),
        },
        { contents: [textContent('done')], finishReason: 'stop' },
      ]),
    );

    await client.getResponse([{ role: 'user', contents: [textContent('weather?')] }], {
      tools: [weather],
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('carries rich tool output as items as well as result', async () => {
    const chart = tool({
      name: 'chart',
      description: 'Draws a chart',
      parameters: { type: 'object', properties: {} },
      execute: (() => [
        { type: 'text', text: 'here you go' },
        { type: 'data', uri: 'data:image/png;base64,AAAA', mediaType: 'image/png' },
      ]) as never,
    });
    const client = withFunctionInvocation(
      new MockChatClient([
        { contents: [{ type: 'function_call', callId: 'call_1', name: 'chart', arguments: {} }] },
        { contents: [textContent('done')], finishReason: 'stop' },
      ]),
    );

    const response = await client.getResponse([{ role: 'user', contents: [textContent('draw')] }], {
      tools: [chart],
    });

    const result = response.messages
      .flatMap((msg) => msg.contents)
      .find((content) => content.type === 'function_result') as
      | { items?: unknown[]; result?: unknown }
      | undefined;
    expect(result?.items).toHaveLength(2);
    expect(result?.result).toEqual(result?.items);
  });
});

describe('generated function_result metadata (Python parity)', () => {
  /** A `function_call` carrying provider routing metadata, as a hosted MCP call does. */
  function labelled(callId: string, name: string): FunctionCallContent {
    return { ...call(callId, name), additionalProperties: { serverLabel: 'github' } };
  }

  it('carries the call additionalProperties onto success, not_found and failure results', async () => {
    // Python passes `additional_properties=function_call_content.additional_properties` at every
    // site in `_tools.py` that answers a call it executed — success, tool not found, argument
    // parsing failure, thrown tool body and middleware termination.
    // Losing it detaches the result from the server that asked for the call.
    const ok = tool({
      name: 'ok',
      description: 'Succeeds',
      parameters: { type: 'object', properties: {} },
      execute: (() => 'fine') as never,
    });
    const boom = tool({
      name: 'boom',
      description: 'Throws',
      parameters: { type: 'object', properties: {} },
      execute: (() => {
        throw new Error('nope');
      }) as never,
    });
    const client = withFunctionInvocation(
      new MockChatClient([
        { contents: [labelled('c1', 'ok'), labelled('c2', 'boom'), labelled('c3', 'missing')] },
        { contents: [textContent('done')], finishReason: 'stop' },
      ]),
    );

    const response = await client.getResponse([{ role: 'user', contents: [textContent('go')] }], {
      tools: [ok, boom],
    });

    const results = resultsOf(response.messages.flatMap((msg) => msg.contents));
    expect(results.map((r) => r.callId)).toEqual(['c1', 'c2', 'c3']);
    for (const result of results) {
      expect(result.additionalProperties).toEqual({ serverLabel: 'github' });
    }
  });

  it('leaves additionalProperties absent when the call had none', async () => {
    const ok = tool({
      name: 'ok',
      description: 'Succeeds',
      parameters: { type: 'object', properties: {} },
      execute: (() => 'fine') as never,
    });
    const client = withFunctionInvocation(
      new MockChatClient([
        { contents: [call('c1', 'ok')] },
        { contents: [textContent('done')], finishReason: 'stop' },
      ]),
    );

    const response = await client.getResponse([{ role: 'user', contents: [textContent('go')] }], {
      tools: [ok],
    });

    const [result] = resultsOf(response.messages.flatMap((msg) => msg.contents));
    expect(result).toBeDefined();
    expect('additionalProperties' in must(result)).toBe(false);
  });

  it('carries them onto a rejected approval result too', async () => {
    // Python's rejection path in `_tools.py` does the same.
    const gated = tool({
      name: 'gated',
      description: 'Needs a human',
      parameters: { type: 'object', properties: {} },
      approvalMode: 'always_require',
      execute: (() => 'ran') as never,
    });
    const client = withFunctionInvocation(
      new MockChatClient([{ contents: [textContent('done')], finishReason: 'stop' }]),
    );

    const response = await client.getResponse(
      [
        {
          role: 'user',
          contents: [
            {
              type: 'function_approval_response',
              id: 'a1',
              approved: false,
              functionCall: labelled('c1', 'gated'),
            },
          ],
        },
      ],
      { tools: [gated] },
    );

    const [result] = resultsOf(response.messages.flatMap((msg) => msg.contents));
    expect(result?.result).toContain('rejected by user');
    expect(result?.additionalProperties).toEqual({ serverLabel: 'github' });
  });

  it('correlates an approval to a new logical occurrence when a provider reuses callId', async () => {
    const execute = vi.fn(() => 'new result');
    const gated = tool({
      name: 'gated',
      description: 'Needs a human',
      parameters: { type: 'object', properties: {} },
      approvalMode: 'always_require',
      execute: execute as never,
    });
    const reused = call('reused', 'gated');
    const client = withFunctionInvocation(
      new MockChatClient([{ contents: [textContent('done')], finishReason: 'stop' }]),
    );

    await client.getResponse(
      [
        { role: 'assistant', contents: [call('reused', 'gated')] },
        { role: 'tool', contents: [{ type: 'function_result', callId: 'reused', result: 'old result' }] },
        {
          role: 'assistant',
          contents: [
            {
              type: 'function_approval_request',
              id: 'ficc_reused',
              functionCall: reused,
              userInputRequest: true,
            },
          ],
        },
        {
          role: 'user',
          contents: [
            {
              type: 'function_approval_response',
              id: 'ficc_reused',
              approved: true,
              functionCall: reused,
            },
          ],
        },
      ],
      { tools: [gated] },
    );

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('toolChoice across the approval boundary (Go parity)', () => {
  function gatedTool() {
    return tool({
      name: 'gated',
      description: 'Needs a human',
      parameters: { type: 'object', properties: {} },
      approvalMode: 'always_require',
      execute: (() => 'ran') as never,
    });
  }

  it('keeps required when the turn carried only a rejection', async () => {
    // Go relaxes `required` only when `invokeApprovedToolApprovalResponses` produced a message
    // (`autocall.go`), i.e. only when an approved call actually ran. A turn that
    // answered nothing has not satisfied the `required` demand yet.
    const mock = new MockChatClient([{ contents: [textContent('done')], finishReason: 'stop' }]);
    const client = withFunctionInvocation(mock);

    await client.getResponse(
      [
        {
          role: 'user',
          contents: [
            {
              type: 'function_approval_response',
              id: 'a1',
              approved: false,
              functionCall: call('c1', 'gated'),
            },
          ],
        },
      ],
      { tools: [gatedTool()], toolChoice: 'required' } as ChatOptions,
    );

    expect(mock.calls[0]?.options?.toolChoice).toBe('required');
  });

  it('relaxes to auto once an approved call has run', async () => {
    const mock = new MockChatClient([{ contents: [textContent('done')], finishReason: 'stop' }]);
    const client = withFunctionInvocation(mock);

    await client.getResponse(
      [
        {
          role: 'user',
          contents: [
            {
              type: 'function_approval_response',
              id: 'a1',
              approved: true,
              functionCall: call('c1', 'gated'),
            },
          ],
        },
      ],
      { tools: [gatedTool()], toolChoice: 'required' } as ChatOptions,
    );

    expect(mock.calls[0]?.options?.toolChoice).toBe('auto');
  });
});

describe('replayed unanswered approval requests', () => {
  it('re-surfaces them and pauses instead of calling the model', async () => {
    // A transcript-replaying caller can send a turn that still contains an approval request the
    // human never answered. Silently stripping it and letting the model run would answer a
    // conversation in which the gated call simply vanished.
    const gated = tool({
      name: 'gated',
      description: 'Needs a human',
      parameters: { type: 'object', properties: {} },
      approvalMode: 'always_require',
      execute: (() => 'ran') as never,
    });
    const mock = new MockChatClient([{ contents: [textContent('unreachable')], finishReason: 'stop' }]);
    const client = withFunctionInvocation(mock);

    const response = await client.getResponse(
      [
        { role: 'user', contents: [textContent('do it')] },
        {
          role: 'assistant',
          contents: [
            {
              type: 'function_approval_request',
              id: 'a1',
              userInputRequest: true,
              functionCall: call('c1', 'gated'),
            },
          ],
        },
      ],
      { tools: [gated] } as ChatOptions,
    );

    expect(mock.callCount).toBe(0);
    const requests = response.messages
      .flatMap((msg) => msg.contents)
      .filter((c): c is FunctionApprovalRequestContent => c.type === 'function_approval_request');
    expect(requests.map((request) => request.id)).toEqual(['a1']);
    expect(requests.map((request) => request.functionCall.callId)).toEqual(['c1']);
  });
});

describe('replayed and standalone approval decisions', () => {
  function pendingRequest(): FunctionApprovalRequestContent {
    return {
      type: 'function_approval_request',
      id: 'ficc_c1',
      userInputRequest: true,
      functionCall: call('c1', 'gated'),
    };
  }

  it('executes a decision replayed twice for the same call only once', async () => {
    // A caller replaying a session transcript can carry the same approval response twice, as two
    // distinct (deserialized) objects. One decision answers one call: the call must run once and
    // reach the wire once.
    const execute = vi.fn(() => 'ran');
    const gated = tool({
      name: 'gated',
      description: 'Needs a human',
      parameters: { type: 'object', properties: {} },
      approvalMode: 'always_require',
      execute: execute as never,
    });
    const decision: Content = {
      type: 'function_approval_response',
      id: 'ficc_c1',
      approved: true,
      functionCall: call('c1', 'gated'),
    };
    const mock = new MockChatClient([{ contents: [textContent('done')], finishReason: 'stop' }]);

    const response = await withFunctionInvocation(mock).getResponse(
      [
        { role: 'assistant', contents: [pendingRequest()] },
        { role: 'user', contents: [decision, { ...decision }] },
      ],
      { tools: [gated] } as ChatOptions,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const emitted = response.messages.flatMap((msg) => msg.contents);
    expect(emitted.filter((content) => content.type === 'function_call')).toHaveLength(1);
    expect(resultsOf(emitted)).toHaveLength(1);
    expect(response.text).toBe('done');
  });

  it('retires a pending request answered by a decision matching only its callId', async () => {
    // A wire-compatible caller can hand-build the response with a fresh id; it is accepted and
    // executed through the callId match, so the same match must retire the request it answers —
    // re-surfacing the request would ask the human to approve a call that already ran, and a
    // second yes would run it again.
    const execute = vi.fn(() => 'ran');
    const gated = tool({
      name: 'gated',
      description: 'Needs a human',
      parameters: { type: 'object', properties: {} },
      approvalMode: 'always_require',
      execute: execute as never,
    });
    const decision: Content = {
      type: 'function_approval_response',
      id: 'fresh_id_from_caller',
      approved: true,
      functionCall: call('c1', 'gated'),
    };
    const mock = new MockChatClient([{ contents: [textContent('done')], finishReason: 'stop' }]);

    const response = await withFunctionInvocation(mock).getResponse(
      [
        { role: 'assistant', contents: [pendingRequest()] },
        { role: 'user', contents: [decision] },
      ],
      { tools: [gated] } as ChatOptions,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const emitted = response.messages.flatMap((msg) => msg.contents);
    expect(emitted.filter((content) => content.type === 'function_approval_request')).toEqual([]);
    expect(response.text).toBe('done');
  });

  it('accepts a callId-only decision for a new occurrence after an older result', async () => {
    // Providers may reuse a call id after its previous occurrence has already produced a result.
    // A fresh-id decision is still a documented wire-compatible answer to the later request, so
    // the old result must not make that decision disappear merely because the ids differ.
    const execute = vi.fn(() => 'ran again');
    const gated = tool({
      name: 'gated',
      description: 'Needs a human',
      parameters: { type: 'object', properties: {} },
      approvalMode: 'always_require',
      execute: execute as never,
    });
    const laterRequest: FunctionApprovalRequestContent = {
      ...pendingRequest(),
      id: 'ficc_c1_second',
    };
    const laterDecision: Content = {
      type: 'function_approval_response',
      id: 'fresh_id_from_caller',
      approved: true,
      functionCall: call('c1', 'gated'),
    };
    const mock = new MockChatClient([{ contents: [textContent('done')], finishReason: 'stop' }]);

    const response = await withFunctionInvocation(mock).getResponse(
      [
        { role: 'assistant', contents: [pendingRequest()] },
        {
          role: 'user',
          contents: [
            {
              type: 'function_approval_response',
              id: 'ficc_c1',
              approved: true,
              functionCall: call('c1', 'gated'),
            },
          ],
        },
        { role: 'tool', contents: [{ type: 'function_result', callId: 'c1', result: 'old result' }] },
        { role: 'assistant', contents: [laterRequest] },
        { role: 'user', contents: [laterDecision] },
      ],
      { tools: [gated] } as ChatOptions,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      response.messages
        .flatMap((msg) => msg.contents)
        .some((content) => content.type === 'function_approval_request'),
    ).toBe(false);
    expect(response.text).toBe('done');
  });
});

describe('withFunctionInvocation result normalization', () => {
  // A tool whose return value cannot be JSON-encoded used to be normalized *outside* the
  // invocation's catch: the `JSON.stringify` threw straight out of the loop, so a single bad
  // return value failed the whole agent run instead of becoming a result the model reads.

  function returning(value: unknown) {
    return tool({
      name: 'produce',
      description: 'produce a value',
      parameters: { type: 'object', properties: {} },
      execute: () => value,
    });
  }

  async function runWith(target: ReturnType<typeof returning>): Promise<FunctionResultContent[]> {
    const inner = new MockChatClient([
      { contents: [call('c1', 'produce')], finishReason: 'tool_calls' },
      { contents: [textContent('ok')], finishReason: 'stop' },
    ]);
    const response = await withFunctionInvocation(inner).getResponse([], {
      tools: [target],
    } as ChatOptions);
    return resultsOf(response.messages.flatMap((m) => m.contents));
  }

  it('turns a circular result into an exception result instead of failing the run', async () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    const results = await runWith(returning(circular));

    expect(results).toHaveLength(1);
    expect(results[0]?.result).toBe('Error: Function failed.');
    expect(typeof results[0]?.exception).toBe('string');
  });

  it('turns a BigInt result into an exception result', async () => {
    const results = await runWith(returning({ total: 1n }));
    expect(results[0]?.result).toBe('Error: Function failed.');
    expect(typeof results[0]?.exception).toBe('string');
  });

  it('turns a Symbol result into an exception result rather than an undefined result', async () => {
    const results = await runWith(returning(Symbol('secret')));
    expect(results[0]?.result).toBe('Error: Function failed.');
    expect(typeof results[0]?.exception).toBe('string');
  });

  it('turns a function result into an exception result', async () => {
    const results = await runWith(returning(() => 'nope'));
    expect(results[0]?.result).toBe('Error: Function failed.');
    expect(typeof results[0]?.exception).toBe('string');
  });

  it('still reports the run as failed once the error budget is spent', async () => {
    // The normalization failure is a *tool* failure, so it counts toward maxConsecutiveErrors like
    // any other — it does not vanish, it just stops killing the run on the first occurrence.
    const inner = new MockChatClient([{ contents: [call('c1', 'produce')], finishReason: 'tool_calls' }]);
    const client = withFunctionInvocation(inner, { maxConsecutiveErrors: 0 });
    await expect(
      client.getResponse([], { tools: [returning(Symbol('secret'))] } as ChatOptions),
    ).rejects.toThrow();
  });

  it('normalizes a value a middleware substituted, inside the same boundary', async () => {
    const target = tool({
      name: 'produce',
      description: 'produce a value',
      parameters: { type: 'object', properties: {} },
      execute: () => 'fine',
    });
    const inner = new MockChatClient([
      { contents: [call('c1', 'produce')], finishReason: 'tool_calls' },
      { contents: [textContent('ok')], finishReason: 'stop' },
    ]);
    const client = withFunctionInvocation(inner, {
      middleware: [
        functionMiddleware(async (ctx, next) => {
          await next();
          ctx.result = { big: 1n };
        }),
      ],
    });

    const response = await client.getResponse([], { tools: [target] } as ChatOptions);
    const results = resultsOf(response.messages.flatMap((m) => m.contents));
    expect(results[0]?.result).toBe('Error: Function failed.');
  });

  it('keeps a normal object result JSON-encoded', async () => {
    const results = await runWith(returning({ temp: 21 }));
    expect(results[0]?.result).toBe('{"temp":21}');
    expect(results[0]?.exception).toBeUndefined();
  });

  it('keeps a Content[] result on both result and items', async () => {
    const results = await runWith(returning([textContent('rich')]));
    expect(results[0]?.result).toEqual([textContent('rich')]);
    expect(results[0]?.items).toEqual([textContent('rich')]);
  });
});

describe('withFunctionInvocation UserInputRequiredError', () => {
  /** A tool whose body always raises {@link UserInputRequiredError} with `contents`. */
  function raising(contents: UserInputRequestContent[]) {
    return tool({
      name: 'needs_input',
      description: 'needs a human',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        throw new UserInputRequiredError(contents);
      },
    });
  }

  it('reports an exception result and keeps looping when the error carries no requests', async () => {
    // Python `_execute_single_function_call` returns
    // `Content.from_function_result(result="Tool requires user input but no request details were
    // provided.", exception="UserInputRequiredException"), False` — a result the model reads plus
    // an exception marker, and `False` meaning the loop is not terminated. Rejecting the run here
    // would make an empty-contents raise fatal, which no reference implementation does.
    const empty = raising([]);
    const inner = new MockChatClient([
      { contents: [call('c1', 'needs_input')], finishReason: 'tool_calls' },
      { contents: [textContent('handled')], finishReason: 'stop' },
    ]);

    const response = await withFunctionInvocation(inner).getResponse([], {
      tools: [empty],
    } as ChatOptions);

    expect(inner.callCount).toBe(2);
    expect(response.text).toBe('handled');
    const results = resultsOf(response.messages.flatMap((m) => m.contents));
    expect(results).toEqual([
      expect.objectContaining({
        type: 'function_result',
        callId: 'c1',
        result: 'Tool requires user input but no request details were provided.',
        exception: 'UserInputRequiredError',
      }),
    ]);
    // Nothing is handed to the caller: there is no request a human could answer.
    expect(
      response.messages
        .flatMap((m) => m.contents)
        .filter((c) => c.type === 'function_approval_request' || c.type === 'oauth_consent_request'),
    ).toEqual([]);
  });

  it('appends the thrown message to the empty-contents result only with includeDetailedErrors', async () => {
    const empty = raising([]);
    const inner = new MockChatClient([
      { contents: [call('c1', 'needs_input')], finishReason: 'tool_calls' },
      { contents: [textContent('handled')], finishReason: 'stop' },
    ]);

    const response = await withFunctionInvocation(inner, { includeDetailedErrors: true }).getResponse([], {
      tools: [empty],
    } as ChatOptions);

    const results = resultsOf(response.messages.flatMap((m) => m.contents));
    expect(results[0]?.result).toBe(
      'Tool requires user input but no request details were provided. ' +
        'Exception: Tool requires user input to proceed.',
    );
    expect(results[0]?.exception).toBe('UserInputRequiredError');
  });

  it('counts an empty-contents raise toward the consecutive-error budget', async () => {
    // Python decides `had_errors` by `content.exception is not None`, so the fallback result is an
    // error round like any other and spends the same budget.
    const empty = raising([]);
    const inner = new MockChatClient([
      { contents: [call('c1', 'needs_input')], finishReason: 'tool_calls' },
      { contents: [call('c2', 'needs_input')], finishReason: 'tool_calls' },
      { contents: [call('c3', 'needs_input')], finishReason: 'tool_calls' },
      { contents: [textContent('unreachable')], finishReason: 'stop' },
    ]);

    await expect(
      withFunctionInvocation(inner, { maxConsecutiveErrors: 1 }).getResponse([], {
        tools: [empty],
      } as ChatOptions),
    ).rejects.toThrow(UserInputRequiredError);
    // One tolerated round, then the second raise is fatal — the model is never called a third time.
    expect(inner.callCount).toBe(2);
  });

  it('surfaces the requests of an ordinary tool to the caller and does not reject the run', async () => {
    // `UserInputRequiredError` is exported from the package root, so a user-written tool — not only
    // `agent.asTool()` — may raise it (Python's tests raise it from a plain `@tool`).
    const consenting = raising([
      { type: 'oauth_consent_request', consentLink: 'https://example.test/consent' },
    ]);
    const inner = new MockChatClient([{ contents: [call('c1', 'needs_input')], finishReason: 'tool_calls' }]);

    const response = await withFunctionInvocation(inner).getResponse([], {
      tools: [consenting],
    } as ChatOptions);

    // The loop stops with the request instead of calling the model again or reporting a result.
    expect(inner.callCount).toBe(1);
    expect(resultsOf(response.messages.flatMap((m) => m.contents))).toEqual([]);
    expect(
      response.messages.flatMap((m) => m.contents).filter((c) => c.type === 'oauth_consent_request'),
    ).toEqual([
      expect.objectContaining({
        type: 'oauth_consent_request',
        callId: 'c1',
        id: 'c1',
        userInputRequest: true,
        consentLink: 'https://example.test/consent',
      }),
    ]);
  });
});

describe('conversation chaining between rounds', () => {
  const echo = tool({
    name: 'echo',
    description: 'echo',
    parameters: echoSchema,
    execute: async () => 'ok',
  });

  /**
   * A two-round provider whose responses report the given conversation ids. The loop's chaining
   * decision is driven entirely by what the round response reports and what the client's
   * metadata declares stable, so the mock carries exactly those two knobs.
   */
  function chainingClient(
    roundIds: [string, string],
    metadata: ChatClientMetadata,
  ): { client: ChatClient<ChatOptions>; requests: Array<ChatOptions | undefined> } {
    const turns: Array<{ contents: Content[]; conversationId: string }> = [
      { contents: [call('c1', 'echo', '{"value":"x"}')], conversationId: roundIds[0] },
      { contents: [textContent('done')], conversationId: roundIds[1] },
    ];
    let index = 0;
    const requests: Array<ChatOptions | undefined> = [];
    const client: ChatClient<ChatOptions> = {
      metadata,
      getResponse: (_messages, options) => {
        requests.push(options);
        const turn = turns[Math.min(index++, turns.length - 1)] ?? { contents: [], conversationId: '' };
        return createResponseStream({
          start: () =>
            (async function* () {
              yield chatResponseUpdate({
                contents: turn.contents,
                role: 'assistant',
                conversationId: turn.conversationId,
              });
            })(),
          finalize: (updates) => mergeChatUpdates(updates),
        });
      },
    };
    return { client, requests };
  }

  it('holds the conversation anchor the provider declares stable', async () => {
    // The provider says which ids are stable service-side anchors; a round that reports a
    // response-chain id must not displace the anchor, or the next round falls off the stored
    // conversation.
    const { client, requests } = chainingClient(['resp_r1', 'resp_r2'], {
      providerName: 'mock',
      stableConversationId: (id) => id.startsWith('stable_'),
    });
    await withFunctionInvocation(client).getResponse([], {
      tools: [echo],
      conversationId: 'stable_1',
    } as ChatOptions);

    expect(requests).toHaveLength(2);
    expect(must(requests[1]).conversationId).toBe('stable_1');
  });

  it('advances to the reported id when the provider declares no stable ids', async () => {
    // Without the predicate every reported id advances the chain — including ids that happen to
    // look like another provider's stable spelling. The loop owns no provider's id taxonomy.
    const { client, requests } = chainingClient(['resp_r1', 'resp_r2'], { providerName: 'mock' });
    await withFunctionInvocation(client).getResponse([], {
      tools: [echo],
      conversationId: 'conv_1',
    } as ChatOptions);

    expect(requests).toHaveLength(2);
    expect(must(requests[1]).conversationId).toBe('resp_r1');
  });

  it('advances a non-stable id even when the provider declares a stable spelling', async () => {
    const { client, requests } = chainingClient(['resp_r1', 'resp_r2'], {
      providerName: 'mock',
      stableConversationId: (id) => id.startsWith('stable_'),
    });
    await withFunctionInvocation(client).getResponse([], {
      tools: [echo],
      conversationId: 'resp_r0',
    } as ChatOptions);

    expect(requests).toHaveLength(2);
    expect(must(requests[1]).conversationId).toBe('resp_r1');
  });
});
