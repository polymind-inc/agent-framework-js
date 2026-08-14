import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from './base64.js';

describe('base64', () => {
  it.each([
    [[], ''],
    [[0], 'AA=='],
    [[0, 1], 'AAE='],
    [[0, 1, 2], 'AAEC'],
    [[255, 254, 253, 252], '//79/A=='],
  ] as const)('round-trips %j', (input, encoded) => {
    const bytes = Uint8Array.from(input);
    expect(encodeBase64(bytes)).toBe(encoded);
    expect(decodeBase64(encoded)).toEqual(bytes);
  });

  it('ignores characters outside the standard alphabet', () => {
    expect(decodeBase64(' YW\nJj==!')).toEqual(Uint8Array.from([97, 98, 99]));
  });

  it('round-trips a large byte array without per-byte boxed storage', () => {
    const bytes = Uint8Array.from({ length: 256 * 1024 }, (_, index) => index & 0xff);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });
});
