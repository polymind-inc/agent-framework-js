import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { INSTRUMENTATION_VERSION } from './version.js';

describe('INSTRUMENTATION_VERSION', () => {
  it('matches the package.json version', async () => {
    const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
    const { version } = JSON.parse(raw) as { version: string };
    expect(INSTRUMENTATION_VERSION).toBe(version);
  });
});
