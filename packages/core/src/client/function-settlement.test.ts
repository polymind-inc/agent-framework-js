/**
 * Settling dangling tool calls on a service-managed conversation.
 *
 * A fatal abort can end a tool round with calls that never produced a result. While the framework
 * owns the transcript that is harmless — the next request is assembled locally and filters the
 * unanswerable call — but once the service owns the transcript the dangling call is on the
 * service's side, and the next request over that conversation is rejected (measured against the
 * Anthropic Messages API, 2026-08-31: every `tool_use` must have a corresponding `tool_result`).
 * The loop therefore settles the calls with one error `function_result` each before the abort
 * propagates, exactly as the reference implementation's `MiddlewareFailure` settlement path does.
 */
import { assert, describe, expect, it } from 'vitest';
import { AgentSession } from '../agent/session.js';
import { MiddlewareFailed } from '../errors.js';
import { functionMiddleware } from '../middleware/middleware.js';
import { createResponseStream } from '../streaming/response-stream.js';
import { tool } from '../tools/tool.js';
import type { Content, FunctionResultContent } from '../types/content.js';
import { textContent } from '../types/content.js';
import type { Message } from '../types/message.js';
import type { ChatResponseUpdate } from '../types/response.js';
import { chatResponseUpdate, mergeChatUpdates } from '../types/response.js';
import type { ChatClient, ChatClientMetadata, ChatOptions } from './chat-client.js';
import { createFunctionInvocationClientFactory, withFunctionInvocation } from './function-invocation.js';

const ABORT_RESULT_TEXT = 'Error: Tool execution was aborted by middleware before a result was produced.';

function call(callId: string, name = 'echo'): Content {
  return { type: 'function_call', callId, name, arguments: '{}' };
}

const echo = tool({
  name: 'echo',
  description: 'echo',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => 'ok',
});

const abortingMiddleware = functionMiddleware(async () => {
  throw new MiddlewareFailed('policy says stop');
});

interface ScriptedTurn {
  contents: Content[];
  conversationId?: string;
  /** Reject this request instead of answering it. */
  fail?: boolean;
}

/** A scripted provider that reports conversation ids and records every request it receives. */
function scriptedClient(
  turns: ScriptedTurn[],
  metadata: ChatClientMetadata = { providerName: 'mock' },
): {
  client: ChatClient<ChatOptions>;
  requests: Array<ChatOptions | undefined>;
  sent: Message[][];
} {
  let index = 0;
  const requests: Array<ChatOptions | undefined> = [];
  const sent: Message[][] = [];
  const client: ChatClient<ChatOptions> = {
    metadata,
    getResponse: (messages, options) => {
      requests.push(options);
      sent.push(messages);
      const turn = turns[Math.min(index++, turns.length - 1)] ?? { contents: [] };
      return createResponseStream({
        start: () =>
          (async function* (): AsyncGenerator<ChatResponseUpdate> {
            if (turn.fail === true) {
              throw new Error('service unavailable');
            }
            yield chatResponseUpdate({
              contents: turn.contents,
              role: 'assistant',
              ...(turn.conversationId === undefined ? {} : { conversationId: turn.conversationId }),
            });
          })(),
        finalize: (updates) => mergeChatUpdates(updates),
      });
    },
  };
  return { client, requests, sent };
}

function resultsOf(messages: Message[]): FunctionResultContent[] {
  return messages
    .flatMap((msg) => msg.contents)
    .filter((content): content is FunctionResultContent => content.type === 'function_result');
}

