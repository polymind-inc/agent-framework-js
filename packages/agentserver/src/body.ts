import { ProtocolError, requestTooLarge } from './errors.js';

/**
 * Reads and parses the request body, bounded by `limit` bytes (the server's `maxBodyBytes`).
 *
 * `request.json()` would buffer however much the caller cares to send; this reads the stream
 * chunk by chunk and stops with a 413 the moment the limit is crossed, whether or not the caller
 * declared a `content-length`.
 */
export async function readJsonBody(request: Request, limit: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw requestTooLarge(limit);
  }

  let text = '';
  if (request.body !== null) {
    const decoder = new TextDecoder();
    const reader = request.body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw requestTooLarge(limit);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProtocolError(400, 'request body must be valid JSON', {
      code: 'invalid_request',
      cause: error,
    });
  }
}
