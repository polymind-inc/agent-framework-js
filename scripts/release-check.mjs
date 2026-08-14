#!/usr/bin/env node
// Fails closed unless CI is running a v* tag whose version matches every publishable package.

import { assertLockstepVersions, readPackageManifests } from './workspace.mjs';

if (process.env.GITHUB_REF_TYPE !== 'tag') {
  console.error(
    `Releases must run from a tag, not '${process.env.GITHUB_REF_TYPE ?? 'an unknown ref type'}'.`,
  );
  process.exit(1);
}

const tag = process.env.GITHUB_REF_NAME;
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? '')) {
  console.error(`Release tag '${tag ?? ''}' must have the form v1.2.3 or v1.2.3-rc.1.`);
  process.exit(1);
}

let version;
try {
  version = assertLockstepVersions(readPackageManifests());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (tag.slice(1) !== version) {
  console.error(`Tag ${tag} does not match the lockstep package version ${version}.`);
  process.exit(1);
}

console.log(`Release invariant verified: ${tag}, all packages at ${version}.`);
