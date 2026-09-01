import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/** A per-file scratch root under the OS temp directory, removed when the file's tests finish. */
export interface ScratchRoot {
  /** The root path. A name until something creates it — see {@link scratchRoot}. */
  readonly root: string;
  /** A fresh subdirectory under the root, created on demand. */
  dir(): Promise<string>;
  /** Creates the root itself and returns it, for a test that writes directly under it. */
  ensureRoot(): Promise<string>;
}

/**
 * Declares one scratch root for the calling test file and registers its removal.
 *
 * The root is only *named* here, never created up front: a fully skipped test file runs no
 * hooks at all, so a root created eagerly at module scope would be left behind on every skipped
 * run — which is exactly how these directories used to accumulate by the thousand. Everything
 * under the root is created on demand, and the registered `afterAll` removes the whole tree
 * whether the file's tests passed or failed. A removal failure — a Windows handle still open —
 * never fails a suite that already passed.
 *
 * Call at module scope of a test file; the cleanup hook binds to that file.
 */
export function scratchRoot(prefix: string): ScratchRoot {
  const root = join(tmpdir(), `${prefix}-${crypto.randomUUID()}`);
  let count = 0;
  afterAll(async () => {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      // Best-effort by design: anything left is bounded to this run's root, not unbounded growth.
    }
  });
  return {
    root,
    async dir(): Promise<string> {
      const dir = join(root, String(++count));
      await mkdir(dir, { recursive: true });
      return dir;
    },
    async ensureRoot(): Promise<string> {
      await mkdir(root, { recursive: true });
      return root;
    },
  };
}
