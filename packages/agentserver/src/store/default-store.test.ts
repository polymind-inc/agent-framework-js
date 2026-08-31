import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stateRoot } from '../config.js';
import type { HandlerContext, ResponseHandler } from '../server.js';
import { ResponsesServer } from '../server.js';
import { lifecycleHandler, post } from '../test-helpers.js';
import type { CreateResponseRequest, ResponseObject } from '../wire.js';
import { InMemoryResponseProvider } from './memory.js';

describe('the test harness', () => {
  it('keeps every suite off the developer’s own state root', () => {
    // The store defaults to the filesystem, so a suite that builds a server without naming one
    // writes transcripts somewhere. `scripts/test-state-root.ts` decides where; this is the
    // assertion that notices if that setup file ever stops being applied.
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';

    expect(stateRoot()).not.toBe(`${home}/.agentserver`);
    expect(stateRoot()).toContain('afjs-state-root-');
  });
});

/**
 * What a restart looks like from a test: a state root that only this test can see, so the default
 * store resolves under it instead of the developer's `~/.agentserver`, and two server instances
 * that share nothing but that directory.
 */
let root: string;

/** Records the history each turn was handed, and answers with one identifiable output item. */
function recordingHandler(seenHistory: string[][]): ResponseHandler {
  return async function* (_request: CreateResponseRequest, context: HandlerContext) {
    seenHistory.push(context.history.map((item) => String(item.id)));
    yield { type: 'response.created', response: context.response };
    yield { type: 'response.in_progress', response: { ...context.response, status: 'in_progress' } };
    yield {
      type: 'response.output_item.done',
      item: { type: 'message', id: `out_${seenHistory.length}`, role: 'assistant' },
    };
    yield { type: 'response.completed', response: { ...context.response, status: 'completed' } };
  };
}

describe('the default response store', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'afjs-default-store-'));
    vi.stubEnv('AGENTSERVER_STATE_ROOT', root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('continues a conversation across two server instances sharing one state root', async () => {
    const seenHistory: string[][] = [];
    const handler = recordingHandler(seenHistory);

    // The instance a first process builds.
    const before = new ResponsesServer({ handler, hosted: false });
    const first = (await (
      await before.handle(post({ input: [{ type: 'message', id: 'in_1', role: 'user', content: 'one' }] }))
    ).json()) as ResponseObject;

    // The instance the *next* process builds: same configuration, same state root, no shared memory.
    const after = new ResponsesServer({ handler, hosted: false });
    const continued = await after.handle(
      post({
        input: [{ type: 'message', id: 'in_2', role: 'user', content: 'two' }],
        previous_response_id: first.id,
      }),
    );
    const second = (await continued.json()) as ResponseObject;

    expect(continued.status).toBe(200);
    expect(seenHistory).toEqual([[], ['in_1', 'out_1']]);
    expect(second.output[0]?.id).toBe('out_2');
  });

  it('persists the transcript as clear text under the state root', async () => {
    const server = new ResponsesServer({ handler: lifecycleHandler({ echo: true }), hosted: false });

    const created = (await (await server.handle(post({ input: 'Hi' }))).json()) as ResponseObject;

    // Nothing encrypts or redacts what a turn said: the directory needs the protection the
    // conversation does, and clearing it out is the operator's job.
    const stored = await readFile(join(root, 'responses', `${created.id}.json`), 'utf8');
    expect(stored).toContain('Echo: Hi');
  });

  it('keeps an explicit in-memory store process-local, and off the filesystem', async () => {
    const seenHistory: string[][] = [];
    const handler = recordingHandler(seenHistory);

    const before = new ResponsesServer({
      handler,
      store: new InMemoryResponseProvider(),
      hosted: false,
    });
    const first = (await (
      await before.handle(post({ input: [{ type: 'message', id: 'in_1', role: 'user', content: 'one' }] }))
    ).json()) as ResponseObject;

    const after = new ResponsesServer({
      handler,
      store: new InMemoryResponseProvider(),
      hosted: false,
    });
    const continued = await after.handle(post({ input: 'two', previous_response_id: first.id }));

    // The documented opt-out: the second instance has never heard of the first turn.
    expect(continued.status).toBe(404);
    // And the opt-out is real — nothing reached the state root.
    await expect(readdir(join(root, 'responses'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