describe('settlement on a fatal middleware abort', () => {
  it('answers each dangling call exactly once and still rethrows the original failure', async () => {
    const { client, requests, sent } = scriptedClient([
      { contents: [call('c1'), call('c2')], conversationId: 'resp_1' },
      { contents: [textContent('settled')], conversationId: 'resp_settle' },
    ]);

    await expect(
      withFunctionInvocation(client, { middleware: [abortingMiddleware] }).getResponse([], {
        tools: [echo],
      } as ChatOptions),
    ).rejects.toBeInstanceOf(MiddlewareFailed);

    // One settlement request: the batch's calls each answered by an error result, with the tool
    // choice pinned so the settlement response cannot ask for more calls.
    expect(requests).toHaveLength(2);
    expect(requests[1]?.toolChoice).toBe('none');
    expect(requests[1]?.conversationId).toBe('resp_1');
    const settlement = sent[1];
    assert.exists(settlement);
    expect(settlement.map((msg) => msg.role)).toEqual(['tool']);
    expect(resultsOf(settlement)).toEqual([
      { type: 'function_result', callId: 'c1', result: ABORT_RESULT_TEXT, exception: 'MiddlewareFailure' },
      { type: 'function_result', callId: 'c2', result: ABORT_RESULT_TEXT, exception: 'MiddlewareFailure' },
    ]);
  });

  it('sends nothing when the framework owns the transcript', async () => {
    const { client, requests } = scriptedClient([{ contents: [call('c1')] }]);

    await expect(
      withFunctionInvocation(client, { middleware: [abortingMiddleware] }).getResponse([], {
        tools: [echo],
      } as ChatOptions),
    ).rejects.toBeInstanceOf(MiddlewareFailed);

    expect(requests).toHaveLength(1);
  });

  it('settles on the streamed path the same way', async () => {
    const { client, requests, sent } = scriptedClient([
      { contents: [call('c1')], conversationId: 'resp_1' },
      { contents: [textContent('settled')] },
    ]);

    const stream = withFunctionInvocation(client, { middleware: [abortingMiddleware] }).getResponse([], {
      tools: [echo],
    } as ChatOptions);
    await expect(
      (async () => {
        for await (const _update of stream) {
          // consume to the failure
        }
      })(),
    ).rejects.toBeInstanceOf(MiddlewareFailed);

    expect(requests).toHaveLength(2);
    expect(resultsOf(sent[1] ?? []).map((result) => result.callId)).toEqual(['c1']);
  });

  it('never lets a settlement failure mask the abort', async () => {
    const { client, requests } = scriptedClient([
      { contents: [call('c1')], conversationId: 'resp_1' },
      { contents: [], fail: true },
    ]);

    await expect(
      withFunctionInvocation(client, { middleware: [abortingMiddleware] }).getResponse([], {
        tools: [echo],
      } as ChatOptions),
    ).rejects.toBeInstanceOf(MiddlewareFailed);

    expect(requests).toHaveLength(2);
  });

  it('advances the persisted continuation to the settlement response', async () => {
    // For response-id chaining the settlement response is the first endpoint whose chain includes
    // the synthetic outputs, so the next run must start from it.
    const { client } = scriptedClient([
      { contents: [call('c1')], conversationId: 'resp_1' },
      { contents: [textContent('settled')], conversationId: 'resp_settle' },
    ]);
    const session = new AgentSession();
    const bound = createFunctionInvocationClientFactory(client, { middleware: [abortingMiddleware] })(
      session,
    );

    await expect(bound.getResponse([], { tools: [echo] } as ChatOptions)).rejects.toBeInstanceOf(
      MiddlewareFailed,
    );

    expect(session.serviceSessionId).toBe('resp_settle');
  });

  it('does not displace a conversation anchor the provider declares stable', async () => {
    // A conversation-object id resolves across responses; the settlement lands on it and no
    // advance is needed — displacing it would unhook the session from the stored conversation.
    const { client, requests } = scriptedClient(
      [
        { contents: [call('c1')], conversationId: 'resp_1' },
        { contents: [textContent('settled')], conversationId: 'resp_settle' },
      ],
      { providerName: 'mock', stableConversationId: (id) => id.startsWith('conv_') },
    );
    const session = new AgentSession({ serviceSessionId: 'conv_1' });
    const bound = createFunctionInvocationClientFactory(client, { middleware: [abortingMiddleware] })(
      session,
    );

    await expect(
      bound.getResponse([], { tools: [echo], conversationId: 'conv_1' } as ChatOptions),
    ).rejects.toBeInstanceOf(MiddlewareFailed);

    expect(requests[1]?.conversationId).toBe('conv_1');
    expect(session.serviceSessionId).toBe('conv_1');
  });
});

