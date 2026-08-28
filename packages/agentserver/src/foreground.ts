import { sseKeepAliveMs } from './config.js';
import { HEADERS } from './context.js';
import { ProtocolError } from './errors.js';
import { jsonResponse, sseResponse } from './http.js';
import type { ResponseTracker } from './lifecycle.js';
import { flushTelemetry } from './observability/flush.js';
import { SequenceNumberWriter } from './sse.js';
import { storageFailed, TerminalPersister } from './terminal.js';
import type { ResponseEvent } from './wire.js';
import { isTerminalEventType } from './wire.js';

/**
 * `stream=false`: drive the handler to completion and answer with the finished resource.
 *
 * A persistence failure after the handler completes is answered as the resource with
 * `status: "failed"` and `error.code: "storage_error"` (.NET's documented behaviour) — not as an
 * opaque 500: the handler did its work, and the caller needs to know specifically that a
 * follow-up `previous_response_id` will not resolve.
 */
export async function collectResponse(
  events: AsyncIterable<ResponseEvent>,
  tracker: ResponseTracker,
  persist: () => Promise<void>,
  sessionId: string,
): Promise<Response> {
  for await (const _ of events) {
    // The lifecycle layer already folds each event into the tracker.
  }
  let response = tracker.response;
  try {
    await persist();
  } catch (error) {
    if (error instanceof ProtocolError) {
      // Not a storage outage but a protocol answer — the ownership 404 for a reused
      // `response_id`, most importantly. The caller gets the real status code.
      throw error;
    }
    response = storageFailed(response);
  }
  // No flush here: `ResponsesServer.handle` flushes every answered request in its own `finally`,
  // which is what covers the `throw` above as well (the reference's `flush_spans`).
  return jsonResponse(response, 200, { [HEADERS.sessionId]: sessionId });
}

/** `stream=true`: frame the events as SSE, stamping the sequence numbers. */
export async function streamResponse(
  events: AsyncIterable<ResponseEvent>,
  tracker: ResponseTracker,
  persist: () => Promise<void>,
  sessionId: string,
  releaseSignals: () => void,
  signal: AbortSignal,
): Promise<Response> {
  // The first event is pulled *before* the 200 and the SSE headers go out. A handler that fails
  // during setup — an unauthorized session, a missing agent — therefore still reaches the
  // caller as a real status code, which is impossible once the response is committed. Nothing
  // is persisted before `response.created` either, so this is the same boundary the protocol
  // already draws.
  const iterator = events[Symbol.asyncIterator]();
  let first: IteratorResult<ResponseEvent>;
  try {
    first = await iterator.next();
  } catch (error) {
    await iterator.return?.();
    releaseSignals();
    throw error;
  }

  const sequence = new SequenceNumberWriter();
  const persister = new TerminalPersister(persist, tracker);
  // The whole teardown of one committed stream, run at most once: close the handler chain first
  // so its own `finally` blocks run, then record the partial turn (a stream torn down before its
  // terminal is resumable with `previous_response_id`), release the turn's claim and listeners,
  // and flush before the platform freezes the sandbox (the reference's `trace_stream` flushes in
  // its own `finally` the same way).
  let torndown = false;
  const windDown = async (): Promise<void> => {
    if (torndown) {
      return;
    }
    torndown = true;
    try {
      await iterator.return?.();
    } catch {
      // The generator's own failure must not mask the teardown.
    }
    await persister.ensureAttempted();
    releaseSignals();
    await flushTelemetry();
  };
  const numbered = async function* (): AsyncGenerator<ResponseEvent> {
    try {
      let pending = first;
      while (pending.done !== true) {
        let event = pending.value;
        if (isTerminalEventType(event.type)) {
          event = await persister.onTerminal(event);
        }
        yield sequence.stamp(event);
        pending = await iterator.next();
      }
    } finally {
      // The consumer-driven path: the stream ran to completion, or a cancel tore it down early.
      await windDown();
    }
  };
  // The consumer is not guaranteed: a host that mounts `fetch` directly may abandon the body
  // without cancelling it, leaving the generator above parked at a `yield` where its `finally`
  // can never run — and with it the claim on the response id, which would answer 409 and hold
  // `drain()` open for the life of the process. The turn's abort signal fires for exactly the
  // two ways such a stream dies — the client disconnecting, the container shutting down — so it
  // triggers the same teardown directly. A stream with a live consumer is unharmed: closing the
  // source lets a pending pull deliver what the handler winds down with, and whichever of the
  // two paths gets there second is a no-op.
  signal.addEventListener('abort', () => void windDown(), { once: true });
  // Re-read after registering — an already-aborted signal never fires a later listener (the same
  // edge-and-state rule `linkedAbort` documents).
  if (signal.aborted) {
    void windDown();
  }

  return sseResponse(numbered(), { keepAliveMs: sseKeepAliveMs(), sessionId });
}
