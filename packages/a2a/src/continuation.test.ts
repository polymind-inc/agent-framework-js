import { ConfigurationError } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import { a2aContinuationToken, parseA2AContinuationToken } from './continuation.js';

describe('the A2A continuation token', () => {
  it('is a single task id on the wire', () => {
    const token = a2aContinuationToken('task-1');

    expect(JSON.parse(JSON.stringify(token))).toEqual({ taskId: 'task-1' });
  });

  it('round-trips through JSON', () => {
    const restored: unknown = JSON.parse(JSON.stringify(a2aContinuationToken('task-1')));

    expect(parseA2AContinuationToken(restored as Record<string, unknown>)).toEqual({ taskId: 'task-1' });
  });

  it.each([
    ['a token from another provider', { responseId: 'resp_1' }],
    ['a token with no task id', {}],
    ['a task id that is not a string', { taskId: 7 }],
    ['an empty task id', { taskId: '' }],
  ])('refuses %s', (_label, value) => {
    expect(() => parseA2AContinuationToken(value as Record<string, unknown>)).toThrow(ConfigurationError);
  });

  it('refuses a token carrying properties it does not define', () => {
    // A token is opaque: an extra field means it came from somewhere else, and resuming against a
    // task id lifted out of it would run the wrong operation.
    expect(() => parseA2AContinuationToken({ taskId: 'task-1', contextId: 'ctx-1' })).toThrow(
      /unrecognized property 'contextId'/,
    );
  });
});
