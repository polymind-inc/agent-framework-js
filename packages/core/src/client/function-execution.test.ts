import { describe, expect, it } from 'vitest';
import type { FunctionCallContent } from '../types/content.js';
import { rejectedResultContent } from './function-execution.js';

describe('rejectedResultContent', () => {
  const call: FunctionCallContent = {
    type: 'function_call',
    callId: 'c1',
    name: 'delete_all',
    arguments: {},
    additionalProperties: { serverLabel: 'github' },
  };

  it.each([
    [undefined, 'Error: Tool call invocation was rejected by user.'],
    ['too risky', 'Error: Tool call invocation was rejected by user. too risky'],
  ])('preserves the rejection wording for reason %s', (reason, expected) => {
    expect(rejectedResultContent(call, reason)).toEqual({
      type: 'function_result',
      callId: 'c1',
      result: expected,
      additionalProperties: { serverLabel: 'github' },
    });
  });
});
