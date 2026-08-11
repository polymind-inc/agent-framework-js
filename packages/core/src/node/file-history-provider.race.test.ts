import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSession } from '../agent/session.js';
import { textContent } from '../types/content.js';
import type { Message } from '../types/message.js';
import { FileHistoryProvider } from './file-history-provider.js';

// A gate the mocked appendFile stops at halfway through its write, so a test can hold the file in
// the exact state a reader racing an append would see: the line on disk ends mid-JSON.
const gate = vi.hoisted(() => {
  const state: {
    holdNextAppend: boolean;
    firstHalfWritten: (() => void) | undefined;
    release: (() => void) | undefined;
  } = { holdNextAppend: false, firstHalfWritten: undefined, release: undefined };
  return state;
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    appendFile: async (
      path: Parameters<typeof actual.appendFile>[0],
      data: string,
      options: Parameters<typeof actual.appendFile>[2],
    ): Promise<void> => {
      if (!gate.holdNextAppend) {
        return actual.appendFile(path, data, options);
      }
      gate.holdNextAppend = false;
      const half = Math.ceil(data.length / 2);
      await actual.appendFile(path, data.slice(0, half), options);
      gate.firstHalfWritten?.();
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      await actual.appendFile(path, data.slice(half), options);
    },
  };
});

function userMessage(text: string): Message {
  return { role: 'user', contents: [textContent(text)] };
}

const NO_STATE: Record<string, unknown> = {};

let storagePath: string;

beforeEach(async () => {
  storagePath = await mkdtemp(join(tmpdir(), 'af-file-history-race-'));
  gate.holdNextAppend = false;
  gate.firstHalfWritten = undefined;
  gate.release = undefined;
});

afterEach(async () => {
  gate.release?.();
  await rm(storagePath, { recursive: true, force: true });
});

describe('FileHistoryProvider read/write serialization', () => {
  it('does not read a torn line while an append to the same session is in flight', async () => {
    const provider = new FileHistoryProvider({ storagePath });
    const session = new AgentSession({ sessionId: 'racing' });

    const firstHalfOnDisk = new Promise<void>((resolve) => {
      gate.firstHalfWritten = resolve;
    });
    gate.holdNextAppend = true;
    const save = provider.saveMessages(session, [userMessage('hello')], NO_STATE);
    await firstHalfOnDisk;

    // The file now ends mid-JSON. A read that goes straight to the file reports the healthy
    // transcript as corrupted; one queued behind the append waits and sees the whole line.
    const read = provider.getMessages(session, NO_STATE);
    let settled = false;
    void read.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled, 'read settled while the append was still mid-line').toBe(false);

    gate.release?.();
    await save;
    expect((await read).map((message) => message.contents[0])).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('orders a read behind another instance writing the same directory', async () => {
    // Two providers pointed at one directory are two handles on the same transcript, so the
    // ordering has to hold across instances, not merely inside one.
    const writer = new FileHistoryProvider({ storagePath });
    const reader = new FileHistoryProvider({ storagePath });
    const session = new AgentSession({ sessionId: 'shared' });

    const firstHalfOnDisk = new Promise<void>((resolve) => {
      gate.firstHalfWritten = resolve;
    });
    gate.holdNextAppend = true;
    const save = writer.saveMessages(session, [userMessage('hello')], NO_STATE);
    await firstHalfOnDisk;

    const read = reader.getMessages(session, NO_STATE);
    let settled = false;
    void read.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled, 'read settled while the other instance was still mid-line').toBe(false);

    gate.release?.();
    await save;
    expect((await read).map((message) => message.contents[0])).toEqual([{ type: 'text', text: 'hello' }]);
  });
});
