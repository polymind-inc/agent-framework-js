import { assert, describe, expect, it, vi } from 'vitest';
import { newResponseId } from './ids.js';
import type { HandlerContext, ResponseHandler } from './server.js';
import { ResponsesServer } from './server.js';
import { InMemoryResponseProvider } from './store/memory.js';
import type {
  ResponseGeneration,
  ResponseOwner,
  ResponseProvider,
  StoredResponse,
} from './store/provider.js';
import { lifecycleHandler, makeServer, post, readSse } from './test-helpers.js';
import type { CreateResponseRequest, OutputItem, ResponseEvent, ResponseObject } from './wire.js';

/** The reader of a streaming response's body; a body-less response fails the test outright. */
function bodyReader(res: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (res.body === null) {
    throw new Error('expected a streaming body');
  }
  return res.body.getReader();
}

/** The payload of the first `data:` line in an SSE chunk; a chunk without one fails the test. */
function firstDataLine(text: string): string {
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  if (line === undefined) {
    throw new Error('expected a data: line in the SSE chunk');
  }
  return line.slice(6);
}

/**
 * The reference echo shape, optionally held open on `gate` between `in_progress` and the output.
 * When the abort signal fires while waiting, it winds down as a cancellation (`AbortError`), the
 * way a well-behaved handler is documented to.
 */
function gatedHandler(gate?: Promise<void>): ResponseHandler {
  return lifecycleHandler({ label: 'bg', gate });
}

/**
 * A handler that never gives up: it produces output, ignores the cancellation signal completely,
 * and completes anyway once `gate` opens.
 *
 * The misbehaving half of the cancellation contract — the framework promised the caller `cancelled`, so this
 * handler's own terminal must not be honoured however long after the promise it arrives.
 */
function stubbornHandler(gate: Promise<void>): ResponseHandler {
  return lifecycleHandler({
    label: 'stubborn',
    gate,
    ignoreAbort: true,
    // Fields only a handler can put on the resource. The cancelled snapshot has to strip both:
    // `error` and `completed_at` must be absent on a `cancelled` response.
    inProgressResponse: {
      error: { code: 'server_error', message: 'handler-owned', type: 'server_error' },
      completed_at: 1234,
    },
  });
}

/**
 * An in-memory store that reports what it was asked to write, and can be held inside `putEvents`.
 *
 * Both are needed to observe the windows these tests are about: what a *detached* run writes long
 * after the request that started it was answered, and the interval between a run persisting its
 * terminal state and its registration being dropped — during which the run is finished but the
 * server still has a record of it.
 */
class ObservableStore implements ResponseProvider {
  readonly inner = new InMemoryResponseProvider();
  /** Every response handed to `put`, in order. */
  readonly writes: ResponseObject[] = [];
  /**
   * When set, the **first** `putEvents` blocks on it, freezing that run in its
   * terminal-but-registered state. Later writes — the ones a turn that reused the id makes while
   * the first is still suspended — go straight through, which is the window these tests are about.
   */
  putEventsGate: Promise<void> | undefined;
  putEventsEntered = false;
  putEventsDone = false;
  /** How many `putEvents` calls have been entered, and how many have completed. */
  putEventsCalls = 0;
  putEventsSettled = 0;
  /** When set, `assertWritable` blocks on it: a create that has claimed its id but not started. */
  assertWritableGate: Promise<void> | undefined;
  assertWritableEntered = false;

  async get(id: string, owner: ResponseOwner): Promise<StoredResponse | undefined> {
    return this.inner.get(id, owner);
  }
  async assertWritable(id: string, owner: ResponseOwner): Promise<void> {
    this.assertWritableEntered = true;
    await this.assertWritableGate;
    return this.inner.assertWritable(id, owner);
  }
  async put(stored: StoredResponse): Promise<void> {
    this.writes.push(stored.response);
    await this.inner.put(stored);
  }
  async delete(id: string, owner: ResponseOwner): Promise<boolean> {
    return this.inner.delete(id, owner);
  }
  async history(id: string, owner: ResponseOwner): Promise<OutputItem[] | undefined> {
    return this.inner.history(id, owner);
  }
  async putEvents(
    id: string,
    owner: ResponseOwner,
    events: readonly ResponseEvent[],
    generation: ResponseGeneration,
  ): Promise<void> {
    this.putEventsCalls += 1;
    const gated = this.putEventsCalls === 1;
    this.putEventsEntered = true;
    if (gated) {
      await this.putEventsGate;
    }
    await this.inner.putEvents(id, owner, events, generation);
    this.putEventsSettled += 1;
    this.putEventsDone = true;
  }
  async getEvents(
    id: string,
    owner: ResponseOwner,
    generation: ResponseGeneration,
  ): Promise<ResponseEvent[] | undefined> {
    return this.inner.getEvents(id, owner, generation);
  }
}

/**
 * A create whose *body* only arrives once `gate` opens.
 *
 * The request is admitted by the router — the draining check has already passed — and then sits
 * inside the body read, which is the window between admission and the id being claimed.
 */
function slowPost(body: unknown, gate: Promise<void>): Request {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await gate;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
      controller.close();
    },
  });
  return new Request('http://localhost:8088/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit);
}

function get(path: string): Request {
  return new Request(`http://localhost:8088${path}`);
}

function cancelRequest(id: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:8088/responses/${id}/cancel`, { method: 'POST', headers });
}

function deleteRequest(id: string): Request {
  return new Request(`http://localhost:8088/responses/${id}`, { method: 'DELETE' });
}

/** Waits for a condition a *detached* run makes true; the only clock these tests have. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  await vi.waitFor(() => expect(predicate(), what).toBe(true), { timeout: 3_000, interval: 5 });
}

/** Polls `GET /responses/{id}` until the predicate holds; the background turn's clock. */
async function pollUntil(
  server: ResponsesServer,
  id: string,
  predicate: (response: ResponseObject) => boolean,
): Promise<ResponseObject> {
  return vi.waitUntil(
    async () => {
      const response = await server.handle(get(`/responses/${id}`));
      if (response.status === 200) {
        const body = (await response.json()) as ResponseObject;
        if (predicate(body)) {
          return body;
        }
      }
      return false;
    },
    { timeout: 2_000, interval: 5 },
  );
}

