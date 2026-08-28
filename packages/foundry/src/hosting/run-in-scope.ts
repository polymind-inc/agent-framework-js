import type { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Drives `source` with `value` installed in `storage`, as an async generator.
 *
 * Each `next()` is invoked *inside* `AsyncLocalStorage.run`, which is where the agent runs the
 * round — the model call, the tools, the context providers — so a read from any of them lands on
 * this turn's value and nowhere else, including while another turn is interleaved on the same
 * container. Wrapping the whole `for await` instead would leave the store's propagation into the
 * generator's resumption up to where the loop happened to be suspended.
 *
 * The teardown runs inside the scope too: `break` in the consumer has to reach the agent's own
 * cleanup (session save, tool teardown, afterRun hooks) exactly as it would without this wrapper —
 * and that cleanup runs *inside* the scope, because an early end is still part of the turn it
 * ends.
 */
export async function* runInScope<T, V>(
  storage: AsyncLocalStorage<V>,
  value: V,
  source: AsyncIterable<T>,
): AsyncGenerator<T, void, undefined> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await storage.run(value, () => iterator.next());
      if (next.done === true) {
        return;
      }
      yield next.value;
    }
  } finally {
    await storage.run(value, () => iterator.return?.());
  }
}
