import { describe, expect, it } from 'vitest';
import { createConsentChannel, reportConsent, withConsentChannel } from './consent-channel.js';

describe('withConsentChannel', () => {
  it('keeps the channel installed while the stream is torn down early', async () => {
    const channel = createConsentChannel();
    const consent = { serverLabel: 'crm', consentLink: 'https://consent.example/crm' };
    async function* source(): AsyncGenerator<number> {
      try {
        yield 1;
        yield 2;
      } finally {
        // Where a tool tears down when the consumer stops early — a consent break, a disconnect,
        // a shutdown all arrive here. A consent hit during teardown must still land in this
        // turn's channel, not vanish into "no turn in flight".
        reportConsent('call_1', [consent]);
      }
    }

    for await (const value of withConsentChannel(channel, source())) {
      void value;
      break;
    }

    expect(channel.byCallId.get('call_1')).toEqual([consent]);
  });
});
