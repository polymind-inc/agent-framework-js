import { isAbsolute, sep } from 'node:path';

/**
 * Whether `path` is `directory` itself or something under it.
 *
 * Purely lexical, so both sides must already be resolved absolute paths; a relative `path` is
 * refused outright rather than guessed at.
 */
export function isWithin(directory: string, path: string): boolean {
  if (!isAbsolute(path)) {
    return false;
  }
  const root = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return path === directory || path.startsWith(root);
}
