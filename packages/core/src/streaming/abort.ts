/**
 * Cancellation classification, shared by every layer that has to tell "the caller hung up" apart
 * from "the call failed".
 *
 * The distinction is load-bearing: a hosted turn that was cancelled must end as `incomplete` and
 * stay resumable, while a turn that *failed* invites a retry against a container that may already
 * be draining.
 *
 * Deliberately free of any provider SDK — `@polymind-inc/agent-framework-core` depends on `@opentelemetry/api`
 * and nothing else. Provider packages layer their own SDK-specific `instanceof`
 * checks (`OpenAI.APIUserAbortError`, `Anthropic.APIUserAbortError`) on top of these helpers,
 * because neither SDK sets `name` on its abort error and neither is visible from here.
 */

/** The name the web platform gives a cancellation (`AbortController.abort()` → `DOMException`). */
const ABORT_ERROR_NAME = 'AbortError';

/** What the platform's own `DOMException` carries, so a synthesized one is indistinguishable. */
const ABORT_ERROR_MESSAGE = 'This operation was aborted';

/**
 * Whether a thrown value is a cancellation rather than a failure.
 *
 * Two signals, because a cancellation reaches this code in two shapes:
 *
 * - the standard one — anything named `AbortError`, which covers the `DOMException` that
 *   `AbortSignal.throwIfAborted()` throws as well as hand-rolled equivalents;
 * - the caller's own abort reason — `controller.abort(reason)` puts an arbitrary value on the
 *   signal, and that value propagates untouched, so identity against `signal.reason` is the only
 *   way to recognize it.
 *
 * `signal.aborted` on its own is deliberately *not* enough: a genuine provider failure that
 * happens to race a cancellation must still be reportable as a failure by callers that want it.
 */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === ABORT_ERROR_NAME
  ) {
    return true;
  }
  return signal?.aborted === true && error === (signal.reason as unknown);
}

/**
 * The value to throw for a cancellation on `signal`.
 *
 * Returns the signal's own reason whenever there is one, so the same value comes out no matter
 * which timing the abort landed on — between pulls (`throwIfAborted`), during an in-flight
 * provider call, or at the end of a stream the provider ended silently. A caller that aborted with
 * its own reason gets that reason back in every case.
 *
 * With no aborted signal to draw from — a provider SDK that cancelled itself, or a call made
 * without a signal — a standards-shaped `AbortError` is synthesized, with `cause` pointing at
 * whatever the SDK threw so the original is still reachable for diagnostics.
 */
export function abortErrorFrom(signal?: AbortSignal, cause?: unknown): unknown {
  if (signal?.aborted === true) {
    return signal.reason as unknown;
  }
  const error: Error =
    typeof DOMException === 'function'
      ? (new DOMException(ABORT_ERROR_MESSAGE, ABORT_ERROR_NAME) as unknown as Error)
      : Object.assign(new Error(ABORT_ERROR_MESSAGE), { name: ABORT_ERROR_NAME });
  if (cause !== undefined) {
    // `DOMException` has no `cause` constructor option, so it is attached after the fact.
    Object.defineProperty(error, 'cause', { value: cause, configurable: true, writable: true });
  }
  return error;
}
