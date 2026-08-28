/**
 * One string key for a pair of strings, collision-free across pairs.
 *
 * Both halves are typically untrusted (a header, a request body, gateway-authored text), so
 * joining them with *any* delimiter character lets a crafted value impersonate another pair —
 * a space join collapses `("alice", "smith x")` with `("alice smith", "x")`, and the previous
 * NUL join failed the same way while also making the file unsearchable (ripgrep reads NUL as
 * binary). `JSON.stringify` escapes every character, so the pair is recoverable and the
 * composition is structurally injective.
 */
export function compositeKey(first: string, second: string): string {
  return JSON.stringify([first, second]);
}
