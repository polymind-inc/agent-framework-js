import { isAbsolute, resolve, sep } from 'node:path';

/**
 * Rejects a value that is not a single safe path component (CWE-22).
 *
 * Untrusted values — a user id from a header, a conversation id from a request body — become
 * directory and file names. They are **rejected, never sanitized**: stripping the dangerous
 * characters out of `../../etc/passwd` and `etcpasswd` would map two different callers onto the
 * same file, turning a traversal bug into a cross-user data leak.
 *
 * @throws {Error} When `segment` is empty, contains a separator or NUL, is `.`/`..`, or is
 * absolute or drive-qualified.
 */
export function validatePathSegment(segment: string, kind: string): void {
  if (typeof segment !== 'string' || segment === '') {
    throw new Error(`Invalid ${kind}: must be a non-empty string.`);
  }
  if (
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0') ||
    // `.`, `..`, `...` — anything that is only dots is a relative reference, not a name.
    segment.replaceAll('.', '') === '' ||
    isAbsolute(segment) ||
    /^[a-zA-Z]:/.test(segment)
  ) {
    throw new Error(`Invalid ${kind}: ${JSON.stringify(segment)}`);
  }
}

/**
 * Joins validated segments under `root` and re-checks the result.
 *
 * The second check is not redundant: `validatePathSegment` reasons about the input, this reasons
 * about where the filesystem actually ended up — which is the property that matters, and the only
 * one that survives symlinks in the segment names or a platform-specific quirk in `resolve`.
 *
 * @throws {Error} When any segment is unsafe, or the joined path escapes `root`.
 */
export function resolveUnder(root: string, segments: readonly string[], kind = 'path segment'): string {
  for (const segment of segments) {
    validatePathSegment(segment, kind);
  }
  const rootPath = resolve(root);
  const target = resolve(rootPath, ...segments);
  if (target !== rootPath && !target.startsWith(rootPath.endsWith(sep) ? rootPath : rootPath + sep)) {
    throw new Error(`Resolved path escapes the storage root: ${JSON.stringify(target)}`);
  }
  return target;
}
