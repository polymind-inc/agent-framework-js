import { describe, expect, it, vi } from 'vitest';
import type { ChatOptions } from '../client/chat-client.js';
import { withFunctionInvocation } from '../client/function-invocation.js';
import { MockChatClient } from '../client/test-support.js';
import { ConfigurationError } from '../errors.js';
import type { Content, FunctionCallContent, FunctionResultContent } from '../types/content.js';
import { textContent } from '../types/content.js';
import { Agent } from './agent.js';
import { agentAsTool } from './as-tool.js';
import { AgentSession } from './session.js';

function call(callId: string, name: string, args: string): FunctionCallContent {
  return { type: 'function_call', callId, name, arguments: args };
}

function resultsOf(contents: readonly Content[]): FunctionResultContent[] {
  return contents.filter((c): c is FunctionResultContent => c.type === 'function_result');
}

/** A sub-agent that answers every run with `reply`. */
function subAgent(config: { name?: string; description?: string; reply?: string } = {}): Agent {
  return new Agent({
    client: new MockChatClient([
      { contents: [textContent(config.reply ?? 'sub answer')], finishReason: 'stop' },
    ]),
    ...(config.name === undefined ? {} : { name: config.name }),
    ...(config.description === undefined ? {} : { description: config.description }),
  });
}

describe('agentAsTool declaration', () => {
  it('defaults the name to the sanitized agent name and the description to the agent description', () => {
    const declared = subAgent({ name: 'Invoice & Billing Agent', description: 'Handles invoices.' }).asTool();

    expect(declared.kind).toBe('function');
    // Python `_sanitize_agent_name`: non-word chars become `_`, runs collapse, ends are trimmed.
    expect(declared.name).toBe('Invoice_Billing_Agent');
    expect(declared.description).toBe('Handles invoices.');
  });

  it('sanitizes agent names the way the reference implementation does', () => {
    const cases: Array<[string, string]> = [
      ['Invoice & Billing Agent', 'Invoice_Billing_Agent'],
      ['123Agent', '_123Agent'],
      ['@@@', 'agent'],
      ['', 'agent'],
      ['  My Agent  ', 'My_Agent'],
      ['already_fine', 'already_fine'],
      ['Agent.With.Dots', 'Agent_With_Dots'],
    ];
    for (const [agentName, expected] of cases) {
      expect(subAgent({ name: agentName }).asTool().name).toBe(expected);
    }
  });

  it('falls back to an empty description when the agent has none', () => {
    expect(subAgent({ name: 'helper' }).asTool().description).toBe('');
  });

  it('declares one required string argument named "task" by default', () => {
    const declared = subAgent({ name: 'helper' }).asTool();
    expect(declared.jsonSchema).toEqual({
      type: 'object',
      properties: { task: { type: 'string', description: 'Task for helper' } },
      required: ['task'],
      additionalProperties: false,
    });
    expect(declared.approvalMode).toBe('never_require');
  });

  it('honours custom name, description and argName', () => {
    const declared = subAgent({ name: 'helper', description: 'ignored' }).asTool({
      name: 'research',
      description: 'Looks things up.',
      argName: 'query',
    });
    expect(declared.name).toBe('research');
    expect(declared.description).toBe('Looks things up.');
    expect(declared.jsonSchema).toEqual({
      type: 'object',
      properties: { query: { type: 'string', description: 'Task for research' } },
      required: ['query'],
      additionalProperties: false,
    });
  });

  it('refuses an agent with no name and no explicit tool name', () => {
    expect(() => subAgent().asTool()).toThrow(ConfigurationError);
    expect(() => subAgent().asTool({ name: 'named' })).not.toThrow();
  });

  it('refuses an empty argName', () => {
    expect(() => subAgent({ name: 'helper' }).asTool({ argName: '' })).toThrow(ConfigurationError);
  });

  it('works as a free function on any AgentLike, not only on Agent', () => {
    expect(agentAsTool(subAgent({ name: 'helper' })).name).toBe('helper');
  });
});

