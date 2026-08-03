/**
 * A random unique id: `crypto.randomUUID` when the runtime provides it, otherwise a
 * `prefix`-tagged random string. Local so `@polymind-inc/agent-framework-core` stays runtime-agnostic.
 *
 * Not part of the public API.
 */
export function randomId(prefix: string): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return (
    cryptoObj?.randomUUID?.() ?? `${prefix}-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  );
}
