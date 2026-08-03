#!/usr/bin/env node
// Sets the version of every publishable package. All packages ship in lockstep, so they always
// carry the same version; internal dependencies use `workspace:^` and are rewritten at publish
// time by pnpm, so nothing else needs to change.
//
// Usage: node scripts/set-version.mjs 0.2.0

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('Usage: node scripts/set-version.mjs <version>   (e.g. 0.2.0, 0.2.0-rc.1)');
  process.exit(1);
}

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages');

for (const dir of readdirSync(packagesDir)) {
  const manifestPath = join(packagesDir, dir, 'package.json');
  const source = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(source);
  const previous = manifest.version;

  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${manifest.name}: ${previous} -> ${version}`);
}
