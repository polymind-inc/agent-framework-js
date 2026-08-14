#!/usr/bin/env node
// Publishes workspace packages sequentially in dependency order. npm versions are immutable, so
// true transactionality is impossible; a registry preflight plus idempotent skips makes a retry
// the safe recovery path if a later package fails after earlier ones were published.

import { spawnSync } from 'node:child_process';
import { assertLockstepVersions, readPackageManifests, workspaceRoot } from './workspace.mjs';

const tagIndex = process.argv.indexOf('--tag');
const distTag = tagIndex < 0 ? undefined : process.argv[tagIndex + 1];
if (distTag === undefined || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(distTag)) {
  console.error('Usage: node scripts/publish-packages.mjs --tag <dist-tag>');
  process.exit(1);
}

const packages = readPackageManifests();
const version = assertLockstepVersions(packages);
const byName = new Map(packages.map((entry) => [entry.manifest.name, entry]));

/** Places internal dependencies before packages that depend on them. */
function publishOrder() {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (entry) => {
    const name = entry.manifest.name;
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Workspace package dependency cycle includes ${name}.`);
    visiting.add(name);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(entry.manifest[field] ?? {})) {
        const internal = byName.get(dependency);
        if (internal !== undefined) visit(internal);
      }
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(entry);
  };
  for (const entry of packages) visit(entry);
  return ordered;
}

const registry = new URL(
  process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org/',
);

async function isPublished(name) {
  const url = new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, registry);
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`Registry preflight failed for ${name}@${version}: HTTP ${response.status}.`);
  }
  const metadata = await response.json();
  return metadata.version === version;
}

const ordered = publishOrder();
const status = new Map();
// Complete the read-only registry preflight before publishing anything.
for (const { manifest } of ordered) {
  status.set(manifest.name, await isPublished(manifest.name));
}

const pending = ordered.filter(({ manifest }) => status.get(manifest.name) !== true);
console.log(
  `Release ${version}: ${pending.length} package(s) pending, ${ordered.length - pending.length} already published.`,
);

for (const { manifest } of ordered) {
  if (status.get(manifest.name) === true) {
    console.log(`skip ${manifest.name}@${version} (already published)`);
    continue;
  }
  console.log(`publish ${manifest.name}@${version} with dist-tag ${distTag}`);
  // Runs through the shell as a single command string: on Windows pnpm is a .cmd shim, which
  // Node refuses to spawn directly (CVE-2024-27980 hardening). Interpolation is safe — the
  // dist-tag is validated above and package names come from workspace manifests.
  const result = spawnSync(
    `pnpm --filter ${manifest.name} publish --access public --provenance --no-git-checks --tag ${distTag}`,
    { cwd: workspaceRoot, stdio: 'inherit', shell: true },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    console.error(
      `Publishing stopped at ${manifest.name}@${version}. Retry the workflow; already published versions will be skipped.`,
    );
    process.exit(result.status ?? 1);
  }
}

console.log(`Published all packages for ${version}.`);
