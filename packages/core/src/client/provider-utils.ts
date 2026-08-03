/**
 * Utilities for implementing a `ChatClient` against a provider SDK: building request payloads
 * without `undefined` noise, dispatching on media types, and adapting buffered results to the
 * streaming interface.
 */

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
