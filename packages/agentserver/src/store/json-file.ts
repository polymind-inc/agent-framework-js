import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Reads and parses a JSON file, treating a missing file as `undefined`.
 *
 * Every file-backed store built on this helper keeps records that legitimately do not exist
 * before the first write, and everything else — a parse failure above all — must surface rather
 * than silently become an empty state.
 */
export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  return JSON.parse(raw) as T;
}

/**
 * Writes `value` as JSON via write-then-rename, creating the parent directory.
 *
 * The rename is what makes the replacement atomic: a process killed mid-write leaves the previous
 * file intact rather than a truncated one holding half a JSON object, and a reader never sees a
 * half-written file.
 */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), 'utf8');
  await rename(temporary, path);
}
