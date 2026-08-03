import { describe, expect, it, vi } from 'vitest';
import { StreamConsumedError } from '../errors.js';
import { createResponseStream, pipeStream } from './response-stream.js';

async function* numbers(count: number, onNext?: (i: number) => void): AsyncGenerator<number> {
  for (let i = 0; i < count; i++) {
    onNext?.(i);
    yield i;
  }
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

describe('createResponseStream', () => {
  it('does not start until it is consumed', async () => {
    const start = vi.fn(() => numbers(3));
    const stream = createResponseStream({ start, finalize: sum });

    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(start).not.toHaveBeenCalled();

    expect(await stream).toBe(3);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('reports stream: false when awaited and stream: true when iterated', async () => {
    const modes: boolean[] = [];
    const make = () =>
      createResponseStream({
        start: (ctx) => {
          modes.push(ctx.stream);
          return numbers(1);
        },
        finalize: sum,
      });

    await make();
    for await (const _ of make()) {
      void _;
    }
    expect(modes).toEqual([false, true]);
  });

  it('folds every update when awaited', async () => {
    expect(await createResponseStream({ start: () => numbers(4), finalize: sum })).toBe(6);
  });

  it('exposes the folded result after iteration via finalResponse()', async () => {
    const stream = createResponseStream({ start: () => numbers(4), finalize: sum });
    const seen: number[] = [];
    for await (const value of stream) {
      seen.push(value);
    }
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(await stream.finalResponse()).toBe(6);
  });

  it('rejects a second consumption synchronously', async () => {
    const awaited = createResponseStream({ start: () => numbers(2), finalize: sum });
    await awaited;
    expect(() => awaited.then(() => undefined)).toThrow(StreamConsumedError);

    const iterated = createResponseStream({ start: () => numbers(2), finalize: sum });
    iterated[Symbol.asyncIterator]();
    expect(() => iterated[Symbol.asyncIterator]()).toThrow(StreamConsumedError);
  });

  it('runs cleanup exactly once when iteration ends early', async () => {
    const cleanup = vi.fn();
    let produced = 0;
    const stream = createResponseStream({
      start: () => numbers(10, () => produced++),
      finalize: sum,
      cleanup: [cleanup],
    });

    for await (const value of stream) {
      if (value === 1) {
        break;
      }
    }

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(produced).toBeLessThan(10);
    // The partial fold is still available after an early break.
    expect(await stream.finalResponse()).toBe(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs cleanup exactly once on normal exhaustion', async () => {
    const cleanup = vi.fn();
    const stream = createResponseStream({ start: () => numbers(3), finalize: sum, cleanup: [cleanup] });
    await stream;
    await stream.finalResponse();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('propagates errors, runs cleanup, and returns no partial result', async () => {
    const cleanup = vi.fn();
    const stream = createResponseStream<number, number>({
      start: async function* () {
        yield 1;
        throw new Error('boom');
      },
      finalize: sum,
      cleanup: [cleanup],
    });

    await expect(stream).rejects.toThrow('boom');
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(stream.finalResponse()).rejects.toThrow('boom');
  });

  it('marks the stream failed when the consumer throws into it', async () => {
    // Regression: `throw()` used to run cleanup without marking the source
    // done, so a later finalResponse() resumed pulling a source whose cleanup had already run.
    const cleanup = vi.fn();
    let produced = 0;
    const stream = createResponseStream({
      start: () => numbers(10, () => produced++),
      finalize: sum,
      cleanup: [cleanup],
    });

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.throw?.(new Error('consumer bailed'))).rejects.toThrow('consumer bailed');

    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(stream.finalResponse()).rejects.toThrow('consumer bailed');
    // The source was never pulled again after the throw.
    expect(produced).toBe(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('applies result hooks after the finalizer', async () => {
    const stream = createResponseStream({
      start: () => numbers(3),
      finalize: sum,
      onResult: [(value) => value * 10],
    });
    expect(await stream).toBe(30);
  });

  it('aborts via AbortSignal', async () => {
    const controller = new AbortController();
    const stream = createResponseStream({
      start: async function* () {
        yield 1;
        controller.abort();
        yield 2;
      },
      finalize: sum,
      signal: controller.signal,
    });

    await expect(stream).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports a source that ends silently after an abort as an AbortError', async () => {
    // Both provider SDKs end an interrupted stream by *returning*, not by throwing (openai
    // `core/streaming.mjs`, @anthropic-ai/sdk `core/streaming.mjs`). Checking the signal only
    // before each pull would fold that truncated turn into a normal final result, and a hosted
    // turn would be persisted as `completed` with output the model never finished producing.
    const controller = new AbortController();
    const cleanup = vi.fn();
    const finalize = vi.fn(sum);
    const stream = createResponseStream({
      start: async function* () {
        yield 1;
        controller.abort();
      },
      finalize,
      cleanup: [cleanup],
      signal: controller.signal,
    });

    const seen: number[] = [];
    await expect(async () => {
      for await (const value of stream) {
        seen.push(value);
      }
    }).rejects.toMatchObject({ name: 'AbortError' });
    // The updates that did arrive are still delivered; only the *result* is withheld.
    expect(seen).toEqual([1]);
    expect(finalize).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
    await expect(stream.finalResponse()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws the caller-supplied abort reason for a silently ended source', async () => {
    // Same value whichever timing the abort lands on, so a caller can identify its own reason.
    const reason = new Error('drained');
    const controller = new AbortController();
    const stream = createResponseStream({
      start: async function* () {
        yield 1;
        controller.abort(reason);
      },
      finalize: sum,
      signal: controller.signal,
    });

    await expect(stream).rejects.toBe(reason);
  });

  it('still completes a source that finished before the signal was aborted', async () => {
    // The abort arrives after the last pull already reported `done`, so the turn really did
    // finish: a late cancellation must not retroactively fail a completed run.
    const controller = new AbortController();
    const stream = createResponseStream({
      start: () => numbers(2),
      finalize: sum,
      signal: controller.signal,
    });

    const result = await stream;
    controller.abort();
    expect(result).toBe(1);
  });
});

describe('createResponseStream cleanup failures', () => {
  // A cleanup hook that throws used to reject only the *first* consumption: the failure was
  // never latched, so a later `finalResponse()` on the same stream folded the updates and
  // returned a successful result. One stream cannot be both a failure and a success.

  it('keeps a successful stream successful when cleanup succeeds', async () => {
    const stream = createResponseStream({
      start: () => numbers(3),
      finalize: sum,
      cleanup: [vi.fn()],
    });
    const seen: number[] = [];
    for await (const value of stream) {
      seen.push(value);
    }
    expect(seen).toEqual([0, 1, 2]);
    expect(await stream.finalResponse()).toBe(3);
  });

  it('latches a cleanup-only failure across every consumption path', async () => {
    const boom = new Error('cleanup failed');
    const finalize = vi.fn(sum);
    const stream = createResponseStream({
      start: () => numbers(3),
      finalize,
      cleanup: [
        () => {
          throw boom;
        },
      ],
    });

    await expect(async () => {
      for await (const _ of stream) {
        // drain
      }
    }).rejects.toBe(boom);
    // The stream failed, so it has no result — before the fix this resolved to 3.
    await expect(stream.finalResponse()).rejects.toBe(boom);
    await expect(stream.finalResponse()).rejects.toBe(boom);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('latches a cleanup failure raised on an abandoned stream', async () => {
    const boom = new Error('cleanup failed');
    const stream = createResponseStream({
      start: () => numbers(10),
      finalize: sum,
      cleanup: [
        () => {
          throw boom;
        },
      ],
    });

    await expect(async () => {
      for await (const _ of stream) {
        break;
      }
    }).rejects.toBe(boom);
    await expect(stream.finalResponse()).rejects.toBe(boom);
  });

  it('latches a source return failure raised on an abandoned stream', async () => {
    const closeError = new Error('source close failed');
    const finalize = vi.fn(sum);
    const stream = createResponseStream<number, number>({
      start: () => ({
        [Symbol.asyncIterator]: () => {
          let sent = false;
          return {
            next: async () => {
              if (!sent) {
                sent = true;
                return { done: false as const, value: 1 };
              }
              return { done: true as const, value: undefined };
            },
            return: async () => {
              throw closeError;
            },
          };
        },
      }),
      finalize,
    });

    await expect(async () => {
      for await (const _ of stream) {
        break;
      }
    }).rejects.toBe(closeError);
    await expect(stream.finalResponse()).rejects.toBe(closeError);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('combines a pull failure with a source return failure and latches it', async () => {
    const pullError = new Error('source pull failed');
    const closeError = new Error('source close failed');
    const stream = createResponseStream<number, number>({
      start: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw pullError;
          },
          return: async () => {
            throw closeError;
          },
        }),
      }),
      finalize: sum,
    });

    const thrown = await stream.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).cause).toBe(pullError);
    expect((thrown as AggregateError).errors).toEqual([pullError, closeError]);
    await expect(stream.finalResponse()).rejects.toBe(thrown);
  });

  it('latches a cleanup failure raised on an awaited stream', async () => {
    const boom = new Error('cleanup failed');
    const stream = createResponseStream({
      start: () => numbers(3),
      finalize: sum,
      cleanup: [
        () => {
          throw boom;
        },
      ],
    });

    await expect(stream).rejects.toBe(boom);
    await expect(stream.finalResponse()).rejects.toBe(boom);
  });

  it('keeps the source error as the failure when only the source fails', async () => {
    const boom = new Error('source failed');
    const stream = createResponseStream<number, number>({
      start: async function* () {
        yield 1;
        throw boom;
      },
      finalize: sum,
      cleanup: [vi.fn()],
    });

    await expect(stream).rejects.toBe(boom);
    await expect(stream.finalResponse()).rejects.toBe(boom);
  });

  it('reports the source error first and keeps the cleanup error when both fail', async () => {
    const sourceError = new Error('source failed');
    const cleanupError = new Error('cleanup failed');
    const stream = createResponseStream<number, number>({
      start: async function* () {
        yield 1;
        throw sourceError;
      },
      finalize: sum,
      cleanup: [
        () => {
          throw cleanupError;
        },
      ],
    });

    const thrown = await stream.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    // The source error stays the primary one: it is the cause and the first entry.
    expect(aggregate.cause).toBe(sourceError);
    expect(aggregate.errors).toEqual([sourceError, cleanupError]);
    // Same failure on every later consumption path.
    await expect(stream.finalResponse()).rejects.toBe(thrown);
  });

  it('runs every cleanup hook even when an earlier one throws', async () => {
    const first = new Error('first cleanup failed');
    const second = new Error('second cleanup failed');
    const third = vi.fn();
    const stream = createResponseStream({
      start: () => numbers(2),
      finalize: sum,
      cleanup: [
        () => {
          throw first;
        },
        () => {
          throw second;
        },
        third,
      ],
    });

    const thrown = await stream.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(third).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([first, second]);
    await expect(stream.finalResponse()).rejects.toBe(thrown);
  });

  it('hands every cleanup hook the source failure, not the one an earlier hook raised', async () => {
    const sourceError = new Error('source failed');
    const seen: unknown[] = [];
    const stream = createResponseStream<number, number>({
      start: async function* () {
        yield 1;
        throw sourceError;
      },
      finalize: sum,
      cleanup: [
        (failure) => {
          seen.push(failure);
          throw new Error('cleanup failed');
        },
        (failure) => void seen.push(failure),
      ],
    });

    await expect(stream).rejects.toBeInstanceOf(AggregateError);
    expect(seen).toEqual([sourceError, sourceError]);
  });

  it('latches a cleanup failure raised by iterator.throw()', async () => {
    const consumerError = new Error('consumer bailed');
    const cleanupError = new Error('cleanup failed');
    const stream = createResponseStream({
      start: () => numbers(10),
      finalize: sum,
      cleanup: [
        () => {
          throw cleanupError;
        },
      ],
    });

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    const thrown = await iterator.throw?.(consumerError).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([consumerError, cleanupError]);
    await expect(stream.finalResponse()).rejects.toBe(thrown);
  });
});

describe('pipeStream', () => {
  it('finalizes inner before outer and runs both hook sets in order', async () => {
    const order: string[] = [];
    const inner = createResponseStream<number, number>({
      start: () => numbers(3),
      finalize: (updates) => {
        order.push('inner-finalize');
        return sum(updates);
      },
      cleanup: [() => void order.push('inner-cleanup')],
      onResult: [
        (value) => {
          order.push('inner-result');
          return value;
        },
      ],
    });

    const outer = pipeStream(inner, {
      map: (value) => value * 2,
      finalize: (updates) => {
        order.push('outer-finalize');
        return sum(updates);
      },
      cleanup: [() => void order.push('outer-cleanup')],
      onResult: [
        (value) => {
          order.push('outer-result');
          return value;
        },
      ],
    });

    expect(await outer).toBe(6);
    expect(order).toEqual([
      'inner-cleanup',
      'inner-finalize',
      'inner-result',
      'outer-cleanup',
      'outer-finalize',
      'outer-result',
    ]);
  });

  it('propagates early break to the inner stream', async () => {
    const innerCleanup = vi.fn();
    const outerCleanup = vi.fn();
    const inner = createResponseStream({
      start: () => numbers(10),
      finalize: sum,
      cleanup: [innerCleanup],
    });
    const outer = pipeStream(inner, { finalize: sum, cleanup: [outerCleanup] });

    for await (const value of outer) {
      if (value === 0) {
        break;
      }
    }
    expect(innerCleanup).toHaveBeenCalledTimes(1);
    expect(outerCleanup).toHaveBeenCalledTimes(1);
  });

  it('claims the inner stream, so it can no longer be consumed directly', async () => {
    const inner = createResponseStream({ start: () => numbers(2), finalize: sum });
    const outer = pipeStream(inner, { finalize: sum });
    await outer;
    expect(() => inner[Symbol.asyncIterator]()).toThrow(StreamConsumedError);
  });
});
