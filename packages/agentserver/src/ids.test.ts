import { describe, expect, it } from 'vitest';
import { ID_PREFIX, invalidIdReason, isValidId, newId, newResponseId, partitionKeyOf } from './ids.js';
import { resolveUnder, validatePathSegment } from './paths.js';

const PARTITION = 'a1b2c3d4e5f6a7b800';
const ENTROPY = 'A'.repeat(32);

describe('id generation', () => {
  it('mints the documented shape', () => {
    const id = newResponseId();
    expect(id).toMatch(/^caresp_[0-9a-f]{16}00[A-Za-z0-9]{32}$/);
    expect(id.slice('caresp_'.length)).toHaveLength(50);
  });

  it('inherits the partition key so a conversation stays co-located', () => {
    const first = newResponseId();
    const second = newId(ID_PREFIX.message, first);

    expect(partitionKeyOf(second)).toBe(partitionKeyOf(first));
    expect(second).not.toBe(first);
  });

  it('generates a fresh partition key when there is nothing to inherit', () => {
    expect(partitionKeyOf(newResponseId())).not.toBe(partitionKeyOf(newResponseId()));
    expect(partitionKeyOf(newResponseId('not-an-id'))).toHaveLength(18);
  });

  it('reads the partition key from both id formats', () => {
    expect(partitionKeyOf(`caresp_${PARTITION}${ENTROPY}`)).toBe(PARTITION);
    // Legacy ids carry a 16-character key at the *end* of a 48-character body.
    const legacyBody = `${'z'.repeat(32)}a1b2c3d4e5f6a7b8`;
    expect(partitionKeyOf(`caresp_${legacyBody}`)).toBe('a1b2c3d4e5f6a7b800');
  });

  it('accepts both body lengths and rejects everything else', () => {
    expect(isValidId(`caresp_${PARTITION}${ENTROPY}`)).toBe(true);
    expect(isValidId(`caresp_${'z'.repeat(48)}`)).toBe(true);
    expect(invalidIdReason(undefined)).toMatch(/must not be null or empty/);
    expect(invalidIdReason('caresp')).toMatch(/no '_' delimiter/);
    expect(invalidIdReason(`_${PARTITION}${ENTROPY}`)).toMatch(/empty prefix/);
    expect(invalidIdReason('caresp_short')).toMatch(/unexpected body length/);
  });

  it('enforces the allowed prefix set', () => {
    const id = `msg_${PARTITION}${ENTROPY}`;
    expect(isValidId(id, [ID_PREFIX.response])).toBe(false);
    expect(invalidIdReason(id, [ID_PREFIX.response])).toMatch(/not in the allowed set/);
    expect(isValidId(id, [ID_PREFIX.message])).toBe(true);
  });
});

describe('path segment validation', () => {
  it('accepts an ordinary segment', () => {
    expect(() => validatePathSegment('user-123', 'user id')).not.toThrow();
    expect(() => validatePathSegment(`caresp_${PARTITION}${ENTROPY}`, 'response id')).not.toThrow();
  });

  it('rejects traversal rather than sanitizing it', () => {
    // Rejecting matters: stripping the separators out of these would map several distinct
    // callers onto one directory.
    for (const attack of [
      '..',
      '.',
      '...',
      '../etc/passwd',
      'a/b',
      'a\\b',
      'a\0b',
      '/absolute',
      'C:\\Windows',
      '',
    ]) {
      expect(() => validatePathSegment(attack, 'user id'), attack).toThrow();
    }
  });

  it('verifies where the path actually landed, not just what went in', () => {
    expect(resolveUnder('/root', ['user', 'file.json'])).toMatch(/root/);
    expect(() => resolveUnder('/root', ['../escape'])).toThrow();
  });
});
