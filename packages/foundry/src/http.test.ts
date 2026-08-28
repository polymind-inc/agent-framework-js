import { describe, expect, it, vi } from 'vitest';
import { bodyText, drainBody } from './http.js';

describe('bodyText', () => {
  it('reads the body of a normal response', async () => {
    expect(await bodyText(new Response('payload'))).toBe('payload');
  });

  it('degrades to an empty string when reading rejects', async () => {
    const response = new Response('payload');
    await response.text();
    // A second read rejects: the body is already consumed.
    expect(await bodyText(response)).toBe('');
  });

  it('degrades to an empty string when text() itself throws synchronously', async () => {
    // A non-standard Response-like transport can throw instead of rejecting; the failure to read
    // a body must never replace the status the caller is diagnosing.
    const throwing = {
      text(): Promise<string> {
        throw new Error('no body access');
      },
    } as unknown as Response;
    expect(await bodyText(throwing)).toBe('');
  });
});

describe('drainBody', () => {
  function withBody(cancel: () => Promise<void>): Response {
    return { body: { cancel } } as unknown as Response;
  }

  it('cancels a normal body', async () => {
    const cancel = vi.fn(async () => {});
    await drainBody(withBody(cancel));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('resolves when there is no body at all', async () => {
    await drainBody({ body: null } as unknown as Response);
  });

  it('resolves when cancel() rejects', async () => {
    await drainBody(withBody(() => Promise.reject(new Error('locked'))));
  });

  it('resolves when cancel() itself throws synchronously', async () => {
    // Best-effort resource hygiene, never a failure: a Response-like whose cancel() throws must
    // not turn a succeeded operation into a failed one.
    await drainBody(
      withBody(() => {
        throw new Error('locked');
      }),
    );
  });
});
