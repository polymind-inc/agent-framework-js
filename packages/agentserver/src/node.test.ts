import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvocationsServer } from './invocations.js';
import type { RunningServer } from './node.js';
import { serve } from './node.js';
import { writeWebResponse } from './node-internals.js';
import type { HandlerContext } from './server.js';
import { ResponsesServer } from './server.js';
import type { CreateResponseRequest, ResponseEvent, ResponseObject } from './wire.js';

/** A minimal echo agent, over a real socket. */
function echo(request: CreateResponseRequest, context: HandlerContext): AsyncIterable<ResponseEvent> {
  const text = `Echo: ${String(request.input)} (history: ${context.history.length})`;
  return (async function* () {
    yield { type: 'response.created', response: context.response };
    yield { type: 'response.in_progress', response: context.response };
    yield {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    };
    yield { type: 'response.completed', response: context.response };
  })();
}

let running: RunningServer;
let base: string;

beforeAll(async () => {
  running = await serve(new ResponsesServer({ handler: echo }), {
    port: 0,
    host: '127.0.0.1',
    handleSignals: false,
  });
  base = `http://127.0.0.1:${running.port}`;
});

afterAll(async () => {
  await running.close();
});

describe('node adapter', () => {
  it('serves the readiness probe over HTTP', async () => {
    const response = await fetch(`${base}/readiness`);
    expect(await response.json()).toEqual({ status: 'healthy' });
  });

  it('answers the two curl calls from the hosting guide', async () => {
    // curl -X POST :PORT/responses -d '{"input": "Hi"}'
    const first = await fetch(`${base}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Hi' }),
    });
    const created = (await first.json()) as ResponseObject;

    expect(first.status).toBe(200);
    expect(created.id).toMatch(/^caresp_/);
    expect(JSON.stringify(created.output)).toContain('Echo: Hi (history: 0)');

    // curl -X POST :PORT/responses -d '{"input": "Continue.", "previous_response_id": "caresp_..."}'
    const second = await fetch(`${base}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Continue.', previous_response_id: created.id }),
    });
    const continued = (await second.json()) as ResponseObject;

    expect(second.status).toBe(200);
    // The second turn is handed both halves of the first: what the caller said, and the answer.
    expect(JSON.stringify(continued.output)).toContain('history: 2');
  });

  it('streams SSE over the socket', async () => {
    const response = await fetch(`${base}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Hi', stream: true }),
    });

    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const body = await response.text();
    expect(body).toContain('event: response.created');
    expect(body).toContain('event: response.completed');
    expect(body).toContain('"sequence_number":0');
  });

  it('returns the documented error envelope over HTTP', async () => {
    const response = await fetch(`${base}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'x', background: true, store: false }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { code: string; param: string } }).toMatchObject({
      error: { code: 'unsupported_parameter', param: 'background' },
    });
    expect(response.headers.get('x-platform-error-source')).toBe('user');
  });

  it('serves an InvocationsServer over the same adapter', async () => {
    const invocations = await serve(
      new InvocationsServer({
        handler: async (request, context) =>
          new Response(`echo:${await request.text()}:${context.invocationId}`, {
            headers: { 'content-type': 'text/plain' },
          }),
      }),
      { port: 0, host: '127.0.0.1', handleSignals: false, observability: false },
    );
    try {
      const probe = await fetch(`http://127.0.0.1:${invocations.port}/readiness`);
      expect(await probe.json()).toEqual({ status: 'healthy' });

      // curl -X POST :PORT/invocations -d '{"message": "Hi"}'
      const response = await fetch(`http://127.0.0.1:${invocations.port}/invocations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-invocation-id': 'inv_smoke' },
        body: '{"message": "Hi"}',
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('echo:{"message": "Hi"}:inv_smoke');
      expect(response.headers.get('x-agent-invocation-id')).toBe('inv_smoke');
      expect(response.headers.get('x-agent-session-id')).toBeTruthy();
    } finally {
      await invocations.close();
    }
  });

  it('removes its process signal handlers when closed', async () => {
    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    };
    const signalled = await serve(new ResponsesServer({ handler: echo }), {
      port: 0,
      host: '127.0.0.1',
      observability: false,
    });
    try {
      expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
      expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
    } finally {
      await signalled.close();
    }
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    // Closing is idempotent and does not re-register anything.
    await signalled.close();
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
  });
});

describe('backpressure', () => {
  /** A socket that refuses every chunk until `'drain'` is emitted by the test. */
  class StalledResponse extends EventEmitter {
    destroyed = false;
    writableEnded = false;
    readonly written: string[] = [];

    writeHead(): this {
      return this;
    }

    write(chunk: Uint8Array): boolean {
      this.written.push(new TextDecoder().decode(chunk));
      return false; // "my buffer is full"
    }

    end(): void {
      this.writableEnded = true;
    }
  }

  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('stops reading the body until the socket drains', async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller): void {
        pulls += 1;
        if (pulls <= 3) {
          controller.enqueue(encoder.encode(`chunk-${pulls}`));
        } else {
          controller.close();
        }
      },
    });

    const res = new StalledResponse();
    const done = writeWebResponse(new Response(body), res as unknown as ServerResponse);

    await flush();
    // The first chunk was refused (`write` returned false), so nothing further may be read or
    // written until the socket says 'drain' — this is what keeps a slow SSE consumer from making
    // the server buffer the whole stream.
    expect(res.written).toEqual(['chunk-1']);

    res.emit('drain');
    await flush();
    expect(res.written).toEqual(['chunk-1', 'chunk-2']);

    res.emit('drain');
    await flush();
    res.emit('drain');
    await done;
    expect(res.written).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
    expect(res.writableEnded).toBe(true);
  });

  it('discards chunks after the client is gone instead of writing to a dead socket', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(encoder.encode('one'));
        controller.enqueue(encoder.encode('two'));
        controller.close();
      },
    });

    const res = new StalledResponse();
    const done = writeWebResponse(new Response(body), res as unknown as ServerResponse);

    await flush();
    expect(res.written).toEqual(['one']);
    // The client hangs up while the write is stalled: the pending chunk is dropped, the body is
    // still drained to completion (so the producer's own teardown runs), and nothing crashes.
    res.destroyed = true;
    res.emit('close');
    await done;
    expect(res.written).toEqual(['one']);
  });
});
