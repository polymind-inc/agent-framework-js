/**
 * The error contract of the function-invocation seam: where a thrown error surfaces, and what it
 * does to the run.
 *
 * Two rules, and they are the same rule twice. A failure inside the seam travels out through the
 * middleware wrapped around it, so `try { await next() } catch` means what it reads; and a failure
 * nothing recovered is reported to the model as this call's result, whether it came from the tool
 * or from a middleware. {@link MiddlewareFailed} is the one way to say "not that — end the run".
 */
import { describe, expect, it } from 'vitest';
import { MiddlewareFailed } from '../errors.js';
import { functionMiddleware, tool } from '../index.js';
import type { FunctionMiddleware } from '../middleware/middleware.js';
import { textContent } from '../types/content.js';
import type { Message } from '../types/message.js';
import { createFunctionInvocationClientFactory } from './function-invocation.js';
import { MockChatClient } from './test-support.js';

/** A tool that always throws, so the failure has a single known origin. */
const exploding = tool({
  name: 'explode',
  description: 'Always throws',
  parameters: { type: 'object', properties: {} },
  execute: () => {
    throw new Error('tool body failed');
  },
});

/** A tool that always succeeds. */
const quiet = tool({
  name: 'quiet',
  description: 'Always succeeds',
  parameters: { type: 'object', properties: {} },
  execute: () => 'done',
});

/** One model turn calling `name`, then a plain answer. */
function callThen(name: string, answer: string): ConstructorParameters<typeof MockChatClient>[0] {
  return [
    {
      contents: [{ type: 'function_call', callId: 'c1', name, arguments: '{}' }],
      finishReason: 'tool_calls',
    },
    { contents: [textContent(answer)], finishReason: 'stop' },
  ];
}

/** Runs one tool round through the function-invocation client and returns the whole transcript. */
async function run(
  turns: ConstructorParameters<typeof MockChatClient>[0],
  middleware: FunctionMiddleware[],
  tools = [exploding, quiet],
): Promise<Message[]> {
  const client = createFunctionInvocationClientFactory(new MockChatClient(turns))(undefined, middleware);
  const response = await client.getResponse([{ role: 'user', contents: [textContent('go')] }], {
    tools,
  } as never);
  return response.messages;
}

/** The `exception` text of the first function_result in a transcript, if there is one. */
function exceptionOf(messages: Message[]): string | undefined {
  for (const message of messages) {
    for (const content of message.contents) {
      if (content.type === 'function_result' && content.exception !== undefined) {
        return content.exception;
      }
    }
  }
  return undefined;
}

/** The `result` text of the first function_result in a transcript. */
function resultOf(messages: Message[]): unknown {
  for (const message of messages) {
    for (const content of message.contents) {
      if (content.type === 'function_result') {
        return content.result;
      }
    }
  }
  return undefined;
}

