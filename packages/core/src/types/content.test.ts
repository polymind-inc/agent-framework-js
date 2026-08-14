import { describe, expect, it } from 'vitest';
import type { Content } from './content.js';
import { isUserInputRequest } from './content.js';

describe('isUserInputRequest', () => {
  it('matches the userInputRequest marker and both request discriminators', () => {
    // The serialized marker alone is enough: a request variant this framework version does not
    // model still surfaces after a round trip through a transcript.
    expect(
      isUserInputRequest({ type: 'unknown', unknownType: 'future_request', userInputRequest: true }),
    ).toBe(true);
    expect(
      isUserInputRequest({
        type: 'function_approval_request',
        id: 'req-1',
        functionCall: { type: 'function_call', callId: 'call-1', name: 'tool', arguments: {} },
      }),
    ).toBe(true);
    expect(
      isUserInputRequest({ type: 'oauth_consent_request', consentLink: 'https://example.test/consent' }),
    ).toBe(true);
  });

  it('rejects content that does not ask for user input', () => {
    const negatives: Content[] = [
      { type: 'text', text: 'plain' },
      { type: 'unknown', unknownType: 'future_request' },
      {
        type: 'function_approval_response',
        id: 'req-1',
        approved: true,
        functionCall: { type: 'function_call', callId: 'call-1', name: 'tool', arguments: {} },
      },
    ];
    for (const content of negatives) {
      expect(isUserInputRequest(content)).toBe(false);
    }
  });
});