async function errorOf(response: Response): Promise<{ code: string; message: string; param: string | null }> {
  const body = (await response.json()) as { error: { code: string; message: string; param: string | null } };
  return body.error;
}

describe('background non-stream', () => {
  it('answers immediately with the queued/in_progress snapshot and completes detached', async () => {
    const gate = Promise.withResolvers<void>();
    const server = makeServer(gatedHandler(gate.promise));

    const created = await server.handle(post({ input: 'hi', background: true }));
    expect(created.status).toBe(200);
    const snapshot = (await created.json()) as ResponseObject;
    // The 200 goes out after the handler's first event, while the run keeps going (Python
    // `run_background` waits for `response.created` the same way).
    expect(['queued', 'in_progress']).toContain(snapshot.status);
    expect(snapshot.background).toBe(true);
    expect(snapshot.output).toEqual([]);

    // The in-flight run is publicly visible through GET before anything is persisted.
    const inFlight = await server.handle(get(`/responses/${snapshot.id}`));
    expect(inFlight.status).toBe(200);
    expect(['queued', 'in_progress']).toContain(((await inFlight.json()) as ResponseObject).status);

    gate.resolve();
    const finished = await pollUntil(server, snapshot.id, (r) => r.status === 'completed');
    expect(finished.output).toHaveLength(1);
    expect(finished.background).toBe(true);

    // The terminal state is persisted: input items are listable like any stored turn.
    const items = await server.handle(get(`/responses/${snapshot.id}/input_items`));
    expect(items.status).toBe(200);
  });

  it('reports a handler that fails before its first event as a failed snapshot, still 200', async () => {
    const server = makeServer(async function* () {
      throw new Error('exploded before created');
      // biome-ignore lint/correctness/noUnreachable: never runs; the yield only makes this function a generator
      yield { type: 'response.created' };
    });

    const created = await server.handle(post({ input: 'hi', background: true }));
    expect(created.status).toBe(200);
    const snapshot = (await created.json()) as ResponseObject;
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.message).toBe('exploded before created');
  });

  it('serves input_items from the in-flight run before anything is persisted', async () => {
    const gate = Promise.withResolvers<void>();
    const server = makeServer(gatedHandler(gate.promise));
    const inputs = [
      { type: 'message', id: 'bg_i1', role: 'user', content: [{ type: 'input_text', text: 'a' }] },
      { type: 'message', id: 'bg_i2', role: 'user', content: [{ type: 'input_text', text: 'b' }] },
    ];

    const created = await server.handle(post({ input: inputs, background: true }));
    const { id } = (await created.json()) as ResponseObject;

    const listed = await server.handle(get(`/responses/${id}/input_items?order=asc`));
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { data: OutputItem[] };
    expect(body.data.map((item) => item.id)).toEqual(['bg_i1', 'bg_i2']);

    gate.resolve();
    await pollUntil(server, id, (r) => r.status === 'completed');
  });
});

describe('background + stream', () => {
  it('streams the run live with dense sequence numbers and the terminal last', async () => {
    const server = makeServer(gatedHandler());

    const created = await server.handle(post({ input: 'hi', background: true, stream: true }));
    expect(created.status).toBe(200);
    expect(created.headers.get('content-type')).toContain('text/event-stream');

    const events = await readSse(created);
    expect(events[0]?.event).toBe('response.created');
    expect(events.at(-1)?.event).toBe('response.completed');
    expect(events.map((e) => e.data.sequence_number)).toEqual(events.map((_, index) => index));

    const firstEvent = events[0];
    assert.exists(firstEvent);
    const id = (firstEvent.data.response as ResponseObject).id;
    const finished = await pollUntil(server, id, (r) => r.status === 'completed');
    expect(finished.background).toBe(true);
  });

  it('does not cancel the run when the streaming client disconnects', async () => {
    const gate = Promise.withResolvers<void>();
    const server = makeServer(gatedHandler(gate.promise));

    const created = await server.handle(post({ input: 'hi', background: true, stream: true }));
    // Read enough to learn the id, then hang up mid-stream.
    const reader = bodyReader(created);
    const first = new TextDecoder().decode((await reader.read()).value);
    const id = (JSON.parse(firstDataLine(first)) as { response: ResponseObject }).response.id;
    await reader.cancel();

    gate.resolve();
    // The run was decoupled from the connection: it still finishes and persists.
    const finished = await pollUntil(server, id, (r) => r.status === 'completed');
    expect(finished.status).toBe('completed');
  });
});

