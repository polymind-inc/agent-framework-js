import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const packagesDirectory = join(workspaceRoot, 'packages');

/** Reads every publishable workspace package together with its manifest path. */
export function readPackageManifests() {
  return readdirSync(packagesDirectory).map((dir) => {
    const path = join(packagesDirectory, dir, 'package.json');
    return { path, manifest: JSON.parse(readFileSync(path, 'utf8')) };
  });
}
