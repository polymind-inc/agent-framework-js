import { describe, expect, it } from 'vitest';
import { createClientErrorNormalizer, guardClientStream } from './client-errors.js';

/** Stands in for a provider SDK's user-abort error class (recognized by `instanceof` only). */
class FakeSdkAbortError extends Error {
  constructor() {
    super('Request was aborted.');
    // Deliberately no `this.name = 'AbortError'`: real SDK abort classes arrive as plain "Error".
  }
}

class FakeClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FakeClientError';
  }
}

function makeNormalizer() {
  return createClientErrorNormalizer({
    abortErrorClass: FakeSdkAbortError,
    wrap: (error, detail) => new FakeClientError(`request failed: ${detail}`, { cause: error }),
  });
}

describe('createClientErrorNormalizer', () => {
  it('passes a standards-shaped abort error through untouched', () => {
    const normalize = makeNormalizer();
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    expect(normalize(abort)).toBe(abort);
  });

  it('passes the caller abort reason through untouched when it matches the signal', () => {
    const normalize = makeNormalizer();
    const reason = new Error('caller hung up');
    const controller = new AbortController();
    controller.abort(reason);
    expect(normalize(reason, controller.signal)).toBe(reason);
  });

  it('converts the SDK abort class to the signal reason', () => {
    const normalize = makeNormalizer();
    const reason = new Error('caller hung up');
    const controller = new AbortController();
    controller.abort(reason);
    expect(normalize(new FakeSdkAbortError(), controller.signal)).toBe(reason);
  });

  it('converts the SDK abort class to a synthesized AbortError without a signal', () => {
    const normalize = makeNormalizer();
    const sdkError = new FakeSdkAbortError();
    const result = normalize(sdkError) as Error;
    expect(result.name).toBe('AbortError');
    expect(result.cause).toBe(sdkError);
  });

  it('wraps everything else, with detail from Error.message', () => {
    const normalize = makeNormalizer();
    const failure = new Error('boom');
    const result = normalize(failure) as FakeClientError;
    expect(result).toBeInstanceOf(FakeClientError);
    expect(result.message).toBe('request failed: boom');
    expect(result.cause).toBe(failure);
  });

  it('wraps a non-Error thrown value, with detail from String()', () => {
    const normalize = makeNormalizer();
    const result = normalize('plain string failure') as FakeClientError;
    expect(result).toBeInstanceOf(FakeClientError);
    expect(result.message).toBe('request failed: plain string failure');
    expect(result.cause).toBe('plain string failure');
  });

  it('wraps a genuine failure even when the signal is already aborted', () => {
    // A provider failure that races a cancellation must still be reportable as a failure.
    const normalize = makeNormalizer();
    const controller = new AbortController();
    controller.abort(new Error('caller hung up'));
    const failure = new Error('boom');
    expect(normalize(failure, controller.signal)).toBeInstanceOf(FakeClientError);
  });

  describe('without an SDK abort class', () => {
    // An SDK that lets the platform's own cancellation through — a `fetch` abort is a DOMException
    // named `AbortError` — has no class to name, and must still classify one as a cancellation.
    const normalize = createClientErrorNormalizer({
      wrap: (error, detail) => new FakeClientError(`request failed: ${detail}`, { cause: error }),
    });

    it('still recognizes a platform abort', () => {
      const abort = new DOMException('This operation was aborted', 'AbortError');
      expect(normalize(abort)).toBe(abort);
    });

    it('still wraps everything else', () => {
      expect(normalize(new Error('boom'))).toBeInstanceOf(FakeClientError);
    });
  });
});

async function* streamOf<T>(items: T[], failWith?: unknown): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
  if (failWith !== undefined) {
    throw failWith;
  }
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of stream) {
    collected.push(item);
  }
  return collected;
}

describe('guardClientStream', () => {
  it('yields parsed updates in order and skips undefined', async () => {
    const normalize = makeNormalizer();
    const stream = guardClientStream(
      streamOf([1, 2, 3, 4]),
      (event) => (event % 2 === 0 ? `update-${event}` : undefined),
      normalize,
    );
    expect(await collect(stream)).toEqual(['update-2', 'update-4']);
  });

  it('normalizes an error thrown by the event stream', async () => {
    const normalize = makeNormalizer();
    const failure = new Error('connection reset');
    const stream = guardClientStream(streamOf([1, 2], failure), (event) => event, normalize);
    await expect(collect(stream)).rejects.toThrow(FakeClientError);
    await expect(collect(guardClientStream(streamOf([], failure), (e) => e, normalize))).rejects.toThrow(
      'request failed: connection reset',
    );
  });

  it('normalizes an error thrown by parse', async () => {
    const normalize = makeNormalizer();
    const stream = guardClientStream<number, number>(
      streamOf([1]),
      () => {
        throw new Error('malformed event');
      },
      normalize,
    );
    await expect(collect(stream)).rejects.toThrow('request failed: malformed event');
  });

  it('lets a cancellation surface as the caller abort reason', async () => {
    const normalize = makeNormalizer();
    const reason = new Error('caller hung up');
    const controller = new AbortController();
    controller.abort(reason);
    const stream = guardClientStream(
      streamOf([1], new FakeSdkAbortError()),
      (event) => event,
      normalize,
      controller.signal,
    );
    await expect(collect(stream)).rejects.toBe(reason);
  });

  it('yields events that precede a failure before throwing', async () => {
    const normalize = makeNormalizer();
    const collected: number[] = [];
    const stream = guardClientStream(
      streamOf([1, 2], new Error('late failure')),
      (event) => event,
      normalize,
    );
    await expect(
      (async () => {
        for await (const item of stream) {
          collected.push(item);
        }
      })(),
    ).rejects.toThrow(FakeClientError);
    expect(collected).toEqual([1, 2]);
  });
});
