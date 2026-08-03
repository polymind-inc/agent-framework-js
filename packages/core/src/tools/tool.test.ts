import { describe, expect, it } from 'vitest';
import { AgentFrameworkError } from '../errors.js';
import type { Content } from '../types/content.js';
import { textContent } from '../types/content.js';
import { normalizeToolResult } from './tool.js';

describe('normalizeToolResult', () => {
  it('keeps a string as-is', () => {
    expect(normalizeToolResult('Tokyo is sunny')).toBe('Tokyo is sunny');
    expect(normalizeToolResult('')).toBe('');
  });

  it('reports the success placeholder for undefined and null', () => {
    expect(normalizeToolResult(undefined)).toBe('Success: Function completed.');
    expect(normalizeToolResult(null)).toBe('Success: Function completed.');
  });

  it('keeps a Content[] so rich results survive', () => {
    const contents: Content[] = [textContent('hi')];
    expect(normalizeToolResult(contents)).toBe(contents);
  });

  it('JSON-encodes an ordinary object', () => {
    expect(normalizeToolResult({ temp: 21, unit: 'C' })).toBe('{"temp":21,"unit":"C"}');
    expect(normalizeToolResult([1, 2, 3])).toBe('[1,2,3]');
    expect(normalizeToolResult(42)).toBe('42');
    expect(normalizeToolResult(false)).toBe('false');
  });

  it('refuses a value JSON cannot represent instead of returning undefined', () => {
    // `JSON.stringify` returns `undefined` for these, and the old implementation returned that
    // straight out of a function declared to produce `string | Content[]`.
    expect(() => normalizeToolResult(Symbol('secret'))).toThrow(AgentFrameworkError);
    expect(() => normalizeToolResult(() => 'nope')).toThrow(AgentFrameworkError);
  });

  it('refuses a value JSON cannot encode instead of throwing an unrelated TypeError', () => {
    expect(() => normalizeToolResult(1n)).toThrow(AgentFrameworkError);
    expect(() => normalizeToolResult({ big: 1n })).toThrow(AgentFrameworkError);

    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(() => normalizeToolResult(circular)).toThrow(AgentFrameworkError);
  });
});
