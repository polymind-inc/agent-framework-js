import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLockstepVersions } from './workspace.mjs';

function entry(manifest, path = 'packages/example/package.json') {
  return { path, manifest };
}

test('returns the shared version for valid package manifests', () => {
  assert.equal(
    assertLockstepVersions([
      entry({ name: '@example/core', version: '1.2.3' }),
      entry({ name: '@example/provider', version: '1.2.3' }),
    ]),
    '1.2.3',
  );
});

test('rejects a package manifest whose name or version is not a non-empty string', () => {
  for (const field of ['name', 'version']) {
    for (const value of [undefined, '', '   ', 123]) {
      const manifest = { name: '@example/core', version: '1.2.3', [field]: value };

      assert.throws(
        () => assertLockstepVersions([entry(manifest, 'packages/broken/package.json')]),
        new RegExp(`packages[/\\\\]broken[/\\\\]package\\.json: package ${field} must be a non-empty string`),
      );
    }
  }
});

test('rejects a missing package manifest object clearly', () => {
  assert.throws(
    () => assertLockstepVersions([{ path: 'packages/broken/package.json' }]),
    /packages[/\\]broken[/\\]package\.json: package manifest must be an object/,
  );
});