describe('settlement of an aborted approval replay', () => {
  it('settles the approved calls of an already-persisted turn', async () => {
    // The replayed calls belong to an earlier model turn the service already stored; when
    // executing the approved batch aborts, those calls are what dangles.
    const { client, requests, sent } = scriptedClient([
      { contents: [textContent('settled')], conversationId: 'resp_settle' },
    ]);
    const gated = tool({
      name: 'gated',
      description: 'd',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      approvalMode: 'always_require',
      execute: async () => 'ran',
    });

    await expect(
      withFunctionInvocation(client, { middleware: [abortingMiddleware] }).getResponse(
        [
          { role: 'user', contents: [textContent('go')] },
          {
            role: 'user',
            contents: [
              {
                type: 'function_approval_response',
                id: 'a1',
                approved: true,
                functionCall: { type: 'function_call', callId: 'c1', name: 'gated', arguments: '{}' },
              },
            ],
          },
        ],
        { tools: [gated], conversationId: 'conv_1' } as ChatOptions,
      ),
    ).rejects.toBeInstanceOf(MiddlewareFailed);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.toolChoice).toBe('none');
    expect(requests[0]?.conversationId).toBe('conv_1');
    expect(resultsOf(sent[0] ?? [])).toEqual([
      { type: 'function_result', callId: 'c1', result: ABORT_RESULT_TEXT, exception: 'MiddlewareFailure' },
    ]);
  });

  it('sends nothing for an aborted replay when no conversation is in play', async () => {
    const { client, requests } = scriptedClient([{ contents: [textContent('never')] }]);
    const gated = tool({
      name: 'gated',
      description: 'd',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      approvalMode: 'always_require',
      execute: async () => 'ran',
    });

    await expect(
      withFunctionInvocation(client, { middleware: [abortingMiddleware] }).getResponse(
        [
          {
            role: 'user',
            contents: [
              {
                type: 'function_approval_response',
                id: 'a1',
                approved: true,
                functionCall: { type: 'function_call', callId: 'c1', name: 'gated', arguments: '{}' },
              },
            ],
          },
        ],
        { tools: [gated] } as ChatOptions,
      ),
    ).rejects.toBeInstanceOf(MiddlewareFailed);

    expect(requests).toHaveLength(0);
  });
});

describe('settlement of calls withdrawn at the iteration limit', () => {
  it('answers the calls the final toolless round still produced', async () => {
    // The final round forbids tools, but a model can answer with a call anyway; the call is
    // removed from what the caller sees, and on a service-managed conversation the service still
    // holds it — so it is settled the same way an aborted batch is.
    const { client, requests, sent } = scriptedClient([
      { contents: [call('c1')], conversationId: 'resp_1' },
      { contents: [call('c9', 'echo')], conversationId: 'resp_2' },
      { contents: [textContent('settled')], conversationId: 'resp_settle' },
    ]);

    const response = await withFunctionInvocation(client, { maxIterations: 1 }).getResponse([], {
      tools: [echo],
    } as ChatOptions);

    expect(requests).toHaveLength(3);
    expect(requests[2]?.toolChoice).toBe('none');
    expect(requests[2]?.conversationId).toBe('resp_2');
    const settlement = resultsOf(sent[2] ?? []);
    expect(settlement.map((result) => result.callId)).toEqual(['c9']);
    expect(settlement[0]?.result).toBe(
      'Error: Function invocation limit reached before a result was produced.',
    );
    // The run's own answer is unchanged: the withdrawn call is absent and the fallback stands.
    expect(response.text).toContain('Function invocation limit reached');
  });

  it('settles nothing at the limit when the framework owns the transcript', async () => {
    const { client, requests } = scriptedClient([
      { contents: [call('c1')] },
      { contents: [call('c9', 'echo')] },
    ]);

    await withFunctionInvocation(client, { maxIterations: 1 }).getResponse([], {
      tools: [echo],
    } as ChatOptions);

    expect(requests).toHaveLength(2);
  });
});
