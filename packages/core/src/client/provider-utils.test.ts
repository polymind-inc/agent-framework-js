import { describe, expect, it } from 'vitest';
import { arrayToStream, setIfDefined, topLevelMediaType, withoutUndefined } from './provider-utils.js';

describe('setIfDefined', () => {
  it('assigns a defined value', () => {
    const target: Record<string, unknown> = {};
    setIfDefined(target, 'temperature', 0.5);
    expect(target).toEqual({ temperature: 0.5 });
  });

  it('does not create the key for undefined', () => {
    const target: Record<string, unknown> = {};
    setIfDefined(target, 'temperature', undefined);
    expect('temperature' in target).toBe(false);
  });

  it('keeps falsy values other than undefined', () => {
    const target: Record<string, unknown> = {};
    setIfDefined(target, 'store', false);
    setIfDefined(target, 'top_k', 0);
    setIfDefined(target, 'user', '');
    setIfDefined(target, 'metadata', null);
    expect(target).toEqual({ store: false, top_k: 0, user: '', metadata: null });
  });
});

describe('withoutUndefined', () => {
  it('drops entries whose value is undefined', () => {
    expect(withoutUndefined({ type: 'web_search', user_location: undefined })).toEqual({
      type: 'web_search',
    });
  });

  it('keeps falsy values other than undefined', () => {
    expect(withoutUndefined({ a: false, b: 0, c: '', d: null })).toEqual({ a: false, b: 0, c: '', d: null });
  });

  it('returns a copy and leaves the input untouched', () => {
    const spec = { type: 'code_interpreter', container: undefined };
    const result = withoutUndefined(spec);
    expect(result).not.toBe(spec);
    expect('container' in spec).toBe(true);
  });
});

describe('topLevelMediaType', () => {
  it('returns the lowercased part before the slash', () => {
    expect(topLevelMediaType('image/png')).toBe('image');
    expect(topLevelMediaType('Image/PNG')).toBe('image');
    expect(topLevelMediaType('audio/mpeg')).toBe('audio');
  });

  it('returns an empty string for undefined or empty input', () => {
    expect(topLevelMediaType(undefined)).toBe('');
    expect(topLevelMediaType('')).toBe('');
  });

  it('returns the whole value when there is no subtype', () => {
    expect(topLevelMediaType('image')).toBe('image');
  });
});

describe('arrayToStream', () => {
  it('yields the items in order', async () => {
    const collected: number[] = [];
    for await (const item of arrayToStream([1, 2, 3])) {
      collected.push(item);
    }
    expect(collected).toEqual([1, 2, 3]);
  });

  it('completes without yielding for an empty array', async () => {
    const collected: unknown[] = [];
    for await (const item of arrayToStream([])) {
      collected.push(item);
    }
    expect(collected).toEqual([]);
  });
});
