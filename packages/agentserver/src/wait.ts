/**
 * Waits for `promise` to settle, but no longer than `ms` milliseconds.
 *
 * The timer never holds the process open (`unref`), and losing the race abandons the wait, not
 * the work — the promise keeps running. A rejection that wins the race propagates; a caller that
 * must not throw wraps the promise itself.
 */
export async function raceTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