describe('agentAsTool invocation', () => {
  /** Runs `parent` once with a model turn that calls `toolName`. */
  async function delegate(
    tools: unknown[],
    args: string,
    toolName = 'helper',
  ): Promise<FunctionResultContent[]> {
    const client = withFunctionInvocation(
      new MockChatClient([
        { contents: [call('c1', toolName, args)], finishReason: 'tool_calls' },
        { contents: [textContent('done')], finishReason: 'stop' },
      ]),
    );
    const response = await client.getResponse([], { tools } as ChatOptions);
    return resultsOf(response.messages.flatMap((m) => m.contents));
  }

  it('passes the argument to the sub-agent and returns its text', async () => {
    const sub = subAgent({ name: 'helper', reply: 'the answer is 42' });
    const inner = sub as unknown as { run: Agent['run'] };
    const spy = vi.spyOn(inner, 'run');

    const results = await delegate([sub.asTool()], '{"task":"what is the answer?"}');

    expect(results[0]?.result).toBe('the answer is 42');
    expect(spy.mock.calls[0]?.[0]).toBe('what is the answer?');
  });

  it('sends an empty task when the model omitted the argument', async () => {
    const sub = subAgent({ name: 'helper' });
    const spy = vi.spyOn(sub as unknown as { run: Agent['run'] }, 'run');
    await delegate([sub.asTool()], '{}');
    expect(spy.mock.calls[0]?.[0]).toBe('');
  });

  it('does not pass a session by default', async () => {
    const sub = subAgent({ name: 'helper' });
    const spy = vi.spyOn(sub as unknown as { run: Agent['run'] }, 'run');

    const parent = new Agent({
      client: new MockChatClient([
        { contents: [call('c1', 'helper', '{"task":"go"}')], finishReason: 'tool_calls' },
        { contents: [textContent('done')], finishReason: 'stop' },
      ]),
      tools: [sub.asTool()],
    });
    await parent.run('hi', { session: parent.createSession({ sessionId: 'parent-1' }) });

    expect(spy.mock.calls[0]?.[1]?.session).toBeUndefined();
  });

  it('propagates a child session that shares the parent state when asked', async () => {
    const sub = subAgent({ name: 'helper' });
    const spy = vi.spyOn(sub as unknown as { run: Agent['run'] }, 'run');

    const parent = new Agent({
      client: new MockChatClient([
        { contents: [call('c1', 'helper', '{"task":"go"}')], finishReason: 'tool_calls' },
        { contents: [textContent('done')], finishReason: 'stop' },
      ]),
      tools: [sub.asTool({ propagateSession: true })],
    });
    const session = parent.createSession({ sessionId: 'parent-1' });
    session.serviceSessionId = 'conv-parent';
    await parent.run('hi', { session });

    const passed = spy.mock.calls[0]?.[1]?.session as AgentSession;
    expect(passed).toBeInstanceOf(AgentSession);
    // Same conversation identity and the *same* state object, so both agents see one transcript…
    expect(passed.sessionId).toBe('parent-1');
    expect(passed.state).toBe(session.state);
    // …but not the parent's own object, and never its service-side conversation id.
    expect(passed).not.toBe(session);
    expect(passed.serviceSessionId).toBeUndefined();
    expect(session.serviceSessionId).toBe('conv-parent');
  });

  it('reports a failing sub-agent to the model as a tool error rather than failing the run', async () => {
    const failing = new Agent({
      client: {
        metadata: { providerName: 'mock' },
        getResponse: () => {
          throw new Error('sub-agent exploded');
        },
      } as never,
      name: 'helper',
    });

    const results = await delegate([failing.asTool()], '{"task":"go"}');
    expect(results[0]?.result).toBe('Error: Function failed.');
    expect(results[0]?.exception).toContain('sub-agent exploded');
  });

  it('surfaces a sub-agent human-input request through the parent response', async () => {
    const gated = new Agent({
      client: new MockChatClient([
        {
          contents: [
            {
              type: 'function_approval_request',
              id: 'a1',
              functionCall: call('inner', 'danger', '{}'),
            },
            {
              type: 'oauth_consent_request',
              consentLink: 'https://example.test/consent',
            },
          ],
          finishReason: 'stop',
        },
      ]),
      name: 'helper',
    });

    const parent = new Agent({
      client: new MockChatClient([
        { contents: [call('c1', 'helper', '{"task":"go"}')], finishReason: 'tool_calls' },
      ]),
      tools: [gated.asTool()],
    });

    const response = await parent.run('delegate');

    expect(response.userInputRequests).toEqual([
      expect.objectContaining({
        type: 'function_approval_request',
        id: 'a1',
        callId: 'c1',
        userInputRequest: true,
        functionCall: expect.objectContaining({ callId: 'inner', name: 'danger' }),
      }),
      expect.objectContaining({
        type: 'oauth_consent_request',
        id: 'c1',
        callId: 'c1',
        userInputRequest: true,
        consentLink: 'https://example.test/consent',
      }),
    ]);
    expect(resultsOf(response.messages.flatMap((message) => message.contents))).toEqual([]);
  });

  it('returns the sub-agent structured output as its serialized text', async () => {
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) => ({ value: value as { name: string } }),
      },
      toJsonSchema: () => ({ type: 'object', properties: { name: { type: 'string' } } }),
    };
    const structured = new Agent({
      client: new MockChatClient([{ contents: [textContent('{"name":"Taro"}')], finishReason: 'stop' }]),
      name: 'helper',
      defaultOptions: { responseFormat: schema },
    });

    const results = await delegate([structured.asTool()], '{"task":"who?"}');
    // The tool contract is text (all three reference implementations return `response.text`), so
    // the parsed `value` stays on the sub-agent's own response and the model sees the JSON.
    expect(results[0]?.result).toBe('{"name":"Taro"}');
  });
});
