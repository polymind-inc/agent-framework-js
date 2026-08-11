import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../agent/agent.js';
import { AgentSession } from '../agent/session.js';
import { MockChatClient } from '../client/test-support.js';
import { ConfigurationError } from '../errors.js';
import { textContent } from '../types/content.js';
import type { Message } from '../types/message.js';
import { FileHistoryProvider } from './file-history-provider.js';

function client(...texts: string[]): MockChatClient {
  return new MockChatClient(texts.map((text) => ({ contents: [textContent(text)], finishReason: 'stop' })));
}

function userMessage(text: string): Message {
  return { role: 'user', contents: [textContent(text)] };
}

const NO_STATE: Record<string, unknown> = {};

let storagePath: string;

beforeEach(async () => {
  storagePath = await mkdtemp(join(tmpdir(), 'af-file-history-'));
});

afterEach(async () => {
  await rm(storagePath, { recursive: true, force: true });
});

describe('FileHistoryProvider', () => {
  it('needs a storagePath', () => {
    expect(() => new FileHistoryProvider({ storagePath: '' })).toThrow(ConfigurationError);
  });

  it('uses the Python-compatible default source id', () => {
    expect(new FileHistoryProvider({ storagePath }).sourceId).toBe('file_history');
  });

  it('reads back what another instance wrote', async () => {
    const session = new AgentSession({ sessionId: 'round-trip' });
    const writer = new FileHistoryProvider({ storagePath });
    await writer.saveMessages(session, [userMessage('one'), userMessage('two')], NO_STATE);

    const reader = new FileHistoryProvider({ storagePath });
    const restored = await reader.getMessages(session, NO_STATE);

    expect(restored.map((message) => message.contents[0])).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
  });

  it('has no history for a session that was never written', async () => {
    const provider = new FileHistoryProvider({ storagePath: join(storagePath, 'not-created-yet') });
    expect(await provider.getMessages(new AgentSession({ sessionId: 's' }), NO_STATE)).toEqual([]);
  });

  it('appends, keeping the order across turns', async () => {
    const mock = client('one', 'two', 'three');
    const provider = new FileHistoryProvider({ storagePath });
    const agent = new Agent({ client: mock, historyProvider: provider });
    const session = agent.createSession({ sessionId: 'multi-turn' });

    await agent.run('first', { session });
    await agent.run('second', { session });
    await agent.run('third', { session });

    const stored = await provider.getMessages(session, NO_STATE);
    expect(stored.map((message) => message.contents[0])).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'one' },
      { type: 'text', text: 'second' },
      { type: 'text', text: 'two' },
      { type: 'text', text: 'third' },
      { type: 'text', text: 'three' },
    ]);
  });

  // The layout is the interoperability contract: a provider backed by other storage is written
  // against it, so a change here is a change to something outside this repository.
  it('writes one JSON Lines record per message, in the framework wire form', async () => {
    const session = new AgentSession({ sessionId: 'layout' });
    const provider = new FileHistoryProvider({ storagePath });

    await provider.saveMessages(session, [userMessage('one'), userMessage('two')], NO_STATE);

    const raw = await readFile(join(storagePath, 'layout.jsonl'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(
      raw
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { role: 'user', contents: [{ type: 'text', text: 'one' }] },
      { role: 'user', contents: [{ type: 'text', text: 'two' }] },
    ]);
  });

  it('names the file after the session and creates the directory', async () => {
    const nested = join(storagePath, 'deeper');
    const provider = new FileHistoryProvider({ storagePath: nested });

    await provider.saveMessages(new AgentSession({ sessionId: 'plain-id' }), [userMessage('x')], NO_STATE);

    expect(await readdir(nested)).toEqual(['plain-id.jsonl']);
  });

  it('reports the line a corrupted file failed on', async () => {
    const session = new AgentSession({ sessionId: 'corrupt' });
    const provider = new FileHistoryProvider({ storagePath });
    await provider.saveMessages(session, [userMessage('fine')], NO_STATE);
    await writeFile(join(storagePath, 'corrupt.jsonl'), 'not json\n', { flag: 'a' });

    await expect(provider.getMessages(session, NO_STATE)).rejects.toThrow(/line 2/);
  });

  it('reports the line when a record is valid JSON but not a message', async () => {
    const session = new AgentSession({ sessionId: 'not-a-message' });
    const provider = new FileHistoryProvider({ storagePath });
    await provider.saveMessages(session, [userMessage('fine')], NO_STATE);
    await writeFile(join(storagePath, 'not-a-message.jsonl'), 'null\n', { flag: 'a' });

    await expect(provider.getMessages(session, NO_STATE)).rejects.toThrow(/line 2/);
  });

  it('skips blank lines rather than failing on them', async () => {
    const session = new AgentSession({ sessionId: 'blanks' });
    const provider = new FileHistoryProvider({ storagePath });
    await provider.saveMessages(session, [userMessage('one')], NO_STATE);
    await writeFile(join(storagePath, 'blanks.jsonl'), '\n\n', { flag: 'a' });
    await provider.saveMessages(session, [userMessage('two')], NO_STATE);

    expect((await provider.getMessages(session, NO_STATE)).map((m) => m.contents[0])).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
  });

  it('keeps concurrent appends to one session from interleaving', async () => {
    const session = new AgentSession({ sessionId: 'concurrent' });
    const provider = new FileHistoryProvider({ storagePath });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        provider.saveMessages(session, [userMessage(`m${index}`)], NO_STATE),
      ),
    );

    const stored = await provider.getMessages(session, NO_STATE);
    expect(stored).toHaveLength(20);
    // Every line parsed, so nothing was written on top of anything else.
    expect(new Set(stored.map((message) => (message.contents[0] as { text: string }).text)).size).toBe(20);
  });

  describe('session ids that are not filenames', () => {
    // Ids are opaque, so anything unusable as a name is encoded instead of rejected — the session
    // still works, and the file it maps to stays inside the storage directory.
    const hostile = [
      '../escape',
      '../../escape',
      'nested/child',
      'C:\\windows\\system32',
      '/etc/passwd',
      '.hidden',
      'CON',
      'trailing.',
      'with space',
      'ünïcode',
    ];

    for (const sessionId of hostile) {
      it(`keeps '${sessionId}' inside the storage directory`, async () => {
        const provider = new FileHistoryProvider({ storagePath });
        const session = new AgentSession({ sessionId });

        await provider.saveMessages(session, [userMessage('x')], NO_STATE);

        const written = await readdir(storagePath);
        expect(written).toHaveLength(1);
        expect(written[0]).toMatch(/^~session-[\w-]+\.jsonl$/);
        // And the encoding is reversible enough to find the transcript again.
        expect(await provider.getMessages(session, NO_STATE)).toHaveLength(1);
      });
    }

    it('gives two hostile ids two different files', async () => {
      const provider = new FileHistoryProvider({ storagePath });
      await provider.saveMessages(new AgentSession({ sessionId: '../a' }), [userMessage('a')], NO_STATE);
      await provider.saveMessages(new AgentSession({ sessionId: '../b' }), [userMessage('b')], NO_STATE);

      expect(await readdir(storagePath)).toHaveLength(2);
    });

    it('hashes an id too long to encode into a filename', async () => {
      const provider = new FileHistoryProvider({ storagePath });
      const session = new AgentSession({ sessionId: `../${'x'.repeat(500)}` });

      await provider.saveMessages(session, [userMessage('x')], NO_STATE);

      const written = await readdir(storagePath);
      expect(written[0]).toMatch(/^~session-sha256-[0-9a-f]{64}\.jsonl$/);
      expect(await provider.getMessages(session, NO_STATE)).toHaveLength(1);
    });
  });

  it('stores nothing for a failed run', async () => {
    const provider = new FileHistoryProvider({ storagePath });
    const failing = {
      metadata: { providerName: 'mock' },
      getResponse: (): never => {
        throw new Error('provider down');
      },
    };
    const agent = new Agent({ client: failing as never, historyProvider: provider });
    const session = agent.createSession({ sessionId: 'failed' });

    await expect(agent.run('x', { session })).rejects.toThrow('provider down');

    expect(await provider.getMessages(session, NO_STATE)).toEqual([]);
    expect(await readdir(storagePath)).toEqual([]);
  });

  it('honours storeContextMessages like the in-memory provider', async () => {
    const provider = new FileHistoryProvider({ storagePath, storeContextMessages: true });
    const agent = new Agent({
      client: client('answer'),
      historyProvider: provider,
      contextProviders: [
        {
          sourceId: 'memory',
          beforeRun: (ctx) => {
            ctx.extendMessages([userMessage('remembered')]);
          },
        },
      ],
    });
    const session = agent.createSession({ sessionId: 'with-context' });

    await agent.run('question', { session });

    expect((await provider.getMessages(session, NO_STATE)).map((m) => m.contents[0])).toEqual([
      { type: 'text', text: 'remembered' },
      { type: 'text', text: 'question' },
      { type: 'text', text: 'answer' },
    ]);
  });
});
