import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProtocolError } from '../errors.js';
import { must } from '../test-helpers.js';
import type { ResponseEvent, ResponseObject } from '../wire.js';
import { FileResponseProvider } from './file.js';
import { InMemoryResponseProvider } from './memory.js';
import type { ResponseGeneration, ResponseProvider, StoredResponse } from './provider.js';

const EVENTS: ResponseEvent[] = [
  { type: 'response.created', sequence_number: 0 },
  { type: 'response.completed', sequence_number: 1 },
];

/** The generation every fixture below is written under, unless a test is about the fence itself. */
const GENERATION = 'generation-default';

function stored(id: string, userId?: string, generation: ResponseGeneration = GENERATION): StoredResponse {
  const response: ResponseObject = {
    id,
    object: 'response',
    created_at: 0,
    status: 'completed',
    output: [{ type: 'message', id: `msg_${id}` }],
  };
  return { response, inputItems: [], generation, ...(userId === undefined ? {} : { userId }) };
}

describe('InMemoryResponseProvider eviction', () => {
  it('rejects a non-positive or non-integral response cap', () => {
    expect(() => new InMemoryResponseProvider({ maxResponses: 0 })).toThrow(/maxResponses.*at least 1/i);
    expect(() => new InMemoryResponseProvider({ maxResponses: Number.NaN })).toThrow(
      /maxResponses.*integer/i,
    );
  });

  it('evicts the oldest response once the cap is reached', async () => {
    const provider = new InMemoryResponseProvider({ maxResponses: 2 });

    await provider.put(stored('caresp_a'));
    await provider.put(stored('caresp_b'));
    await provider.put(stored('caresp_c'));

    expect(provider.size).toBe(2);
    // A safety valve, not a cache: the oldest turn reads as absent, like an expired one.
    expect(await provider.get('caresp_a', undefined)).toBeUndefined();
    expect(await provider.get('caresp_b', undefined)).toBeDefined();
    expect(await provider.get('caresp_c', undefined)).toBeDefined();
  });

  it('does not evict when overwriting an existing id', async () => {
    const provider = new InMemoryResponseProvider({ maxResponses: 2 });

    await provider.put(stored('caresp_a'));
    await provider.put(stored('caresp_b'));
    await provider.put(stored('caresp_a'));

    expect(provider.size).toBe(2);
    expect(await provider.get('caresp_a', undefined)).toBeDefined();
    expect(await provider.get('caresp_b', undefined)).toBeDefined();
  });

  it('evicts a response together with its replay log', async () => {
    const provider = new InMemoryResponseProvider({ maxResponses: 1 });

    await provider.put(stored('caresp_a'));
    await provider.putEvents('caresp_a', undefined, EVENTS, GENERATION);
    await provider.put(stored('caresp_b'));

    expect(await provider.getEvents('caresp_a', undefined, GENERATION)).toBeUndefined();
  });

  it('keeps an alias that moved to a new response when its old target goes away', async () => {
    const provider = new InMemoryResponseProvider({ maxResponses: 2 });
    const conversationId = 'caconv_moved';

    // The alias points at turn one, then at turn two — what every follow-up turn of one
    // conversation does to the conversation-id alias.
    await provider.put(stored('caresp_one'));
    await provider.put({ ...stored(conversationId), aliasOf: 'caresp_one' });
    await provider.put(stored('caresp_two'));
    await provider.put({ ...stored(conversationId), aliasOf: 'caresp_two' });

    // A third response evicts turn one. The alias left it before the eviction, so dropping turn
    // one's aliases must not take it along.
    await provider.put(stored('caresp_three'));
    expect(await provider.get('caresp_one', undefined)).toBeUndefined();
    expect((await provider.get(conversationId, undefined))?.aliasOf).toBe('caresp_two');

    // Its *current* target still owns it: deleting turn two takes the alias with it.
    expect(await provider.delete('caresp_two', undefined)).toBe(true);
    expect(await provider.get(conversationId, undefined)).toBeUndefined();
  });

  it('detaches a directly deleted alias from its target', async () => {
    const provider = new InMemoryResponseProvider();

    await provider.put(stored('caresp_kept'));
    await provider.put({ ...stored('caconv_gone'), aliasOf: 'caresp_kept' });
    expect(await provider.delete('caconv_gone', undefined)).toBe(true);

    // Re-pointing the freed alias id elsewhere must survive the old target's departure: the
    // deleted alias record no longer speaks for it.
    await provider.put(stored('caresp_other'));
    await provider.put({ ...stored('caconv_gone'), aliasOf: 'caresp_other' });
    expect(await provider.delete('caresp_kept', undefined)).toBe(true);
    expect((await provider.get('caconv_gone', undefined))?.aliasOf).toBe('caresp_other');
  });
});

