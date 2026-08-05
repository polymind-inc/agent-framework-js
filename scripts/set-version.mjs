#!/usr/bin/env node
// Sets the version of every publishable package. All packages ship in lockstep, so they always
// carry the same version; internal dependencies use the `workspace:` protocol (`workspace:^`, or
// `workspace:*` where a package pins its siblings exactly) and are rewritten to the real version
// at publish time by pnpm, so those need no edit.
//
// Three packages also carry the version as a source constant, because they report it at runtime
// (OpenTelemetry instrumentation scope, the hosting server identity, the MCP handshake) and the
// build stays a plain compile with no JSON import. Those constants are updated here too. Each is
// covered by a unit test that compares it against package.json, so a missed one fails the build
// rather than shipping a wrong version — but a release should not have to rely on that.
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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');

/** Source constants that mirror package.json's version, as [path, exported name] pairs. */
const VERSION_CONSTANTS = [
  ['packages/core/src/observability/version.ts', 'INSTRUMENTATION_VERSION'],
  ['packages/agentserver/src/config.ts', 'PACKAGE_VERSION'],
  ['packages/mcp/src/connection.ts', 'MCP_CLIENT_VERSION'],
];

for (const dir of readdirSync(packagesDir)) {
  const manifestPath = join(packagesDir, dir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const previous = manifest.version;

  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${manifest.name}: ${previous} -> ${version}`);
}

for (const [relativePath, name] of VERSION_CONSTANTS) {
  const path = join(root, relativePath);
  const source = readFileSync(path, 'utf8');
  const pattern = new RegExp(`(export const ${name} = ')[^']*(')`);

  if (!pattern.test(source)) {
    console.error(`Could not find "export const ${name}" in ${relativePath}`);
    process.exit(1);
  }

  writeFileSync(path, source.replace(pattern, `$1${version}$2`));
  console.log(`${relativePath}: ${name} -> ${version}`);
}