describe('streamed replay', () => {
  /** Runs one background+stream turn to completion and returns its id and live event count. */
  async function completedStream(server: ResponsesServer): Promise<{ id: string; count: number }> {
    const created = await server.handle(post({ input: 'hi', background: true, stream: true }));
    const events = await readSse(created);
    const firstEvent = events[0];
    assert.exists(firstEvent);
    const id = (firstEvent.data.response as ResponseObject).id;
    await pollUntil(server, id, (r) => r.status === 'completed');
    return { id, count: events.length };
  }

  it('replays a completed stream, honouring starting_after', async () => {
    const server = makeServer(gatedHandler());
    const { id, count } = await completedStream(server);

    const replay = await server.handle(get(`/responses/${id}?stream=true`));
    expect(replay.status).toBe(200);
    const replayed = await readSse(replay);
    expect(replayed).toHaveLength(count);
    expect(replayed[0]?.event).toBe('response.created');
    expect(replayed.at(-1)?.event).toBe('response.completed');

    // The cursor is exclusive: everything strictly after sequence_number 1.
    const resumed = await readSse(await server.handle(get(`/responses/${id}?stream=true&starting_after=1`)));
    expect(resumed).toHaveLength(count - 2);
    expect(resumed[0]?.data.sequence_number).toBe(2);

    // A cursor past the end replays nothing but still answers 200.
    const past = await readSse(await server.handle(get(`/responses/${id}?stream=true&starting_after=999`)));
    expect(past).toHaveLength(0);
  });

  it('replays the retained prefix of a still-running stream, then follows it live', async () => {
    const gate = Promise.withResolvers<void>();
    const server = makeServer(gatedHandler(gate.promise));

    const created = await server.handle(post({ input: 'hi', background: true, stream: true }));
    const id = await new Promise<string>((resolve) => {
      // Pull just the first frame off the live stream to learn the id, keep the rest flowing.
      void bodyReader(created.clone())
        .read()
        .then(({ value }) => {
          const line = firstDataLine(new TextDecoder().decode(value));
          resolve((JSON.parse(line) as { response: ResponseObject }).response.id);
        });
    });

    const follower = await server.handle(get(`/responses/${id}?stream=true`));
    expect(follower.status).toBe(200);
    const resumed = await server.handle(get(`/responses/${id}?stream=true&starting_after=0`));

    gate.resolve();
    const [live, followed, afterZero] = await Promise.all([
      readSse(created),
      readSse(follower),
      readSse(resumed),
    ]);

    // The reconnecting client is served the same prefix, then the same live tail.
    expect(followed).toEqual(live);
    expect(afterZero).toEqual(live.slice(1));
    expect(followed.at(-1)?.event).toBe('response.completed');
  });

  it('answers 404 for an unknown id and validates the cursor before existence', async () => {
    const server = makeServer(gatedHandler());
    const unknownId = newResponseId();

    const missing = await server.handle(get(`/responses/${unknownId}?stream=true`));
    expect(missing.status).toBe(404);

    // Python parses starting_after before the lookup, so the 400 wins over the 404.
    const badCursor = await server.handle(get(`/responses/${unknownId}?stream=true&starting_after=abc`));
    expect(badCursor.status).toBe(400);
    expect((await errorOf(badCursor)).param).toBe('starting_after');
  });

  it('refuses to replay a response that was not created with background=true', async () => {
    const server = makeServer(gatedHandler());
    const created = await server.handle(post({ input: 'hi' }));
    const { id } = (await created.json()) as ResponseObject;

    const replay = await server.handle(get(`/responses/${id}?stream=true`));
    expect(replay.status).toBe(400);
    const error = await errorOf(replay);
    expect(error.code).toBe('invalid_mode');
    expect(error.param).toBe('stream');
    expect(error.message).toContain('background=true');
  });

  it('drops replay when a stream crosses the retention cap, without cutting the live subscriber', async () => {
    const gate = Promise.withResolvers<void>();
    const server = new ResponsesServer({
      handler: gatedHandler(gate.promise),
      store: new InMemoryResponseProvider(),
      limits: { maxStreamEvents: 3 },
    });

    const created = await server.handle(post({ input: 'hi', background: true, stream: true }));
    // Start draining before the cap bites, so this is a subscriber that is genuinely following
    // live — the case where a silent `controller.close()` loses the terminal event.
    const collected = readSse(created);
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.resolve();
    const events = await collected;

    // The handler emits four events, so the cap of three bites — and the subscriber still reads
    // every one of them, `response.completed` included. A terminal-less close would leave the
    // caller with no way back in: reconnecting an overflowed run is a 400.
    expect(events).toHaveLength(4);
    expect(events[0]?.event).toBe('response.created');
    expect(events.at(-1)?.event).toBe('response.completed');
    expect(events.map((e) => e.data.sequence_number)).toEqual([0, 1, 2, 3]);
    const firstEvent = events[0];
    assert.exists(firstEvent);
    const id = (firstEvent.data.response as ResponseObject).id;

    // The run itself is unharmed: its terminal state is persisted as usual.
    await pollUntil(server, id, (r) => r.status === 'completed');

    // Only the replay log died, whole — the same 400 an expired stream gets.
    const replay = await server.handle(get(`/responses/${id}?stream=true`));
    expect(replay.status).toBe(400);
    expect((await errorOf(replay)).code).toBe('invalid_mode');
  });

  it('keeps a mid-run subscriber to the terminal once the cap has already bitten', async () => {
    const gate = Promise.withResolvers<void>();
    const server = new ResponsesServer({
      handler: gatedHandler(gate.promise),
      store: new InMemoryResponseProvider(),
      limits: { maxStreamEvents: 2 },
    });
    const id = newResponseId();

    const created = await server.handle(
      post({ input: 'hi', background: true, stream: true, response_id: id }),
    );
    const live = readSse(created);
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.resolve();

    // The cap bit on the third event, so a *new* subscription is refused — replay is gone — but
    // the one that was already following reads its terminal.
    const events = await live;
    expect(events.at(-1)?.event).toBe('response.completed');
    await pollUntil(server, id, (r) => r.status === 'completed');
    expect((await server.handle(get(`/responses/${id}?stream=true`))).status).toBe(400);
  });

  it('carries a subscriber that stopped draining to the terminal, past a moving window', async () => {
    // `created` → hold1 → `in_progress` → hold2 → the output item and the terminal, so the test
    // decides exactly when the window moves relative to a parked subscriber.
    const hold1 = Promise.withResolvers<void>();
    const hold2 = Promise.withResolvers<void>();
    const server = new ResponsesServer({
      handler: async function* (_request: CreateResponseRequest, context: HandlerContext) {
        const response = (status: ResponseObject['status']): ResponseObject => ({
          ...context.response,
          status,
        });
        yield { type: 'response.created', response: response('queued') };
        await hold1.promise;
        yield { type: 'response.in_progress', response: response('in_progress') };
        await hold2.promise;
        yield {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'msg_slow',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'done', annotations: [] }],
          },
        };
        yield { type: 'response.completed', response: response('completed') };
      },
      // One event of retention, so `#base` moves on every delivery and outruns anyone parked.
      limits: { maxStreamEvents: 1 },
    });

    const created = await server.handle(post({ input: 'hi', background: true, stream: true }));
    const reader = bodyReader(created);
    const decoder = new TextDecoder();

    // Read one frame and then stop: the subscription is live but no longer draining, so the
    // generator parks *inside* its replay loop, suspended on a `yield` nobody is pulling.
    let text = decoder.decode((await reader.read()).value);
    expect(text).toContain('response.created');
    await new Promise((resolve) => setTimeout(resolve, 20));
    hold1.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Two more deliveries, which push the retained window past the parked cursor. Re-reading the
    // buffer without re-clamping the cursor here indexes it at a negative offset, and the
    // subscriber's stream dies with a TypeError instead of reaching its terminal event.
    hold2.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }

    const events = text
      .split('\n\n')
      .filter((block) => block.trim() !== '' && !block.startsWith(':'))
      .map((block) =>
        block
          .split('\n')
          .find((line) => line.startsWith('event: '))
          ?.slice('event: '.length),
      );
    // Intermediate events may well have been dropped — the cap is a memory bound and this
    // subscriber stopped reading — but the stream still ends where every client expects it to.
    expect(events[0]).toBe('response.created');
    expect(events.at(-1)).toBe('response.completed');
  });

  it('refuses to replay a background response that was not streamed, with the combined message', async () => {
    const server = makeServer(gatedHandler());
    const created = await server.handle(post({ input: 'hi', background: true }));
    const { id } = (await created.json()) as ResponseObject;
    await pollUntil(server, id, (r) => r.status === 'completed');

    const replay = await server.handle(get(`/responses/${id}?stream=true`));
    expect(replay.status).toBe(400);
    const error = await errorOf(replay);
    expect(error.code).toBe('invalid_mode');
    expect(error.message).toContain('stream=true');
    expect(error.message).toContain('TTL');
  });

  it('does not expose an old replay log after the same owner reuses the id', async () => {
    const store = new InMemoryResponseProvider();
    let turn = 0;
    const server = new ResponsesServer({
      handler: (request, context) => {
        turn += 1;
        return lifecycleHandler({ label: `turn${turn}` })(request, context);
      },
      store,
    });
    const id = newResponseId();

    const first = await server.handle(
      post({ input: 'one', background: true, stream: true, response_id: id }),
    );
    expect(JSON.stringify(await readSse(first))).toContain('turn1');
    await pollUntil(server, id, (response) => response.status === 'completed');

    // Same-owner reuse is allowed without DELETE. The replacement has no stream, so the old
    // turn's replay log must become inaccessible as soon as the new generation is persisted.
    const second = await server.handle(post({ input: 'two', background: true, response_id: id }));
    expect(second.status).toBe(200);
    await pollUntil(server, id, (response) => response.status === 'completed');

    const replay = await server.handle(get(`/responses/${id}?stream=true`));
    expect(replay.status).toBe(400);
    expect((await errorOf(replay)).code).toBe('invalid_mode');
  });
});

