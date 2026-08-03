import { afterEach, describe, expect, it, vi } from 'vitest';
import { raceTimeout } from './wait.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('raceTimeout', () => {
  it('clears the deadline timer when the work settles first', async () => {
    vi.useFakeTimers();

    await raceTimeout(Promise.resolve(), 5_000);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves at the deadline and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => {});

    const waiting = raceTimeout(never, 5_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await waiting;

    expect(vi.getTimerCount()).toBe(0);
  });
});
