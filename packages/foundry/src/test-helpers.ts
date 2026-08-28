/**
 * Shared fixtures for this package's tests.
 *
 * Not part of the published build: nothing reachable from `src/index.ts` or `src/hosting.ts`
 * imports it, and the test runner collects only `*.test.ts` files.
 */

import type { AccessToken, TokenCredential } from '@azure/identity';
import type { HandlerContext } from '@polymind-inc/agent-framework-agentserver';
import { createRequestContext } from '@polymind-inc/agent-framework-agentserver';
import { type Mocked, vi } from 'vitest';

/** A credential whose tokens expire `ttlMs` from now. */
export function fakeCredential(ttlMs: number = 60 * 60 * 1000): Mocked<TokenCredential> {
  let calls = 0;
  return {
    getToken: vi.fn<TokenCredential['getToken']>(async (): Promise<AccessToken> => {
      calls += 1;
      return { token: `token-${calls}`, expiresOnTimestamp: Date.now() + ttlMs };
    }),
  } satisfies TokenCredential;
}

/** A handler context for one hosted turn, built on the given request headers. */
export function testHandlerContext(headers: Record<string, string>): HandlerContext {
  const responseId = 'caresp_test';
  return {
    responseId,
    conversationId: undefined,
    request: createRequestContext(new Headers(headers)),
    agentReference: { type: 'agent_reference', name: 'test-agent' },
    agentSessionId: 'session-test',
    history: [],
    signal: new AbortController().signal,
    response: { id: responseId, object: 'response', created_at: 0, status: 'queued', output: [] },
  };
}