describe('stores without event persistence stay fail-closed', () => {
  /** The smallest legal provider: every required member, neither optional event member. */
  function baseStore(canned?: StoredResponse): ResponseProvider {
    return {
      async get(_id: string, _owner: ResponseOwner) {
        return canned;
      },
      async put() {
        /* accepted */
      },
      async delete() {
        return false;
      },
      async history() {
        return undefined;
      },
    };
  }

  it('answers 501 for a background create, after the store=true validation', async () => {
    const server = makeServer(gatedHandler(), { store: baseStore() });

    // The store=false violation is still the caller's 400, learned first.
    const invalid = await server.handle(post({ input: 'x', background: true, store: false }));
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).code).toBe('unsupported_parameter');

    const refused = await server.handle(post({ input: 'x', background: true }));
    expect(refused.status).toBe(501);
    expect((await errorOf(refused)).code).toBe('unsupported_parameter');
  });

  it('answers 501 for a stream replay of a stored background response', async () => {
    const responseId = newResponseId();
    const canned: StoredResponse = {
      response: {
        id: responseId,
        object: 'response',
        created_at: 0,
        status: 'completed',
        output: [],
        background: true,
      },
    };
    const server = makeServer(gatedHandler(), { store: baseStore(canned) });

    const replay = await server.handle(get(`/responses/${responseId}?stream=true`));
    expect(replay.status).toBe(501);

    // A non-background stored response is still the caller's 400, not a 501.
    delete canned.response.background;
    const nonBackground = await server.handle(get(`/responses/${responseId}?stream=true`));
    expect(nonBackground.status).toBe(400);
    expect((await errorOf(nonBackground)).code).toBe('invalid_mode');
  });
});

describe('cancel', () => {
  it('cancels an in-flight background run; cancellation wins and is idempotent', async () => {
    const gate = Promise.withResolvers<void>();
    const server = makeServer(gatedHandler(gate.promise));

    const created = await server.handle(post({ input: 'hi', background: true }));
    const { id } = (await created.json()) as ResponseObject;

    const cancelled = await server.handle(
      new Request(`http://localhost:8088/responses/${id}/cancel`, { method: 'POST' }),
    );
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as ResponseObject).status).toBe('cancelled');

    // Cancellation always wins: the persisted state a later GET reads is `cancelled`.
    const after = await server.handle(get(`/responses/${id}`));
    expect(((await after.json()) as ResponseObject).status).toBe('cancelled');

    // Cancelling again is idempotent (Python's sentinel path), not an error.
    const again = await server.handle(
      new Request(`http://localhost:8088/responses/${id}/cancel`, { method: 'POST' }),
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as ResponseObject).status).toBe('cancelled');
  });

  it('refuses to cancel terminal and synchronous responses with the reference messages', async () => {
    const server = makeServer(gatedHandler());

    const background = await server.handle(post({ input: 'hi', background: true }));
    const { id: backgroundId } = (await background.json()) as ResponseObject;
    await pollUntil(server, backgroundId, (r) => r.status === 'completed');
    const completed = await server.handle(
      new Request(`http://localhost:8088/responses/${backgroundId}/cancel`, { method: 'POST' }),
    );
    expect(completed.status).toBe(400);
    expect((await errorOf(completed)).message).toBe('Cannot cancel a completed response.');

    const foreground = await server.handle(post({ input: 'hi' }));
    const { id: foregroundId } = (await foreground.json()) as ResponseObject;
    const synchronous = await server.handle(
      new Request(`http://localhost:8088/responses/${foregroundId}/cancel`, { method: 'POST' }),
    );
    expect(synchronous.status).toBe(400);
    expect((await errorOf(synchronous)).message).toBe('Cannot cancel a synchronous response.');

    const unknown = await server.handle(
      new Request(`http://localhost:8088/responses/${newResponseId()}/cancel`, { method: 'POST' }),
    );
    expect(unknown.status).toBe(404);
  });
});

