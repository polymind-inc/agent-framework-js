/**
 * Utilities for implementing a `ChatClient` against a provider SDK: building request payloads
 * without `undefined` noise, dispatching on media types, and adapting buffered results to the
 * streaming interface.
 */

import { ConfigurationError } from '../errors.js';
import type { ChatResponseUpdate } from '../types/response.js';
import { chatResponseToUpdates } from '../types/response.js';
import type { ChatResponseStream } from './chat-client.js';

/**
 * Assigns `value` to `target[key]` unless the value is `undefined`.
 *
 * Keeps optional fields out of a request payload entirely instead of sending them as explicit
 * `undefined` / `null`, which some provider SDKs reject.
 */
export function setIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

/**
 * Returns a shallow copy of `spec` without the entries whose value is `undefined`.
 *
 * The object-literal counterpart of {@link setIfDefined}: build the payload as one literal, then
 * strip the fields that were not provided.
 */
export function withoutUndefined(spec: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(spec).filter(([, value]) => value !== undefined));
}

/**
 * JSON-encodes `value`, degrading to `String(value)` and then `'[unserializable]'`.
 *
 * `JSON.stringify` throws on a cycle or a `BigInt`, and answers `undefined` for a symbol or a
 * function. A wire mapper renders a transcript that already exists, so failing the whole request
 * over one unencodable value is not an option — and the value's string form still says
 * *something* about what it was, mirroring Python's `json.dumps` falling back to `str()`.
 */
export function safeStringify(value: unknown): string {
  const fallback = (): string => {
    try {
      return String(value);
    } catch {
      return '[unserializable]';
    }
  };
  try {
    return JSON.stringify(value) ?? fallback();
  } catch {
    return fallback();
  }
}

/**
 * Validates and normalizes a hosted MCP tool's server label.
 *
 * A blank label is a configuration mistake and is refused. Spaces become underscores: the
 * provider APIs reject labels containing spaces, and Python's `get_mcp_tool` applies the same
 * substitution. Only spaces are replaced — matching the reference implementation exactly rather
 * than sanitising every character an API might dislike.
 */
export function normalizeServerLabel(serverLabel: string): string {
  if (serverLabel.trim() === '') {
    throw new ConfigurationError('mcpTool requires a non-empty serverLabel.');
  }
  return serverLabel.replaceAll(' ', '_');
}

/**
 * Returns the lowercased top-level type of an IANA media type (`'image/PNG'` → `'image'`), or an
 * empty string when `mediaType` is `undefined`.
 *
 * Useful for routing a data or URI content to the provider block that handles its kind of
 * payload.
 */
export function topLevelMediaType(mediaType: string | undefined): string {
  return (mediaType ?? '').split('/')[0]?.toLowerCase() ?? '';
}

/**
 * Yields the items of an array as an async stream.
 *
 * Lets a client that already holds a complete response — from a non-streaming SDK call, for
 * example — satisfy the streaming half of the `ChatClient` contract, typically after exploding
 * the response with `chatResponseToUpdates`.
 */
export async function* arrayToStream<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

/**
 * The updates of an inner {@link ChatResponseStream}, consumed the way the outer caller consumes
 * the wrapping layer.
 *
 * This is the relay every chat-client layer needs: iterating the inner stream propagates the
 * streaming transport choice inward, while a caller that awaited must make the inner call await
 * too — iterating it instead would silently switch the provider to a streaming transport. The
 * awaited response is exploded back into updates so the layer's own per-update handling runs
 * identically in both modes, which is what keeps a streamed run and an awaited run producing the
 * same transcript through any stack of layers.
 *
 * Consumes `inner` either way, so the caller must not also await or iterate it — read the folded
 * result from `inner.finalResponse()` afterwards instead.
 */
export async function* updatesOf(
  inner: ChatResponseStream<unknown>,
  streaming: boolean,
): AsyncGenerator<ChatResponseUpdate> {
  if (streaming) {
    yield* inner;
  } else {
    yield* chatResponseToUpdates(await inner);
  }
}
