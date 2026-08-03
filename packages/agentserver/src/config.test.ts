import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PACKAGE_VERSION, serverIdentity } from './config.js';

describe('server identity', () => {
  it('reports the real package version', async () => {
    // The constant exists so the build stays a plain compile; this is the check that keeps it
    // honest whenever package.json's version moves.
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(PACKAGE_VERSION).toBe(manifest.version);
  });

  it('carries the package version, the protocol version and the runtime', () => {
    expect(serverIdentity()).toBe(
      `agent-framework-js/${PACKAGE_VERSION} protocol/responses-2.0.0 node/${process.versions.node}`,
    );
  });
});