describe('delete', () => {
  it('refuses to delete an in-flight run, then deletes the finished turn and its replay log', async () => {
    const gate = Promise.withResolvers<void>();
    const server = makeServer(gatedHandler(gate.promise));

    const created = await server.handle(post({ input: 'hi', background: true, stream: true }));
    const reader = bodyReader(created);
    const first = new TextDecoder().decode((await reader.read()).value);
    const id = (JSON.parse(firstDataLine(first)) as { response: ResponseObject }).response.id;

    const inFlight = await server.handle(
      new Request(`http://localhost:8088/responses/${id}`, { method: 'DELETE' }),
    );
    expect(inFlight.status).toBe(400);
    expect((await errorOf(inFlight)).message).toBe('Cannot delete an in-flight response.');

    gate.resolve();
    await reader.cancel();
    await pollUntil(server, id, (r) => r.status === 'completed');

    const deleted = await server.handle(
      new Request(`http://localhost:8088/responses/${id}`, { method: 'DELETE' }),
    );
    expect(deleted.status).toBe(200);

    // The replay log went with the response: the id now reads as absent, not as a stale stream.
    const replay = await server.handle(get(`/responses/${id}?stream=true`));
    expect(replay.status).toBe(404);
  });
});

describe('cancellation always wins over the handler', () => {
  /** Short enough that the past-grace branch is reachable in a unit test. */
  function shortGrace(): void {
    vi.stubEnv('AGENTSERVER_CANCEL_GRACE_MS', '20');
  }

  it('is not overwritten when the handler ignores the signal and finishes past the grace', async () => {
    shortGrace();
    const gate = Promise.withResolvers<void>();
    const store = new ObservableStore();
    const server = new ResponsesServer({ handler: stubbornHandler(gate.promise), store });
    const id = newResponseId();

    const created = await server.handle(post({ input: 'hi', background: true, response_id: id }));
    expect(created.status).toBe(200);

    // The handler is still gated when the grace runs out, so the run outlives the cancel request
    // — the case the winddown's "cancellation wins" claim used to be false for.
    const cancelled = await server.handle(cancelRequest(id));
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as ResponseObject).status).toBe('cancelled');
    const writesAtCancel = store.writes.length;

    gate.resolve();
    // The run's own terminal write is the one that used to replace `cancelled` with `completed`.
    await waitFor(() => store.writes.length > writesAtCancel, "the run's own terminal write");
    expect(store.writes.at(-1)?.status).toBe('cancelled');

    const after = await server.handle(get(`/responses/${id}`));
    const body = (await after.json()) as ResponseObject;
    expect(body.status).toBe('cancelled');
    expect(body.output).toEqual([]);
  });

  it('overrides the terminal on the wire too, so no follower reads `completed`', async () => {
    shortGrace();
    const gate = Promise.withResolvers<void>();
    const server = makeServer(stubbornHandler(gate.promise));
    const id = newResponseId();

    const created = await server.handle(
      post({ input: 'hi', background: true, stream: true, response_id: id }),
    );
    const events = readSse(created);

    const cancelled = await server.handle(cancelRequest(id));
    expect(cancelled.status).toBe(200);
    gate.resolve();

    const terminal = (await events).at(-1)?.data.response as ResponseObject;
    expect(terminal.status).toBe('cancelled');
    expect(terminal.output).toEqual([]);
  });

  it('reports cancelled to GET while the winddown is still inside its grace', async () => {
    // Long enough that every GET below happens while the cancel route is still waiting.
    vi.stubEnv('AGENTSERVER_CANCEL_GRACE_MS', '60000');
    const gate = Promise.withResolvers<void>();
    const server = makeServer(stubbornHandler(gate.promise));
    const id = newResponseId();

    const created = await server.handle(post({ input: 'hi', background: true, response_id: id }));
    expect(created.status).toBe(200);
    // The handler has produced its output and is now held on the gate: the winddown view below
    // is judged against a snapshot that is known to carry something.
    await pollUntil(server, id, (r) => (r.output?.length ?? 0) > 0);

    let cancelSettled = false;
    const cancelling = server.handle(cancelRequest(id)).then((res) => {
      cancelSettled = true;
      return res;
    });

    // The reference refreshes the record's status from the cancel signal on every GET, so the
    // flip to `cancelled` is visible as soon as the cancel was accepted — not only once the
    // route's grace has run out.
    const during = await pollUntil(server, id, (r) => r.status === 'cancelled');
    expect(cancelSettled).toBe(false);
    // Only the status is refreshed. The rest of the snapshot is still the handler's — clearing
    // the accumulated output is the cancelled *terminal*'s job, and that is the cancel route's
    // to apply once the winddown ends.
    expect(during.output).toHaveLength(1);

    gate.resolve();
    const cancelled = await cancelling;
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as ResponseObject).status).toBe('cancelled');
    const final = (await (await server.handle(get(`/responses/${id}`))).json()) as ResponseObject;
    expect(final.status).toBe('cancelled');
    expect(final.output).toEqual([]);
  });

  it('does not write its terminal into the turn that reused its id', async () => {
    shortGrace();
    const gate = Promise.withResolvers<void>();
    const store = new ObservableStore();
    // The first turn ignores its cancellation and stays gated; the second is an ordinary turn that
    // takes the same id once the first has been cancelled and deleted.
    let turn = 0;
    const server = new ResponsesServer({
      handler: (request, context) =>
        (turn++ === 0 ? stubbornHandler(gate.promise) : gatedHandler())(request, context),
      store,
    });
    const id = newResponseId();

    await server.handle(post({ input: 'one', background: true, response_id: id }));
    expect((await server.handle(cancelRequest(id))).status).toBe(200);
    // A cancelled run is terminal, so its id is deletable and reusable even though the handler it
    // gave up on is still running.
    expect((await server.handle(deleteRequest(id))).status).toBe(200);

    const second = await server.handle(post({ input: 'two', background: true, response_id: id }));
    expect(second.status).toBe(200);
    await pollUntil(server, id, (r) => r.status === 'completed');
    const writes = store.writes.length;

    // Now the abandoned first run finally ends. Its terminal write is addressed by an id it no
    // longer holds, so it must not land at all — least of all as a `cancelled` over the new turn.
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(store.writes.length).toBe(writes);
    const after = (await (await server.handle(get(`/responses/${id}`))).json()) as ResponseObject;
    expect(after.status).toBe('completed');
  });

  it('clears output, error and completed_at from the cancelled snapshot', async () => {
    shortGrace();
    const gate = Promise.withResolvers<void>();
    const store = new ObservableStore();
    const server = new ResponsesServer({ handler: stubbornHandler(gate.promise), store });
    const id = newResponseId();

    await server.handle(post({ input: 'hi', background: true, response_id: id }));
    // Wait until the handler's output item and its handler-owned `error` / `completed_at` are in.
    const running = await pollUntil(server, id, (r) => r.output.length === 1);
    expect(running.error).toBeDefined();
    expect(running.completed_at).toBe(1234);

    const cancelled = await server.handle(cancelRequest(id));
    const body = (await cancelled.json()) as ResponseObject;
    expect(body.status).toBe('cancelled');
    // Cancellation always wins: 0 output items regardless of what processing had produced.
    expect(body.output).toEqual([]);
    expect(body.error).toBeUndefined();
    expect(body.completed_at).toBeUndefined();

    const stored = (await store.get(id, undefined))?.response;
    expect(stored?.status).toBe('cancelled');
    expect(stored?.output).toEqual([]);
    expect(stored?.error).toBeUndefined();
    expect(stored?.completed_at).toBeUndefined();

    // Let the detached run wind down rather than leaving it pinned on the gate.
    const writesAtCancel = store.writes.length;
    gate.resolve();
    await waitFor(() => store.writes.length > writesAtCancel, "the run's own terminal write");
    expect(store.writes.at(-1)?.output).toEqual([]);
  });
});

