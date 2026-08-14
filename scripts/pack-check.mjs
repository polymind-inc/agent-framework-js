#!/usr/bin/env node
// Verifies that every publishable package would produce a usable tarball, without writing one.
//
// `pnpm pack` on its own only fails when a dependency range cannot be resolved. It is perfectly
// happy to produce a tarball with no `dist` at all — a package that installs and then fails on
// import. This checks the packed file list against what each manifest promises:
//
//   - every file an `exports` entry points at is actually packed
//   - LICENSE and README.md are packed
//
// Usage: node scripts/pack-check.mjs

import { execSync } from 'node:child_process';
import { assertLockstepVersions, readPackageManifests, workspaceRoot } from './workspace.mjs';

const stdout = execSync('pnpm -r --filter "./packages/*" pack --dry-run --json', {
  cwd: workspaceRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
  maxBuffer: 64 * 1024 * 1024,
});

// pnpm may print progress before the payload; the report itself starts at the first bracket.
const packed = JSON.parse(stdout.slice(stdout.indexOf('[')));

// Map package name -> manifest, so a packed result can be checked against what it promised.
const manifests = new Map();
const packageManifests = readPackageManifests();
const releaseVersion = assertLockstepVersions(packageManifests);
for (const { manifest } of packageManifests) {
  manifests.set(manifest.name, manifest);
}

/** Collects every file path an `exports` map points at, at any nesting depth. */
function exportTargets(node, found = new Set()) {
  if (typeof node === 'string') {
    found.add(node.replace(/^\.\//, ''));
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) exportTargets(value, found);
  }
  return found;
}

const problems = [];

for (const result of packed) {
  const manifest = manifests.get(result.name);

  if (!manifest) {
    problems.push(`${result.name}: packed but has no manifest under packages/`);
    continue;
  }

  const files = new Set(result.files.map((file) => file.path.replaceAll('\\', '/')));

  if (result.version !== manifest.version || result.version !== releaseVersion) {
    problems.push(
      `${result.name}: packed version ${result.version} does not match manifest/release version ${manifest.version}`,
    );
  }

  for (const target of exportTargets(manifest.exports)) {
    if (!files.has(target)) {
      problems.push(`${result.name}: exports points at "${target}", which is not packed`);
    }
  }

  for (const required of ['LICENSE', 'README.md']) {
    if (!files.has(required)) problems.push(`${result.name}: ${required} is not packed`);
  }

  console.log(`ok ${result.name}@${result.version} (${files.size} files)`);
}

if (manifests.size !== packed.length) {
  problems.push(`packed ${packed.length} packages but packages/ holds ${manifests.size}`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`\nAll ${packed.length} packages pack cleanly.`);