describe('a failure travels out through the middleware around it', () => {
  it('lets a tool body exception reach `await next()`', async () => {
    const seen: string[] = [];
    const observer = functionMiddleware(async (_ctx, next) => {
      try {
        await next();
        seen.push('next returned');
      } catch (error) {
        seen.push(`caught ${String(error)}`);
      }
    });

    await run(callThen('explode', 'ok'), [observer]);

    expect(seen).toEqual(['caught Error: tool body failed']);
  });

  it('lets an inner middleware exception reach it the same way', async () => {
    const seen: string[] = [];
    const observer = functionMiddleware(async (_ctx, next) => {
      try {
        await next();
        seen.push('next returned');
      } catch (error) {
        seen.push(`caught ${String(error)}`);
      }
    });
    const thrower = functionMiddleware(async () => {
      throw new Error('middleware failed');
    });

    await run(callThen('quiet', 'ok'), [observer, thrower]);

    // Same syntax, same outcome, whichever layer threw.
    expect(seen).toEqual(['caught Error: middleware failed']);
  });

  it('runs a `finally` block on the failing path', async () => {
    const seen: string[] = [];
    const timing = functionMiddleware(async (ctx, next) => {
      try {
        await next();
      } finally {
        seen.push(`${ctx.tool.name} done`);
      }
    });

    await run(callThen('explode', 'ok'), [timing]);

    expect(seen).toEqual(['explode done']);
  });

  it('still records the failure on `ctx.error` for a middleware that only observes', async () => {
    const seen: unknown[] = [];
    const observer = functionMiddleware(async (ctx, next) => {
      try {
        await next();
      } catch {
        seen.push(ctx.error);
      }
    });

    await run(callThen('explode', 'ok'), [observer]);

    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe('tool body failed');
  });

  it('leaves `ctx.error` unset when the failure came from another middleware', async () => {
    // `ctx.error` answers "was it the tool?", not "did something fail?". A middleware's throw
    // unwinds without passing through the tool seam, so nothing sets it on the way out.
    const seen: unknown[] = [];
    const observer = functionMiddleware(async (ctx, next) => {
      try {
        await next();
      } catch {
        seen.push(ctx.error);
      }
    });
    const thrower = functionMiddleware(async () => {
      throw new Error('middleware failed');
    });

    await run(callThen('quiet', 'ok'), [observer, thrower]);

    expect(seen).toEqual([undefined]);
  });

  it('lets a middleware recover by assigning a result', async () => {
    const recovering = functionMiddleware(async (ctx, next) => {
      try {
        await next();
      } catch {
        ctx.result = 'recovered by middleware';
      }
    });

    const messages = await run(callThen('explode', 'ok'), [recovering]);

    expect(resultOf(messages)).toBe('recovered by middleware');
    expect(exceptionOf(messages)).toBeUndefined();
  });
});

describe('a failure nothing recovered is reported to the model', () => {
  it('reports a tool body exception and keeps the loop running', async () => {
    const messages = await run(callThen('explode', 'recovered'), []);

    expect(exceptionOf(messages)).toContain('tool body failed');
    expect(messages.at(-1)?.contents.some((c) => c.type === 'text' && c.text === 'recovered')).toBe(true);
  });

  it('reports a middleware exception the same way', async () => {
    const thrower = functionMiddleware(async () => {
      throw new Error('middleware failed');
    });

    const messages = await run(callThen('quiet', 'carried on'), [thrower]);

    expect(exceptionOf(messages)).toContain('middleware failed');
    expect(messages.at(-1)?.contents.some((c) => c.type === 'text' && c.text === 'carried on')).toBe(true);
  });

  it('reports a middleware that threw after the tool had already succeeded', async () => {
    // The tool ran and left a result behind. The middleware then failed, so the call as a whole
    // did not succeed, and the result of a step that never finished is not the answer.
    const thrower = functionMiddleware(async (_ctx, next) => {
      await next();
      throw new Error('after the tool');
    });

    const messages = await run(callThen('quiet', 'carried on'), [thrower]);

    expect(exceptionOf(messages)).toContain('after the tool');
    expect(resultOf(messages)).not.toBe('done');
  });

  it('reports a value that is not an Error', async () => {
    const thrower = functionMiddleware(async () => {
      throw 'a bare string';
    });

    const messages = await run(callThen('quiet', 'ok'), [thrower]);

    expect(exceptionOf(messages)).toContain('a bare string');
  });

  it('does not run the tool when a middleware threw before `next()`', async () => {
    let ran = 0;
    const counted = tool({
      name: 'counted',
      description: 'Counts its invocations',
      parameters: { type: 'object', properties: {} },
      execute: () => {
        ran++;
        return 'ran';
      },
    });
    const thrower = functionMiddleware(async () => {
      throw new Error('policy is unreachable');
    });

    await run(callThen('counted', 'ok'), [thrower], [counted]);

    // Reporting the failure to the model does not let the call through: a check that could not
    // decide still stopped the tool.
    expect(ran).toBe(0);
  });
});