describe('a registered run that has already finished', () => {
  /** Freezes a completed streamed run inside its replay-log write: terminal, still registered. */
  async function frozenAfterTerminal(): Promise<{
    server: ResponsesServer;
    store: ObservableStore;
    id: string;
    release: () => void;
  }> {
    const store = new ObservableStore();
    const hold = Promise.withResolvers<void>();
    store.putEventsGate = hold.promise;
    // Each turn under this id is tagged, so a replay log can be attributed to the run that made it.
    let turn = 0;
    const server = new ResponsesServer({
      handler: (request, context) => {
        turn += 1;
        return lifecycleHandler({ label: `turn${turn}` })(request, context);
      },
      store,
    });
    const id = newResponseId();

    const created = await server.handle(
      post({ input: 'hi', background: true, stream: true, response_id: id }),
    );
    await created.body?.cancel();
    // The terminal state is persisted and delivered *before* the replay log is written, so once
    // the store is inside `putEvents` the run is finished — and its registration is still there,
    // because that is dropped last of all.
    await waitFor(() => store.putEventsEntered, 'the run to reach its replay-log write');
    return { server, store, id, release: hold.resolve };
  }

  it('refuses to cancel it with the terminal message rather than winding down a finished run', async () => {
    const { server, id, release } = await frozenAfterTerminal();

    const refused = await server.handle(cancelRequest(id));
    expect(refused.status).toBe(400);
    expect((await errorOf(refused)).message).toBe('Cannot cancel a completed response.');

    release();
  });

  it('does not let its replay-log write land in the turn that reuses the id', async () => {
    const { server, store, id, release } = await frozenAfterTerminal();

    // Deleting a finished-but-still-writing run frees the id straight away, and the write it is
    // suspended inside is addressed by that id alone.
    expect((await server.handle(deleteRequest(id))).status).toBe(200);

    // A brand new turn takes the id — this one *without* `stream=true`, so it has no replay log
    // of its own for the stale one to be mistaken for.
    const second = await server.handle(post({ input: 'two', background: true, response_id: id }));
    expect(second.status).toBe(200);
    await pollUntil(server, id, (r) => r.status === 'completed');

    release();
    await waitFor(() => store.putEventsDone, 'the first run to finish its replay-log write');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The new response was not created with stream=true, so this is the combined refusal — not a
    // 200 replaying the deleted run's output under someone else's turn.
    const replay = await server.handle(get(`/responses/${id}?stream=true`));
    expect(replay.status).toBe(400);
    const error = await errorOf(replay);
    expect(error.code).toBe('invalid_mode');
    expect(error.message).toContain('stream=true');
  });

  it('does not let its replay-log write destroy the log of the streamed turn that reused the id', async () => {
    const { server, store, id, release } = await frozenAfterTerminal();

    // Deleting the finished-but-still-writing run frees the id straight away.
    expect((await server.handle(deleteRequest(id))).status).toBe(200);

    // The new turn is *streamed* too, so it has a replay log of its own — the thing a blanket
    // "invalidate whatever is under this id" cleanup destroys.
    const second = await server.handle(
      post({ input: 'two', background: true, stream: true, response_id: id }),
    );
    const fresh = await readSse(second);
    expect(fresh.at(-1)?.event).toBe('response.completed');
    // The tag is what makes the two logs distinguishable at all.
    expect(JSON.stringify(fresh)).toContain('turn2');
    expect(JSON.stringify(fresh)).not.toContain('turn1');
    await pollUntil(server, id, (r) => r.status === 'completed');
    await waitFor(() => store.putEventsSettled >= 1, "the new run's replay log to be stored");

    // The new log is complete before the stale write lands.
    const before = await server.handle(get(`/responses/${id}?stream=true`));
    expect(before.status).toBe(200);
    expect(await readSse(before)).toEqual(fresh);

    // …and now the abandoned run's write finally arrives, addressed by an id it no longer holds.
    release();
    await waitFor(() => store.putEventsSettled >= 2, 'the stale replay-log write to land');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const replay = await server.handle(get(`/responses/${id}?stream=true`));
    expect(replay.status).toBe(200);
    expect(await readSse(replay)).toEqual(fresh);
  });

  it('fences stale replay writes across two server instances sharing one store', async () => {
    const store = new ObservableStore();
    const hold = Promise.withResolvers<void>();
    store.putEventsGate = hold.promise;
    const firstServer = new ResponsesServer({ handler: lifecycleHandler({ label: 'server1' }), store });
    const secondServer = new ResponsesServer({ handler: lifecycleHandler({ label: 'server2' }), store });
    const id = newResponseId();

    const first = await firstServer.handle(
      post({ input: 'one', background: true, stream: true, response_id: id }),
    );
    await first.body?.cancel();
    await waitFor(() => store.putEventsEntered, 'the first server to reach its replay-log write');

    // The second server cannot see the first one's in-memory claim. It starts a newer generation
    // in the shared provider and stores its own complete replay log.
    const second = await secondServer.handle(
      post({ input: 'two', background: true, stream: true, response_id: id }),
    );
    const fresh = await readSse(second);
    expect(JSON.stringify(fresh)).toContain('server2');
    await waitFor(() => store.putEventsSettled >= 1, "the second server's replay log to be stored");

    // Release the older server last. Process-local counters assigned generation 1 in both
    // servers, so this stale write used to pass the fence and replace server2's replay log.
    hold.resolve();
    await waitFor(() => store.putEventsSettled >= 2, "the first server's stale write to settle");

    const replay = await secondServer.handle(get(`/responses/${id}?stream=true`));
    expect(replay.status).toBe(200);
    expect(await readSse(replay)).toEqual(fresh);
  });

  it('does not resurrect the deleted replay log when its write lands before the id is reused', async () => {
    const { server, store, id, release } = await frozenAfterTerminal();

    expect((await server.handle(deleteRequest(id))).status).toBe(200);
    release();
    await waitFor(() => store.putEventsDone, 'the first run to finish its replay-log write');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await server.handle(post({ input: 'two', background: true, response_id: id }));
    expect(second.status).toBe(200);
    await pollUntil(server, id, (r) => r.status === 'completed');

    expect((await server.handle(get(`/responses/${id}?stream=true`))).status).toBe(400);
  });

  it('deletes it instead of calling it in-flight', async () => {
    const { server, store, id, release } = await frozenAfterTerminal();

    const deleted = await server.handle(deleteRequest(id));
    expect(deleted.status).toBe(200);

    release();
    await waitFor(() => store.putEventsDone, 'the replay-log write');

    // The delete stands: a run winding down does not resurrect the id it was deleted under.
    const gone = await server.handle(get(`/responses/${id}`));
    expect(gone.status).toBe(404);
  });
});

