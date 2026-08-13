import { sseKeepAliveSeconds } from './config.js';
import { HEADERS } from './context.js';
import { ProtocolError } from './errors.js';
import { jsonResponse } from './http.js';
import type { ResponseTracker } from './lifecycle.js';
import { flushTelemetry } from './observability/flush.js';
import { SequenceNumberWriter, SSE_HEADERS, toSseStream } from './sse.js';
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
  const numbered = async function* (): AsyncGenerator<ResponseEvent> {
    try {
      let pending = first;
      while (pending.done !== true) {
        let event = pending.value;
        if (isTerminalEventType(String(event.type))) {
          event = await persister.onTerminal(event);
        }
        yield sequence.stamp(event);
        pending = await iterator.next();
      }
    } finally {
      // The client-disconnect path: the stream was torn down before the terminal event came
      // through. Close the handler chain first so its own `finally` blocks run, then record the
      // partial turn.
      try {
        await iterator.return?.();
      } catch {
        // The generator's own failure must not mask the teardown.
      }
      await persister.ensureAttempted();
      releaseSignals();
      // Stream over — flush before the platform freezes the sandbox (the reference's
      // `trace_stream` flushes in its own `finally` the same way).
      await flushTelemetry();
    }
  };

  const keepAliveMs = sseKeepAliveSeconds() * 1000;
  return new Response(toSseStream(numbered(), { keepAliveMs }), {
    status: 200,
    headers: { ...SSE_HEADERS, [HEADERS.sessionId]: sessionId },
  });
}
