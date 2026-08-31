import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Pins `AGENTSERVER_STATE_ROOT` to a throwaway directory for the duration of one test file.
 *
 * The agent server's default response store is file-backed under that root, so a suite that
 * builds a server without naming a store writes transcripts to disk. Unpinned, those writes land
 * in the developer's `~/.agentserver` — thousands of stray files across runs, and a test that
 * reads "everything stored" seeing another run's leftovers. Every package gets this setup file
 * (see `definePackageTests`), not just the ones that host a server today: the point is that
 * forgetting to pass a store can never reach a real home directory.
 *
 * The directory is named but deliberately *not* created: a file whose tests are all skipped runs
 * no `afterAll`, so an eagerly created one would survive the run. Named-only, nothing exists
 * unless a store actually writes, and the store creates the path it needs.
 *
 * This runs *after* a package's own setup files, so an environment-clearing step cannot undo it.
 * A test that wants its own root stubs the variable itself; `unstubEnvs` puts this one back.
 */
const root = join(tmpdir(), `afjs-state-root-${crypto.randomUUID()}`);
process.env.AGENTSERVER_STATE_ROOT = root;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