describe('the background registry survives a reused id', () => {
  it('refuses a second background run under an id that is already in flight', async () => {
    const gate = Promise.withResolvers<void>();
    const server = makeServer(gatedHandler(gate.promise));
    const id = newResponseId();

    const first = await server.handle(post({ input: 'one', background: true, response_id: id }));
    expect(first.status).toBe(200);

    const second = await server.handle(post({ input: 'two', background: true, response_id: id }));
    expect(second.status).toBe(409);
    const error = await errorOf(second);
    expect(error.code).toBe('response_in_flight');
    expect(error.param).toBe('response_id');

    // The incumbent is untouched — the collision used to displace it in the registry, after which
    // every route answered for the wrong run.
    const inFlight = await server.handle(get(`/responses/${id}`));
    expect(inFlight.status).toBe(200);
    expect(['queued', 'in_progress']).toContain(((await inFlight.json()) as ResponseObject).status);

    gate.resolve();
    await pollUntil(server, id, (r) => r.status === 'completed');
  });

  it('admits exactly one of two simultaneous creates under one id', async () => {
    const gate = Promise.withResolvers<void>();
    const server = makeServer(gatedHandler(gate.promise));
    const id = newResponseId();

    // Started together, so both are inside the create path at once. The registry is only written
    // once a run exists, several awaits after the id is settled — a check against it that is not
    // paired with a claim in the same synchronous step lets both through, and the second run then
    // registers over the first.
    const [first, second] = await Promise.all([
      server.handle(post({ input: 'one', background: true, response_id: id })),
      server.handle(post({ input: 'two', background: true, response_id: id })),
    ]);

    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    const error = await errorOf(loser);
    expect(error.code).toBe('response_in_flight');
    expect(error.param).toBe('response_id');

    gate.resolve();
    await pollUntil(server, id, (r) => r.status === 'completed');
  });

  it('frees a claimed id again when the create fails before the run starts', async () => {
    // The failure the claim has to survive is the one *after* it is taken: a handler that throws
    // during its own setup, before there is a run to hand the id to.
    let attempts = 0;
    const server = new ResponsesServer({
      handler: (request, context) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('setup failed');
        }
        return gatedHandler()(request, context);
      },
    });
    const id = newResponseId();

    expect((await server.handle(post({ input: 'x', background: true, response_id: id }))).status).toBe(500);

    // A failed create must not pin the id for the life of the container: the retry is served, not
    // refused with the in-flight 409.
    const retried = await server.handle(post({ input: 'x', background: true, response_id: id }));
    expect(retried.status).toBe(200);
    await pollUntil(server, id, (r) => r.status === 'completed');
  });

  it('tells a different user nothing at all about an id that is busy', async () => {
    const gate = Promise.withResolvers<void>();
    const server = makeServer(gatedHandler(gate.promise));
    const id = newResponseId();

    const first = await server.handle(
      new Request('http://localhost:8088/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-user-id': 'alice' },
        body: JSON.stringify({ input: 'one', background: true, response_id: id }),
      }),
    );
    expect(first.status).toBe(200);

    const other = await server.handle(
      new Request('http://localhost:8088/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-user-id': 'mallory' },
        body: JSON.stringify({ input: 'two', background: true, response_id: id }),
      }),
    );
    // Not a 409: "busy" would confirm the id exists, which is Alice's business, not Mallory's.
    expect(other.status).toBe(404);

    gate.resolve();
  });

  it('lets a finishing run deregister only its own registration', async () => {
    const store = new ObservableStore();
    const hold = Promise.withResolvers<void>();
    store.putEventsGate = hold.promise;
    const gate = Promise.withResolvers<void>();
    // The first turn runs straight through; the second is held open, so it is still registered
    // when the first one's teardown finally runs.
    let turn = 0;
    const server = new ResponsesServer({
      handler: (request, context) =>
        (turn++ === 0 ? gatedHandler() : gatedHandler(gate.promise))(request, context),
      store,
    });
    const id = newResponseId();

    await server.handle(post({ input: 'one', background: true, stream: true, response_id: id }));
    await waitFor(() => store.putEventsEntered, 'the first run to reach its replay-log write');

    // Deleting the finished-but-registered run frees the id while that run is still winding down.
    expect((await server.handle(deleteRequest(id))).status).toBe(200);

    const second = await server.handle(post({ input: 'two', background: true, response_id: id }));
    expect(second.status).toBe(200);

    hold.resolve();
    await waitFor(() => store.putEventsDone, 'the first run to finish');
    // One macrotask is enough: the registry is cleared synchronously right after that write.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The first run's teardown must not have taken the second run's registration with it.
    const live = await server.handle(get(`/responses/${id}`));
    expect(live.status).toBe(200);
    expect(['queued', 'in_progress']).toContain(((await live.json()) as ResponseObject).status);

    gate.resolve();
    await pollUntil(server, id, (r) => r.status === 'completed');
  });
});