describe('event stream persistence', () => {
  it('round-trips an event stream in memory, partitioned by owner', async () => {
    const provider = new InMemoryResponseProvider();

    await provider.put(stored('caresp_ev', 'alice'));
    await provider.putEvents('caresp_ev', 'alice', EVENTS, GENERATION);

    expect(await provider.getEvents('caresp_ev', 'alice', GENERATION)).toEqual(EVENTS);
    // Someone else's stream reads as absent, exactly like someone else's response.
    expect(await provider.getEvents('caresp_ev', 'mallory', GENERATION)).toBeUndefined();
    // And cannot be replaced through a reused id.
    await expect(provider.putEvents('caresp_ev', 'mallory', [], GENERATION)).rejects.toMatchObject({
      status: 404,
    });

    await provider.delete('caresp_ev', 'alice');
    expect(await provider.getEvents('caresp_ev', 'alice', GENERATION)).toBeUndefined();
  });
});

describe('the replay log is fenced by the response generation', () => {
  /** Both shipped providers implement the same conditional write; both are held to it here. */
  async function providers(): Promise<Array<{ name: string; provider: ResponseProvider }>> {
    fenceRoot = await mkdtemp(join(tmpdir(), 'agentserver-fence-'));
    return [
      { name: 'memory', provider: new InMemoryResponseProvider() },
      { name: 'file', provider: new FileResponseProvider({ root: fenceRoot }) },
    ];
  }

  let fenceRoot: string | undefined;

  afterEach(async () => {
    if (fenceRoot !== undefined) {
      await rm(fenceRoot, { recursive: true, force: true });
      fenceRoot = undefined;
    }
  });

  it('discards a write whose generation the id has moved past, keeping the current log', async () => {
    for (const { name, provider } of await providers()) {
      // Generation 1 finishes and stores its log; the id is then deleted and taken by generation 2,
      // which stores a log of its own.
      await provider.put(stored('caresp_gen', 'alice', 'generation-1'));
      await provider.putEvents?.('caresp_gen', 'alice', EVENTS, 'generation-1');
      expect(await provider.delete('caresp_gen', 'alice')).toBe(true);

      const fresh: ResponseEvent[] = [{ type: 'response.created', sequence_number: 0 }];
      await provider.put(stored('caresp_gen', 'alice', 'generation-2'));
      // Replacing the response invalidates the old replay log immediately, before the new turn
      // has one of its own. Reads are fenced as well as writes.
      expect(await provider.getEvents?.('caresp_gen', 'alice', 'generation-2'), name).toBeUndefined();
      await provider.putEvents?.('caresp_gen', 'alice', fresh, 'generation-2');

      // A straggler from generation 1 arrives. It must neither land nor blank what is there.
      await provider.putEvents?.('caresp_gen', 'alice', EVENTS, 'generation-1');
      expect(await provider.getEvents?.('caresp_gen', 'alice', 'generation-2'), name).toEqual(fresh);
    }
  });

  it('discards a write for an id that has been deleted, rather than resurrecting it', async () => {
    for (const { name, provider } of await providers()) {
      await provider.put(stored('caresp_gone', 'alice', 'generation-7'));
      expect(await provider.delete('caresp_gone', 'alice')).toBe(true);

      await provider.putEvents?.('caresp_gone', 'alice', EVENTS, 'generation-7');
      expect(await provider.getEvents?.('caresp_gone', 'alice', 'generation-7'), name).toBeUndefined();
    }
  });

  it('refuses a write from another owner before it ever looks at the generation', async () => {
    for (const { name, provider } of await providers()) {
      await provider.put(stored('caresp_owned', 'alice', 'generation-3'));

      // Ownership is a protocol answer; the stale generation would only have been a silent no-op.
      await expect(
        provider.putEvents?.('caresp_owned', 'mallory', EVENTS, 'generation-99'),
        name,
      ).rejects.toMatchObject({ status: 404 });
    }
  });
});

