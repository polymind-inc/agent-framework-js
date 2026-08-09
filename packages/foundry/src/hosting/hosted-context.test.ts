import type { HandlerContext } from '@polymind-inc/agent-framework-agentserver';
import { createRequestContext } from '@polymind-inc/agent-framework-agentserver';
import { describe, expect, it } from 'vitest';
import { getHostedAgentContext, hostedAgentContextOf, withHostedAgentContext } from './hosted-context.js';

function makeHandlerContext(): HandlerContext {
  const responseId = 'caresp_test';
  return {
    responseId,
    conversationId: undefined,
    request: createRequestContext(new Headers({ 'x-agent-user-id': 'alice' })),
    agentReference: { type: 'agent_reference', name: 'test-agent' },
    agentSessionId: 'session-test',
    history: [],
    signal: new AbortController().signal,
    response: { id: responseId, object: 'response', created_at: 0, status: 'queued', output: [] },
  };
}

describe('withHostedAgentContext', () => {
  it('keeps the context installed while the stream is torn down early', async () => {
    const context = hostedAgentContextOf(makeHandlerContext());
    // 'unread' rather than undefined, so a finally that never ran cannot pass the assertion.
    let seenInFinally: unknown = 'unread';
    async function* source(): AsyncGenerator<number> {
      try {
        yield 1;
        yield 2;
      } finally {
        // Where the agent saves its session, tears its tools down and runs afterRun hooks when
        // the consumer stops early — a consent break, a disconnect, a shutdown all arrive here.
        seenInFinally = getHostedAgentContext();
      }
    }

    for await (const value of withHostedAgentContext(context, source())) {
      void value;
      break;
    }

    expect(seenInFinally).toBe(context);
  });
});

describe('hostedAgentContextOf', () => {
  it('freezes the agent reference as a copy, apart from the protocol resource', () => {
    const handlerContext = makeHandlerContext();
    const context = hostedAgentContextOf(handlerContext);

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.agent)).toBe(true);
    expect(context.agent).toEqual(handlerContext.agentReference);
    // A copy, not the shared instance: the protocol layer persists its own object, and freezing
    // or mutating through this view must not reach it.
    expect(context.agent).not.toBe(handlerContext.agentReference);
    expect(Object.isFrozen(handlerContext.agentReference)).toBe(false);

    expect(() => {
      (context.agent as { name: string }).name = 'mutated';
    }).toThrow(TypeError);
    expect(handlerContext.agentReference.name).toBe('test-agent');
  });
});
