import { describe, expect, it } from 'vitest';
import { BackgroundRun, newClaim, sequenceOf } from './background-run.js';
import { ResponseTracker } from './lifecycle.js';
import type { ResponseEvent, ResponseObject } from './wire.js';

function response(): ResponseObject {
  return {
    id: 'caresp_test',
    object: 'response',
    created_at: 0,
    status: 'queued',
    output: [],
  };
}

function backgroundRun(maxEvents: number): BackgroundRun {
  return new BackgroundRun({
    owner: 'alice',
    streamed: true,
    tracker: new ResponseTracker(response()),
    inputItems: [],
    abort: new AbortController(),
    persistSnapshot: () => Promise.resolve(),
    maxEvents,
  });
}

function event(sequenceNumber: number, type = 'response.output_text.delta'): ResponseEvent {
  return { type, sequence_number: sequenceNumber };
}

describe('BackgroundRun retention', () => {
  it('rejects a zero-sized retention window instead of breaking live delivery', () => {
    expect(() => backgroundRun(0)).toThrow(/maxEvents.*at least 1/i);
  });

  it('keeps the complete replay log until the cap is crossed', () => {
    const run = backgroundRun(3);
    const events = [event(0), event(1), event(2)];

    for (const delivered of events) {
      run.deliver(delivered);
    }

    expect(run.overflowed).toBe(false);
    expect(run.events).toEqual(events);
  });

  it('carries a slow live follower to the terminal after overflow moves the window', async () => {
    const run = backgroundRun(2);
    const follower = run.follow(-1);
    const first = follower.next();

    run.deliver(event(0, 'response.created'));
    await expect(first).resolves.toEqual({ done: false, value: event(0, 'response.created') });

    // The follower is suspended at its first yield while the retained window moves past it.
    run.deliver(event(1));
    run.deliver(event(2));
    run.deliver(event(3));
    run.deliver(event(4, 'response.completed'));
    run.finish();

    const remaining: ResponseEvent[] = [];
    for await (const delivered of follower) {
      remaining.push(delivered);
    }

    expect(run.overflowed).toBe(true);
    expect(remaining.map(sequenceOf)).toEqual([3, 4]);
    expect(remaining.at(-1)?.type).toBe('response.completed');
  });

  it('releases the window retained only for a departing follower', async () => {
    const run = backgroundRun(2);
    const follower = run.follow(-1);
    const first = follower.next();

    run.deliver(event(0));
    await first;
    run.deliver(event(1));
    run.deliver(event(2));

    expect(run.overflowed).toBe(true);
    expect(run.events).toHaveLength(2);

    await follower.return(undefined);

    expect(run.events).toEqual([]);
  });
});

describe('IdClaim settlement', () => {
  it('settles immediately when setup fails before a run exists', async () => {
    const claim = newClaim('alice', 'generation-1');

    claim.settle();

    await expect(claim.done).resolves.toBeUndefined();
  });

  it('adopts the run work and treats its failure as completion', async () => {
    const claim = newClaim('alice', 'generation-2');
    const work = Promise.withResolvers<void>();
    let settled = false;
    void claim.done.then(() => {
      settled = true;
    });

    claim.settle(work.promise);
    await Promise.resolve();
    expect(settled).toBe(false);

    work.reject(new Error('background run failed'));

    await expect(claim.done).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });
});
