import { describe, expect, it } from 'vitest';
import { abortErrorFrom, isAbortError } from './abort.js';

describe('isAbortError', () => {
  it('recognizes the platform abort error', () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbortError(controller.signal.reason)).toBe(true);
  });

  it('recognizes a caller-supplied abort reason only through its own signal', () => {
    const reason = new Error('draining');
    const controller = new AbortController();
    controller.abort(reason);

    expect(isAbortError(reason, controller.signal)).toBe(true);
    // Without the signal there is nothing to tell this apart from an ordinary failure.
    expect(isAbortError(reason)).toBe(false);
  });

  it('does not classify an unrelated failure as a cancellation', () => {
    // An aborted signal alone must not relabel a genuine provider fault: the two race, and the
    // fault is the more informative of the two.
    const controller = new AbortController();
    controller.abort();
    expect(isAbortError(new Error('rate limited'), controller.signal)).toBe(false);
    expect(isAbortError(undefined, controller.signal)).toBe(false);
  });
});

describe('abortErrorFrom', () => {
  it('returns the signal reason so every timing throws the same value', () => {
    const reason = new Error('draining');
    const controller = new AbortController();
    controller.abort(reason);
    expect(abortErrorFrom(controller.signal)).toBe(reason);
  });

  it('synthesizes a standards-shaped AbortError when there is no aborted signal', () => {
    const cause = new Error('Request was aborted.');
    const error = abortErrorFrom(undefined, cause) as Error;

    expect(error.name).toBe('AbortError');
    // The SDK's own error stays reachable, which is the only record of what actually cancelled.
    expect(error.cause).toBe(cause);
    expect(isAbortError(error)).toBe(true);
  });

  it('ignores a signal that has not been aborted', () => {
    const controller = new AbortController();
    expect((abortErrorFrom(controller.signal) as Error).name).toBe('AbortError');
  });
});
