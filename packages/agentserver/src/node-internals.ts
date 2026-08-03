import type { ServerResponse } from 'node:http';

/**
 * Writes a Web `Response` to a Node response, streaming the body as it arrives.
 *
 * Internal to `serve` (`node.ts`); lives outside the `./node` entry so it never appears in the
 * package's public surface, while staying importable from tests.
 *
 * **Backpressure**: a chunk the socket refuses (`res.write` returning `false`) pauses reading
 * until `'drain'`. Without that, a slow SSE consumer — a client that opens the stream and stops
 * reading — makes this process buffer everything the handler produces, without bound.
 *
 * **Disconnect**: once the client is gone, chunks are discarded but the body keeps being *read*.
 * Winding the producer down is the abort signal's job (see `serve`); draining the stream is
 * what lets a well-behaved handler observe that signal, emit its terminal event and reach the
 * persistence step, instead of being left suspended mid-yield.
 */
export async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);

  if (response.body === null) {
    res.end();
    return;
  }

  let gone = res.destroyed || res.writableEnded;
  res.once('close', () => {
    gone = true;
  });
  // A write racing a disconnect can surface as an 'error' event; with no listener, that event
  // would crash the process.
  res.on('error', () => {
    gone = true;
  });

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (gone || res.destroyed) continue;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          const settle = (): void => {
            res.off('drain', settle);
            res.off('close', settle);
            res.off('error', settle);
            resolve();
          };
          res.once('drain', settle);
          res.once('close', settle);
          res.once('error', settle);
        });
      }
      // SSE is useless if Node buffers it; flush each event as it is produced.
      (res as ServerResponse & { flush?: () => void }).flush?.();
    }
  } finally {
    res.end();
  }
}
