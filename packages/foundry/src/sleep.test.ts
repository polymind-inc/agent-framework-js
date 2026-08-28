import { afterEach, describe, expect, it, vi } from 'vitest';
import { sleep } from './sleep.js';

describe('sleep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lands an abort raised immediately after a zero-delay call', async () => {
    // Even a zero delay registers its timer and abort listener before resolving: a caller that
    // aborts in the same task still gets the rejection. ("No waiting at zero" is the *storage
    // retry* contract, applied at its call sites — not this function's.)
    const controller = new AbortController();
    const reason = new Error('stop');
    const pending = sleep(0, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('resolves a zero delay on the timer task, so a poll loop yields the event loop', async () => {
    vi.useFakeTimers();
    let resolved = false;
    void sleep(0).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
  });

  it('waits for the timer on a positive delay', async () => {
    vi.useFakeTimers();
    let resolved = false;
    void sleep(50).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(resolved).toBe(true);
  });

  it('rejects with the signal reason when already aborted, even at zero delay', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(sleep(0, controller.signal)).rejects.toBe(reason);
  });

  it('rejects with the signal reason the moment the signal aborts', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error('stop');
    const pending = sleep(1000, controller.signal);
    const outcome = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await outcome;
  });
});
