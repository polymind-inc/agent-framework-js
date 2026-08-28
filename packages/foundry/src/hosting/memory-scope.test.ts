import { ConfigurationError } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import { testHandlerContext } from '../test-helpers.js';
import { hostedAgentContextOf, withHostedAgentContext } from './hosted-context.js';
import { hostedUserScope } from './memory-scope.js';

/** Reads `scope` from inside a hosted turn built on `headers`. */
async function insideTurn(headers: Record<string, string>, scope: () => string): Promise<unknown> {
  const context = hostedAgentContextOf(testHandlerContext(headers));
  async function* source(): AsyncGenerator<unknown> {
    try {
      yield scope();
    } catch (error) {
      yield error;
    }
  }
  for await (const value of withHostedAgentContext(context, source())) {
    return value;
  }
  return undefined;
}

describe('hostedUserScope', () => {
  it('scopes memories to the end user the platform injected', async () => {
    expect(await insideTurn({ 'x-agent-user-id': 'alice' }, hostedUserScope())).toBe('alice');
  });

  it('refuses to fall back to a shared partition when the turn carries no user', async () => {
    const result = await insideTurn({}, hostedUserScope());

    expect(result).toBeInstanceOf(ConfigurationError);
    expect((result as Error).message).toContain('no end-user id');
  });

  it('refuses to resolve outside a hosted turn', () => {
    expect(() => hostedUserScope()()).toThrow(ConfigurationError);
  });
});
