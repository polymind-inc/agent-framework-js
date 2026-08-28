/**
 * Resolves after `ms`, or rejects the moment `signal` aborts instead of at the timer; with no
 * signal it is a plain sleep.
 *
 * Deliberately not `node:timers/promises`: its `setTimeout` rejects an abort with its own
 * `AbortError` rather than the signal's reason, and callers here surface the reason as-is.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    // Deliberately no fast path at zero: even `sleep(0)` goes through the timer, so an abort
    // raised in the same task still lands, and a zero-interval poll loop yields the event loop
    // on every round instead of starving it. A caller whose contract says "zero means no waiting
    // at all" (the storage retry) makes that call-site decision itself.
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
