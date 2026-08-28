/**
 * Helpers shared by this package's test suites. Not a test file itself (vitest collects only
 * `*.test.ts`), and not reachable from any build entry, so it never lands in the published
 * artifact.
 */

import { assert } from 'vitest';
import type { HandlerContext, ResponseHandler } from './server.js';
import { ResponsesServer } from './server.js';
import { InMemoryResponseProvider } from './store/memory.js';
import type { ResponseProvider } from './store/provider.js';
import type { CreateResponseRequest, ResponseObject } from './wire.js';

/** A `POST /responses` request with a JSON body. */
export function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:8088/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** Parses an SSE body into `{ event, data }` pairs. */
export async function readSse(
  response: Response,
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((block) => block.trim() !== '' && !block.startsWith(':'))
    .map((block) => {
      const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
      const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
      assert.exists(eventLine);
      assert.exists(dataLine);
      return {
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
      };
    });
}

/** Resolves when `signal` fires — or immediately, when it already has. */
function onAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** The knobs on {@link lifecycleHandler}. */
export interface LifecycleHandlerOptions {
  /**
   * Stream the reference samples' echo shape between `in_progress` and the terminal: an
   * `output_item.added`, one `output_text.delta` carrying `Echo: <input>`, then the completed
   * item.
   */
  echo?: boolean | undefined;
  /**
   * Emit one completed message item, `msg_<label>` carrying `label` as its text. The tag is what
   * lets tests that put two turns under one id tell their event logs apart — untagged, two runs
   * produce byte-identical streams, and "the stale log replaced the fresh one" would be
   * indistinguishable from success. Ignored when `echo` is set.
   */
  label?: string | undefined;
  /** Holds the handler open between `in_progress` and its output until this promise resolves. */
  gate?: Promise<void> | undefined;
  /**
   * Ignore cancellation completely: produce the output first, then await `gate` without racing
   * the abort signal, and complete anyway once it opens — the misbehaving half of the
   * cancellation contract. By default the handler instead waits on `gate` *before* its output,
   * racing the abort signal and rethrowing its reason, the way a well-behaved handler is
   * documented to. The rethrown value is the real shape, not a hand-named `Error`: the
   * `DOMException` the platform puts on `signal.reason`, and the same value the framework's
   * providers propagate for an interrupted model call.
   */
  ignoreAbort?: boolean | undefined;
  /**
   * Extra fields merged into the `in_progress` event's response snapshot — fields only a handler
   * can put on the resource.
   */
  inProgressResponse?: Partial<ResponseObject> | undefined;
  /** Called as the handler starts and again just before the terminal event. */
  work?: ((stage: 'start' | 'late') => void) | undefined;
}

/**
 * The one parameterized builder for the lifecycle shape every suite drives the server with:
 * `response.created`, `response.in_progress`, optional output, then `response.completed`.
 */
export function lifecycleHandler(options: LifecycleHandlerOptions = {}): ResponseHandler {
  const { echo = false, label, gate, ignoreAbort = false, inProgressResponse, work } = options;
  return async function* (request: CreateResponseRequest, context: HandlerContext) {
    const response = (status: ResponseObject['status']): ResponseObject => ({
      ...context.response,
      status,
    });
    work?.('start');
    yield { type: 'response.created', response: response('queued') };
    yield {
      type: 'response.in_progress',
      response:
        inProgressResponse === undefined
          ? response('in_progress')
          : { ...response('in_progress'), ...inProgressResponse },
    };
    if (gate !== undefined && !ignoreAbort) {
      await Promise.race([gate, onAbort(context.signal)]);
      context.signal.throwIfAborted();
    }
    if (echo) {
      const text = `Echo: ${typeof request.input === 'string' ? request.input : JSON.stringify(request.input)}`;
      yield {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] },
      };
      yield {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: text,
      };
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
    } else if (label !== undefined) {
      yield {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: `msg_${label}`,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: label, annotations: [] }],
        },
      };
    }
    if (gate !== undefined && ignoreAbort) {
      // Deliberately *not* racing `context.signal`: this handler does not honour cancellation.
      await gate;
    }
    work?.('late');
    yield { type: 'response.completed', response: response('completed') };
  };
}

/** A server over an in-memory store; the default handler is the reference echo shape. */
export function makeServer(
  handler: ResponseHandler = lifecycleHandler({ echo: true }),
  options: { store?: ResponseProvider; hosted?: boolean } = {},
): ResponsesServer {
  return new ResponsesServer({
    handler,
    store: options.store ?? new InMemoryResponseProvider(),
    // Always explicit: leaving it unset would let FOUNDRY_HOSTING_ENVIRONMENT in the test
    // runner's environment flip every test into hosted mode.
    hosted: options.hosted ?? false,
  });
}
