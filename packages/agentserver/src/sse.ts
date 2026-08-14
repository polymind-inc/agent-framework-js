import type { ResponseEvent } from './wire.js';

/** Headers an SSE response must carry. `x-accel-buffering` stops proxies from batching events. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

/** The keep-alive comment. A comment line is ignored by clients but keeps the socket warm. */
export const SSE_KEEPALIVE = ': keep-alive\n\n';

/**
 * Encodes one event in the wire format: `event:` line, `data:` line, blank line.
 *
 * The event's `type` doubles as the SSE event name, which is what the reference clients dispatch
 * on.
 *
 * ## Security considerations
 *
 * The event name is written as a raw line, so a `\n` or `\r` in it would end the line and let the
 * rest be read as further SSE fields — a whole forged event, in the worst case. `type` comes from
 * a handler and a handler is application code, so the line breaks are stripped rather than
 * trusted. `data` needs no such care: `JSON.stringify` escapes them.
 */
export function encodeEvent(event: ResponseEvent): string {
  const name = String(event.type).replace(/[\r\n]+/g, ' ');
  return `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Stamps a gap-free `sequence_number` on each event of one stream.
 *
 * Numbering starts at 0 per stream and must have no gaps: a client that reconnects with
 * `?starting_after=N` asks the server to replay everything after N, which only works if the
 * numbers are dense. A handler never sets this itself.
 */
export class SequenceNumberWriter {
  #next = 0;

  /** Returns `event` with its `sequence_number` assigned. */
  stamp(event: ResponseEvent): ResponseEvent {
    return { ...event, sequence_number: this.#next++ };
  }
}

/**
 * Turns an event stream into the SSE byte stream.
 *
 * A client disconnect surfaces as the stream's own `cancel`, which closes the source iterator —
 * the handler observes it through the abort signal the server wires up per request.
 *
 * @param events - The events to send, in order.
 * @param options.keepAliveMs - Emit a keep-alive comment after this much silence. `0` disables it.
 */
export function toSseStream(
  events: AsyncIterable<ResponseEvent>,
  options: { keepAliveMs?: number } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const keepAliveMs = options.keepAliveMs ?? 0;
  const iterator = events[Symbol.asyncIterator]();
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller): void {
      if (keepAliveMs > 0) {
        keepAlive = setInterval(() => {
          try {
            // Keep at most one comment queued. A disconnected or slow client must not turn the
            // timer into an unbounded memory queue while the source is silent.
            if ((controller.desiredSize ?? 0) > 0) {
              controller.enqueue(encoder.encode(SSE_KEEPALIVE));
            }
          } catch {
            // The stream is already closed; the pull loop will clean up.
          }
        }, keepAliveMs);
        // Never hold the process open just to send comments.
        keepAlive.unref?.();
      }
    },
    async pull(controller): Promise<void> {
      try {
        const result = await iterator.next();
        if (result.done === true) {
          clearInterval(keepAlive);
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(encodeEvent(result.value)));
      } catch (error) {
        clearInterval(keepAlive);
        // Close the source before reporting the failure: an encoding error would otherwise leave
        // the generator suspended forever, and its `finally` cleanup — persistence, handler
        // teardown — would never run. When the error came from `next()` itself the generator is
        // already done and this is a no-op.
        try {
          await iterator.return?.();
        } catch {
          // The original error is the one worth reporting.
        }
        controller.error(error);
      }
    },
    async cancel(): Promise<void> {
      // The client hung up: stop the handler rather than let it run to completion unobserved.
      clearInterval(keepAlive);
      await iterator.return?.();
    },
  });
}