describe('MiddlewareFailed ends the run', () => {
  it('propagates to the caller instead of becoming a result', async () => {
    const guard = functionMiddleware(async () => {
      throw new MiddlewareFailed('policy service is unreachable');
    });

    await expect(run(callThen('quiet', 'ok'), [guard])).rejects.toThrow(MiddlewareFailed);
  });

  it('tells the concurrent siblings to stop', async () => {
    // Cooperative: the sibling is told, and it is the sibling that stops. What the framework
    // guarantees is the signal and that the result is discarded, not that the work is interrupted.
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    let sawAbort = false;

    const waiting = tool({
      name: 'waiting',
      description: 'Waits until its signal fires',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              resolve();
            },
            { once: true },
          );
          void gate.then(resolve);
        });
        return 'finished anyway';
      },
    });
    const failing = tool({
      name: 'failing',
      description: 'Fails the run',
      parameters: { type: 'object', properties: {} },
      execute: () => {
        throw new MiddlewareFailed('policy service is unreachable');
      },
    });

    const client = createFunctionInvocationClientFactory(
      new MockChatClient([
        {
          contents: [
            { type: 'function_call', callId: 'c1', name: 'waiting', arguments: '{}' },
            { type: 'function_call', callId: 'c2', name: 'failing', arguments: '{}' },
          ],
          finishReason: 'tool_calls',
        },
        { contents: [textContent('never reached')], finishReason: 'stop' },
      ]),
      { allowConcurrentInvocations: true },
    )();

    const promise = client.getResponse([{ role: 'user', contents: [textContent('go')] }], {
      tools: [waiting, failing],
    } as never);

    await expect(promise).rejects.toThrow(MiddlewareFailed);
    expect(sawAbort).toBe(true);
    released();
  });

  it('is what the caller sees even when a sibling fails on the abort', async () => {
    // A sibling knocked over by the cancellation must not stand in for the failure that caused it.
    // This one rejects from its abort listener, the earliest a sibling failure can possibly land.
    const collapsing = tool({
      name: 'collapsing',
      description: 'Rejects as soon as it is aborted',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        await new Promise<void>((_resolve, reject) => {
          ctx.signal?.addEventListener('abort', () => reject(new Error('aborted mid-flight')), {
            once: true,
          });
        });
        return 'never';
      },
    });
    const failing = tool({
      name: 'failing',
      description: 'Fails the run',
      parameters: { type: 'object', properties: {} },
      execute: () => {
        throw new MiddlewareFailed('policy service is unreachable');
      },
    });

    const client = createFunctionInvocationClientFactory(
      new MockChatClient([
        {
          contents: [
            { type: 'function_call', callId: 'c1', name: 'collapsing', arguments: '{}' },
            { type: 'function_call', callId: 'c2', name: 'failing', arguments: '{}' },
          ],
          finishReason: 'tool_calls',
        },
        { contents: [textContent('never reached')], finishReason: 'stop' },
      ]),
      { allowConcurrentInvocations: true },
    )();

    await expect(
      client.getResponse([{ role: 'user', contents: [textContent('go')] }], {
        tools: [collapsing, failing],
      } as never),
    ).rejects.toThrow(MiddlewareFailed);
  });

  it('is not caught by the seam even when the tool would have succeeded', async () => {
    let ran = 0;
    const counted = tool({
      name: 'counted',
      description: 'Counts its invocations',
      parameters: { type: 'object', properties: {} },
      execute: () => {
        ran++;
        return 'ran';
      },
    });
    const guard = functionMiddleware(async () => {
      throw new MiddlewareFailed('policy service is unreachable');
    });

    await expect(run(callThen('counted', 'ok'), [guard], [counted])).rejects.toThrow(MiddlewareFailed);
    expect(ran).toBe(0);
  });
});