describe('FileResponseProvider', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  async function makeProvider(): Promise<FileResponseProvider> {
    root = await mkdtemp(join(tmpdir(), 'agentserver-store-'));
    return new FileResponseProvider({ root });
  }

  it('round-trips a response through the filesystem', async () => {
    const provider = await makeProvider();

    await provider.put(stored('caresp_roundtrip', 'alice'));

    expect((await provider.get('caresp_roundtrip', 'alice'))?.response.id).toBe('caresp_roundtrip');
    expect(await provider.history('caresp_roundtrip', 'alice')).toHaveLength(1);
    expect(await provider.get('caresp_roundtrip', 'mallory')).toBeUndefined();
    expect(await provider.delete('caresp_roundtrip', 'alice')).toBe(true);
    expect(await provider.get('caresp_roundtrip', 'alice')).toBeUndefined();
  });

  it('round-trips an event stream on disk, partitioned by owner and deleted with the response', async () => {
    const provider = await makeProvider();

    await provider.put(stored('caresp_ev', 'alice'));
    await provider.putEvents('caresp_ev', 'alice', EVENTS, GENERATION);

    expect(await provider.getEvents('caresp_ev', 'alice', GENERATION)).toEqual(EVENTS);
    expect(await provider.getEvents('caresp_ev', 'mallory', GENERATION)).toBeUndefined();
    await expect(provider.putEvents('caresp_ev', 'mallory', [], GENERATION)).rejects.toMatchObject({
      status: 404,
    });

    expect(await provider.delete('caresp_ev', 'alice')).toBe(true);
    expect(await provider.getEvents('caresp_ev', 'alice', GENERATION)).toBeUndefined();
  });

  it('keeps an event stream from colliding with a response whose id ends in .events', async () => {
    const provider = await makeProvider();

    // `caresp_x.events`'s *response* file and `caresp_x`'s *stream* would share a name under a
    // suffix scheme; the events subdirectory keeps them apart.
    await provider.put(stored('caresp_x.events'));
    await provider.put(stored('caresp_x'));
    await provider.putEvents('caresp_x', undefined, EVENTS, GENERATION);

    expect((await provider.get('caresp_x.events', undefined))?.response.id).toBe('caresp_x.events');
    expect(await provider.getEvents('caresp_x', undefined, GENERATION)).toEqual(EVENTS);
    expect(await provider.getEvents('caresp_x.events', undefined, GENERATION)).toBeUndefined();
  });

  it('serializes concurrent writes so the ownership check cannot be raced', async () => {
    const provider = await makeProvider();

    // Both writers start with the file absent. Unserialized, both read "absent", both pass the
    // ownership check, and the loser silently replaces the winner — a cross-user overwrite that
    // sequential calls would have refused with 404.
    const results = await Promise.allSettled([
      provider.put(stored('caresp_raced', 'alice')),
      provider.put(stored('caresp_raced', 'mallory')),
    ]);

    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as ProtocolError;
    expect(reason).toBeInstanceOf(ProtocolError);
    expect(reason.status).toBe(404);

    // The record on disk belongs to whoever won; it was never replaced.
    const raw = JSON.parse(await readFile(join(must(root), 'caresp_raced.json'), 'utf8')) as StoredResponse;
    expect(raw.userId).toBe('alice');
    expect(await provider.get('caresp_raced', 'mallory')).toBeUndefined();
  });
});
