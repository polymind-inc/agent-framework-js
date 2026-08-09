/**
 * Error normalization for `ChatClient` implementations built on a provider SDK.
 *
 * Every client backed by an SDK faces the same two obligations: a cancellation must come out as
 * the standards-shaped abort value the rest of the stack matches on — never laundered into a
 * provider failure — and everything else must be wrapped in the client's own error type. These
 * helpers capture that contract once, for both the request phase and the streaming phase.
 */

import { errorMessageOf } from '../errors.js';
import { abortErrorFrom, isAbortError } from '../streaming/abort.js';

/**
 * Normalizes a value thrown by a provider SDK into the value the client should throw.
 *
 * Returns rather than throws, so the caller stays in charge of the `throw` site:
 * `throw normalizeError(error, signal)`.
 */
export type ClientErrorNormalizer = (error: unknown, signal?: AbortSignal) => unknown;

/** Configuration for {@link createClientErrorNormalizer}. */
export interface ClientErrorNormalizerOptions {
  /**
   * The SDK's own user-abort error class, recognized by `instanceof`.
   *
   * SDKs typically throw their own class when the caller's `AbortSignal` fires mid-call, and that
   * class is often *not* named `AbortError` — so recognizing it by type is the only reliable way
   * to keep a cancellation from being reported as a provider failure.
   *
   * Omit it for an SDK that lets the platform's own cancellation through: a `fetch` abort is a
   * `DOMException` named `AbortError`, which the first classification step already recognizes.
   */
  abortErrorClass?: abstract new (
    ...args: never[]
  ) => object;
  /**
   * Wraps a genuine failure in the client's error type.
   *
   * `detail` is a ready-made human-readable summary: `error.message` when the thrown value is an
   * `Error`, `String(error)` otherwise. Branch here for provider-specific error classes that
   * deserve a more precise type than the client's general one.
   */
  wrap: (error: unknown, detail: string) => Error;
}

/**
 * Builds a {@link ClientErrorNormalizer} with the standard classification order:
 *
 * 1. a value that already is a cancellation (`isAbortError`) passes through untouched;
 * 2. an instance of the SDK's abort error class becomes the standards-shaped abort value
 *    (`abortErrorFrom`), preferring the caller's own abort reason;
 * 3. anything else goes through `wrap`.
 */
export function createClientErrorNormalizer(options: ClientErrorNormalizerOptions): ClientErrorNormalizer {
  const { abortErrorClass, wrap } = options;
  return (error: unknown, signal?: AbortSignal): unknown => {
    if (isAbortError(error, signal)) {
      return error;
    }
    if (abortErrorClass !== undefined && error instanceof abortErrorClass) {
      return abortErrorFrom(signal, error);
    }
    return wrap(error, errorMessageOf(error));
  };
}

/**
 * Adapts a provider SDK's event stream to a stream of updates, with uniform error handling.
 *
 * A stream can fail long after the request succeeded (network drop, server abort), so the error
 * contract has to be the same in both phases: any exception raised while iterating `events` *or*
 * while parsing an event goes through `normalizeError`, exactly as a request-phase failure would.
 *
 * Events for which `parse` returns `undefined` are skipped. Parsers that carry state across
 * events should close over it in the `parse` callback.
 */
export async function* guardClientStream<TEvent, TUpdate>(
  events: AsyncIterable<TEvent>,
  parse: (event: TEvent) => TUpdate | undefined,
  normalizeError: ClientErrorNormalizer,
  signal?: AbortSignal,
): AsyncGenerator<TUpdate> {
  try {
    for await (const event of events) {
      const update = parse(event);
      if (update !== undefined) {
        yield update;
      }
    }
  } catch (error) {
    throw normalizeError(error, signal);
  }
}
