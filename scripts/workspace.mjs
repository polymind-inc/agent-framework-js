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

/** Returns the one release version shared by every package, or throws when lockstep is broken. */
export function assertLockstepVersions(packages = readPackageManifests()) {
  if (packages.length === 0) {
    throw new Error('No publishable packages were found under packages/.');
  }
  const versions = new Map();
  for (const [index, entry] of packages.entries()) {
    const source =
      typeof entry?.path === 'string' && entry.path !== ''
        ? entry.path
        : `Package manifest at index ${index}`;
    const manifest = entry?.manifest;
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      throw new Error(`${source}: package manifest must be an object.`);
    }
    for (const field of ['name', 'version']) {
      const value = manifest[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${source}: package ${field} must be a non-empty string.`);
      }
    }
    const names = versions.get(manifest.version) ?? [];
    names.push(manifest.name);
    versions.set(manifest.version, names);
  }
  if (versions.size !== 1) {
    const details = [...versions.entries()]
      .map(([version, names]) => `${version}: ${names.join(', ')}`)
      .join('; ');
    throw new Error(`Publishable package versions are not in lockstep (${details}).`);
  }
  return versions.keys().next().value;
}