describe('draining background runs', () => {
  it('winds an in-flight run down to a persisted incomplete terminal on drain', async () => {
    const gate = Promise.withResolvers<void>();
    const store = new InMemoryResponseProvider();
    const server = new ResponsesServer({ handler: gatedHandler(gate.promise), store });

    const created = await server.handle(post({ input: 'hi', background: true }));
    const { id } = (await created.json()) as ResponseObject;

    // drain() resolves only after the detached run has persisted its terminal state.
    await server.drain();

    const stored = await store.get(id, undefined);
    expect(stored).toBeDefined();
    expect(stored?.response.status).toBe('incomplete');
    expect(stored?.response.incomplete_details?.reason).toBe('interrupted');
  });

  it('waits for a create that has claimed its id but has not started its run yet', async () => {
    // The window: the id is claimed synchronously, and the create then spends several awaits —
    // the writability check, the session lookup, the handler's own setup — before there is a run
    // to register. A drain that only knows about *runs* sees an empty registry here and returns
    // while the turn it was supposed to wind down is still coming.
    const setup = Promise.withResolvers<void>();
    const store = new ObservableStore();
    store.assertWritableGate = setup.promise;
    const server = new ResponsesServer({ handler: gatedHandler(), store });
    const id = newResponseId();

    const create = server.handle(post({ input: 'hi', background: true, response_id: id }));
    await waitFor(() => store.assertWritableEntered, 'the create to reach the writability check');

    let drained = false;
    const draining = server.drain().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(drained).toBe(false);
    expect(store.writes).toHaveLength(0);

    setup.resolve();
    await draining;
    // Everything the claim owed is over by the time drain returns: setup, the run, and the
    // terminal persist.
    expect((await create).status).toBe(200);
    const stored = await store.get(id, undefined);
    expect(stored).toBeDefined();
    expect(['completed', 'incomplete', 'failed', 'cancelled']).toContain(stored?.response.status);
  });

  it('settles the wait when a create the drain is already holding fails in setup', async () => {
    // The mirror image of the test above, and the reason the wait cannot simply be created and
    // forgotten: the drain took this claim's promise while the create was still in setup, and the
    // create then failed without ever producing a run. Dropping the claim from the registry is not
    // enough — the drain is holding the promise, not the map entry.
    let fail!: (error: Error) => void;
    const gate = new Promise<void>((_, reject) => {
      fail = reject;
    });
    // Consumed by `assertWritable`; nothing else observes it.
    gate.catch(() => undefined);
    const store = new ObservableStore();
    store.assertWritableGate = gate;
    const server = new ResponsesServer({ handler: gatedHandler(), store });
    const id = newResponseId();

    const create = server.handle(post({ input: 'x', background: true, response_id: id }));
    await waitFor(() => store.assertWritableEntered, 'the create to reach the writability check');

    const draining = server.drain();
    fail(new Error('store unavailable'));
    expect((await create).status).toBe(500);

    await expect(
      Promise.race([
        draining,
        new Promise((_, reject) => setTimeout(() => reject(new Error('drain hung')), 1000)),
      ]),
    ).resolves.toBeUndefined();
    // Nothing ran, so nothing was persisted — and no claim was left pinning the id.
    expect(store.writes).toHaveLength(0);
  });

  it('settles the wait when the handler throws before its first event', async () => {
    const server = new ResponsesServer({
      handler: async function* () {
        throw new Error('exploded before created');
        // biome-ignore lint/correctness/noUnreachable: never runs; the yield only makes this function a generator
        yield { type: 'response.created' };
      },
    });

    const created = await server.handle(post({ input: 'hi', background: true }));
    expect(created.status).toBe(200);

    await expect(
      Promise.race([
        server.drain(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('drain hung')), 1000)),
      ]),
    ).resolves.toBeUndefined();
  });

  it('refuses a create that reaches its claim after the drain has begun', async () => {
    // `#route` checks the draining flag, but the body read that follows is an await: a request
    // admitted a moment before `drain()` can still claim an id after drain has taken its snapshot
    // of what to wait for, and that run would outlive the drain unobserved.
    const body = Promise.withResolvers<void>();
    const store = new ObservableStore();
    const server = new ResponsesServer({ handler: gatedHandler(), store });

    const request = slowPost({ input: 'hi', background: true }, body.promise);
    const create = server.handle(request);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const draining = server.drain();
    body.resolve();
    const answer = await create;
    expect(answer.status).toBe(503);

    await draining;
    // Nothing was admitted, so nothing was left running behind the drain.
    expect(store.writes).toHaveLength(0);
  });
});
