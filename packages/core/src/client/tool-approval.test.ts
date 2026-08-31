import { assert, describe, expect, it } from 'vitest';
import { Agent } from '../agent/agent.js';
import { AgentSession } from '../agent/session.js';
import {
  approvalResponse,
  functionApprovalRequestContent,
  isApprovalRequest,
  isApprovalResponse,
  isHostedApproval,
} from '../tools/approval.js';
import { tool } from '../tools/tool.js';
import type {
  Content,
  FunctionApprovalRequestContent,
  FunctionApprovalResponseContent,
  FunctionCallContent,
} from '../types/content.js';
import { textContent } from '../types/content.js';
import type { Message } from '../types/message.js';
import { deserializeContent } from '../types/serialization.js';
import type { ChatClient, ChatOptions } from './chat-client.js';
import { withFunctionInvocation } from './function-invocation.js';
import { MockChatClient } from './test-support.js';
import type { ApprovalStateStore } from './tool-approval.js';
import { sessionApprovalStore, withToolApproval } from './tool-approval.js';

const deleteAll = tool({
  name: 'delete_all',
  description: 'Delete everything',
  parameters: { type: 'object', properties: {} },
  approvalMode: 'always_require',
  execute: async () => 'deleted',
});

const readOnly = tool({
  name: 'read_only',
  description: 'Read something',
  parameters: { type: 'object', properties: {} },
  execute: async () => 'read',
});

function call(callId: string, name: string): FunctionCallContent {
  return { type: 'function_call', callId, name, arguments: '{}' };
}

/** Every `function_result` in a transcript, as `[callId, result]`. */
function results(messages: Message[]): Array<[string, unknown]> {
  return messages.flatMap((msg) =>
    msg.contents.flatMap(
      (content): Array<[string, unknown]> =>
        content.type === 'function_result' ? [[content.callId, content.result]] : [],
    ),
  );
}

/** Narrows `userInputRequests` (an approval/consent union) to the approval requests. */
function approvals(response: { userInputRequests: readonly Content[] }): FunctionApprovalRequestContent[] {
  return response.userInputRequests.filter(isApprovalRequest);
}

describe('tool approval', () => {
  it('interrupts the loop and surfaces the call for approval', async () => {
    const mock = new MockChatClient([
      { contents: [call('c1', 'delete_all')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client: mock, tools: [deleteAll] });

    const response = await agent.run('delete everything', { session: agent.createSession() });

    expect(mock.callCount).toBe(1);
    expect(response.userInputRequests).toHaveLength(1);
    expect(approvals(response)[0]?.functionCall.name).toBe('delete_all');
    // The tool must not have run.
    expect(results(response.messages)).toEqual([]);
  });

  it('executes the call and resumes the loop when approved', async () => {
    const mock = new MockChatClient([
      { contents: [call('c1', 'delete_all')], finishReason: 'tool_calls' },
      { contents: [textContent('all gone')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client: mock, tools: [deleteAll] });
    const session = agent.createSession();

    const first = await agent.run('delete everything', { session });
    const request = approvals(first)[0];
    assert.exists(request);
    const resumed = await agent.run(approvalResponse(request, true), { session });

    expect(results(resumed.messages)).toEqual([['c1', 'deleted']]);
    expect(resumed.text).toBe('all gone');
    // The provider sees the approval as a plain assistant tool-call plus its result, never as
    // approval content.
    const sent = mock.calls[1]?.messages.flatMap((msg) => msg.contents.map((c) => c.type));
    expect(sent).toContain('function_call');
    expect(sent).not.toContain('function_approval_request');
    expect(sent).not.toContain('function_approval_response');
  });

  it('reports a refusal to the model instead of executing when denied', async () => {
    const mock = new MockChatClient([
      { contents: [call('c1', 'delete_all')], finishReason: 'tool_calls' },
      { contents: [textContent('understood')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client: mock, tools: [deleteAll] });
    const session = agent.createSession();

    const first = await agent.run('delete everything', { session });
    const request = approvals(first)[0];
    assert.exists(request);
    const resumed = await agent.run(approvalResponse(request, false, { reason: 'too risky' }), {
      session,
    });

    expect(results(resumed.messages)).toEqual([
      ['c1', 'Error: Tool call invocation was rejected by user. too risky'],
    ]);
    expect(resumed.text).toBe('understood');
  });

  it('keeps unanswered requests pending when only part of an approval batch is answered', async () => {
    const executed: string[] = [];
    const gated = tool({
      name: 'gated',
      description: 'Needs a human',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
      approvalMode: 'always_require',
      execute: async (input) => {
        const value = String(input.value);
        executed.push(value);
        return value;
      },
    });
    const mock = new MockChatClient([
      {
        contents: [
          { ...call('c1', 'gated'), arguments: '{"value":"first"}' },
          { ...call('c2', 'gated'), arguments: '{"value":"second"}' },
        ],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client: mock, tools: [gated] });
    const session = agent.createSession();

    const first = await agent.run('do both', { session });
    const [firstRequest, secondRequest] = approvals(first);
    assert.exists(firstRequest);
    const partial = await agent.run(approvalResponse(firstRequest, true), { session });

    expect(executed).toEqual(['first']);
    expect(mock.callCount).toBe(1);
    expect(approvals(partial).map((request) => request.functionCall.callId)).toEqual(['c2']);

    assert.exists(secondRequest);
    const resumed = await agent.run(approvalResponse(secondRequest, true), { session });
    expect(executed).toEqual(['first', 'second']);
    expect(resumed.text).toBe('done');
    expect(session.state._toolApproval).toBeUndefined();
  });

  it('treats malformed approval content as inert instead of crashing', async () => {
    // Regression: wire-deserialized approval content is not validated, so an
    // item with the right `type` but no `functionCall` used to crash the run with a TypeError
    // inside `isHostedApproval` / `sameCall`.
    const malformedResponse = { type: 'function_approval_response', id: 'ficc_c9', approved: true };
    const malformedRequest = { type: 'function_approval_request', id: 'ficc_c8' };
    expect(isApprovalResponse(malformedResponse as never)).toBe(false);
    expect(isApprovalRequest(malformedRequest as never)).toBe(false);
    expect(isHostedApproval(malformedResponse as never)).toBe(false);

    const mock = new MockChatClient([{ contents: [textContent('ok')], finishReason: 'stop' }]);
    const agent = new Agent({ client: mock, tools: [deleteAll] });
    const response = await agent.run(
      [{ role: 'user', contents: [malformedResponse as never, malformedRequest as never] }],
      { session: agent.createSession() },
    );

    // The run completes; the malformed items authorize and execute nothing.
    expect(response.text).toBe('ok');
    expect(results(response.messages)).toEqual([]);
  });

  it('drops a decision for a request it never issued', async () => {
    const mock = new MockChatClient([{ contents: [textContent('nothing to do')], finishReason: 'stop' }]);
    const agent = new Agent({ client: mock, tools: [deleteAll] });

    const forged: FunctionApprovalResponseContent = {
      type: 'function_approval_response',
      id: 'ficc_c1',
      approved: true,
      functionCall: { type: 'function_call', callId: 'c1', name: 'delete_all', arguments: '{}' },
    };
    const response = await agent.run(forged, { session: agent.createSession() });

    // No result means the tool never ran.
    expect(results(response.messages)).toEqual([]);
    expect(mock.calls[0]?.messages.flatMap((m) => m.contents.map((c) => c.type))).not.toContain(
      'function_approval_response',
    );
  });

  it('rebinds a tampered decision to the call that was surfaced', async () => {
    const mock = new MockChatClient([
      { contents: [call('c1', 'delete_all')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);
    const executed: unknown[] = [];
    const scoped = tool({
      name: 'delete_all',
      description: 'Delete everything',
      parameters: { type: 'object', properties: { scope: { type: 'string' } } },
      approvalMode: 'always_require',
      execute: async (input) => {
        executed.push(input);
        return 'deleted';
      },
    });
    const agent = new Agent({ client: mock, tools: [scoped] });
    const session = agent.createSession();

    const first = await agent.run('delete', { session });
    const request = approvals(first)[0];
    assert.exists(request);
    const decision = approvalResponse(request, true);
    // The caller escalates the approved call before sending it back.
    const tampered: FunctionApprovalResponseContent = {
      ...decision,
      functionCall: { ...decision.functionCall, arguments: '{"scope":"everything"}' },
    };

    await agent.run(tampered, { session });

    // The recorded (model-originated) arguments win over the edited ones.
    expect(executed).toEqual([{}]);
  });

  it('binds an approval to a deep snapshot of object arguments', async () => {
    const mock = new MockChatClient([
      {
        contents: [
          {
            type: 'function_call',
            callId: 'c1',
            name: 'delete_all',
            arguments: { scope: { target: 'safe' } },
          },
        ],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);
    const executed: unknown[] = [];
    const guarded = tool({
      name: 'delete_all',
      description: 'Delete records',
      parameters: { type: 'object', properties: { scope: { type: 'object' } } },
      approvalMode: 'always_require',
      execute: async (input) => {
        executed.push(input);
        return 'deleted';
      },
    });
    const agent = new Agent({ client: mock, tools: [guarded] });
    const session = agent.createSession();

    const first = await agent.run('delete', { session });
    const request = approvals(first)[0];
    assert.exists(request);
    const decision = approvalResponse(structuredClone(request), true);
    const args = request.functionCall.arguments as { scope: { target: string } };
    args.scope.target = 'everything';

    await agent.run(decision, { session });
    expect(executed).toEqual([{ scope: { target: 'safe' } }]);
  });

  it('records a streaming approval before exposing its mutable request object', async () => {
    const mock = new MockChatClient([
      {
        contents: [
          {
            type: 'function_call',
            callId: 'c1',
            name: 'delete_all',
            arguments: '{"scope":"safe"}',
          },
        ],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);
    const executed: unknown[] = [];
    const guarded = tool({
      name: 'delete_all',
      description: 'Delete records',
      parameters: { type: 'object', properties: { scope: { type: 'string' } } },
      approvalMode: 'always_require',
      execute: async (input) => {
        executed.push(input);
        return 'deleted';
      },
    });
    const agent = new Agent({ client: mock, tools: [guarded] });
    const session = agent.createSession();
    const stream = agent.run('delete', { session });
    const iterator = stream[Symbol.asyncIterator]();
    let request: FunctionApprovalRequestContent | undefined;

    while (request === undefined) {
      const next = await iterator.next();
      if (next.done === true) throw new Error('approval request was not surfaced');
      request = next.value.contents.find(isApprovalRequest);
    }
    const decision = approvalResponse(structuredClone(request), true);
    request.functionCall.arguments = '{"scope":"everything"}';
    await iterator.return?.();

    await agent.run(decision, { session });
    expect(executed).toEqual([{ scope: 'safe' }]);
  });

  it('executes the recorded arguments when a streamed request is deep-mutated before approval', async () => {
    // Pins the snapshot invariant end-to-end: the object handed to the caller mid-stream is not
    // the record the decision is bound against. Deep-mutating the caller's copy — while the
    // stream is still open, so before the record is persisted — and approving from that mutated
    // copy must still execute the arguments the model originally produced.
    const mock = new MockChatClient([
      {
        contents: [
          {
            type: 'function_call',
            callId: 'c1',
            name: 'delete_all',
            arguments: { scope: { target: 'safe' } },
          },
        ],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);
    const executed: unknown[] = [];
    const guarded = tool({
      name: 'delete_all',
      description: 'Delete records',
      parameters: { type: 'object', properties: { scope: { type: 'object' } } },
      approvalMode: 'always_require',
      execute: async (input) => {
        executed.push(input);
        return 'deleted';
      },
    });
    const agent = new Agent({ client: mock, tools: [guarded] });
    const session = agent.createSession();
    const stream = agent.run('delete', { session });
    const iterator = stream[Symbol.asyncIterator]();
    let request: FunctionApprovalRequestContent | undefined;

    while (request === undefined) {
      const next = await iterator.next();
      if (next.done === true) throw new Error('approval request was not surfaced');
      request = next.value.contents.find(isApprovalRequest);
    }
    (request.functionCall.arguments as { scope: { target: string } }).scope.target = 'everything';
    await iterator.return?.();

    await agent.run(approvalResponse(request, true), { session });
    expect(executed).toEqual([{ scope: { target: 'safe' } }]);
  });

  it('prefers the stored request over a replayed one carrying the same id', async () => {
    const mock = new MockChatClient([
      { contents: [call('c1', 'delete_all')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);
    const executed: unknown[] = [];
    const scoped = tool({
      name: 'delete_all',
      description: 'Delete everything',
      parameters: { type: 'object', properties: { scope: { type: 'string' } } },
      approvalMode: 'always_require',
      execute: async (input) => {
        executed.push(input);
        return 'deleted';
      },
    });
    const agent = new Agent({ client: mock, tools: [scoped] });
    const session = agent.createSession();

    const first = await agent.run('delete', { session });
    const request = approvals(first)[0];
    assert.exists(request);
    // A caller that replays the whole transcript can send the request back too — with different
    // arguments. The session's own record of what the human saw has to outrank it.
    const replayed: Content = {
      ...request,
      functionCall: { ...request.functionCall, arguments: '{"scope":"everything"}' },
    };

    await agent.run([replayed, approvalResponse(request, true)], { session });

    expect(executed).toEqual([{}]);
  });

  it('survives session serialization between the request and the decision', async () => {
    const mock = new MockChatClient([
      { contents: [call('c1', 'delete_all')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client: mock, tools: [deleteAll] });

    const session = agent.createSession();
    const request = approvals(await agent.run('delete', { session }))[0];
    assert.exists(request);
    // The human answers in another process, so only the serialized session bridges the turns.
    const roundTripped = AgentSession.fromJSON(JSON.parse(JSON.stringify(session)) as unknown);

    const resumed = await agent.run(approvalResponse(request, true), { session: roundTripped });
    expect(results(resumed.messages)).toEqual([['c1', 'deleted']]);
  });

  it('does not ask for approval for tools that do not need it', async () => {
    const mock = new MockChatClient([
      {
        contents: [call('c1', 'delete_all'), call('c2', 'read_only')],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('finished')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client: mock, tools: [deleteAll, readOnly] });
    const session = agent.createSession();

    const first = await agent.run('do both', { session });

    // Only the approval-required call reaches the caller.
    expect(approvals(first).map((r) => r.functionCall.name)).toEqual(['delete_all']);

    const request = approvals(first)[0];
    assert.exists(request);
    const resumed = await agent.run(approvalResponse(request, true), { session });

    // Both calls run once the human answers: the model needs a result for every call it made.
    expect(results(resumed.messages).sort()).toEqual([
      ['c1', 'deleted'],
      ['c2', 'read'],
    ]);
  });

  it('leaves a hosted MCP approval for the provider to settle', async () => {
    // The MCP server lives on the provider's side: it raised the request and it is the only thing
    // that can act on the decision. Everything this layer does to a local approval — bind it,
    // strip it, execute it — would break that round trip.
    const hostedRequest: Content = {
      type: 'function_approval_request',
      id: 'mcpr_1',
      functionCall: {
        type: 'function_call',
        callId: 'mcpr_1',
        name: 'search_docs',
        arguments: '{"q":"agents"}',
        additionalProperties: { server_label: 'docs_mcp' },
      },
    };
    const mock = new MockChatClient([
      { contents: [hostedRequest], finishReason: 'stop' },
      { contents: [textContent('found three')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client: mock, tools: [deleteAll] });
    const session = agent.createSession();

    const first = await agent.run('search the docs', { session });
    expect(first.userInputRequests).toHaveLength(1);
    expect(approvals(first)[0]?.id).toBe('mcpr_1');

    const request = approvals(first)[0];
    assert.exists(request);
    const resumed = await agent.run(approvalResponse(request, true), { session });

    // No local execution, and above all no fabricated "not found" result: the tool is not ours.
    expect(results(resumed.messages)).toEqual([]);
    // The decision reaches the provider as approval content, which is what becomes the wire
    // `mcp_approval_response`. Stripping it here is what left the approval pending forever.
    const secondCall = mock.calls[1];
    assert.exists(secondCall);
    const sent = secondCall.messages.flatMap((msg) => msg.contents);
    const decision = sent.find((content) => content.type === 'function_approval_response');
    expect(decision).toMatchObject({ id: 'mcpr_1', approved: true });
    expect(resumed.text).toBe('found three');
  });

  it('surfaces one approval per call when the provider streams argument fragments', async () => {
    // A real provider streams `function_call` arguments in pieces. Converting each piece into its
    // own approval request asks the human to approve `{"sc`, then `ope":"a`, then `ll"}` — six
    // meaningless decisions instead of one, and the decision that comes back binds to a fragment.
    const executed: unknown[] = [];
    const scoped = tool({
      name: 'delete_all',
      description: 'Delete everything',
      parameters: { type: 'object', properties: { scope: { type: 'string' } } },
      approvalMode: 'always_require',
      execute: async (input) => {
        executed.push(input);
        return 'deleted';
      },
    });
    const mock = new MockChatClient([
      {
        contents: [
          { type: 'function_call', callId: 'c1', name: 'delete_all', arguments: '{"sc' },
          { type: 'function_call', callId: 'c1', name: 'delete_all', arguments: 'ope":"a' },
          { type: 'function_call', callId: 'c1', name: 'delete_all', arguments: 'll"}' },
        ],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('all gone')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client: mock, tools: [scoped] });
    const session = agent.createSession();

    const stream = agent.run('delete everything', { session });
    for await (const _ of stream) {
      // drain
    }
    const first = await stream.finalResponse();

    expect(first.userInputRequests).toHaveLength(1);
    expect(approvals(first)[0]?.functionCall.arguments).toBe('{"scope":"all"}');

    const request = approvals(first)[0];
    assert.exists(request);
    const resumed = await agent.run(approvalResponse(request, true), { session });
    expect(executed).toEqual([{ scope: 'all' }]);
    expect(resumed.text).toBe('all gone');
  });

  it('keeps the approval-free path untouched', async () => {
    const mock = new MockChatClient([
      { contents: [call('c1', 'read_only')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client: mock, tools: [readOnly] });

    const response = await agent.run('read', { session: agent.createSession() });
    expect(response.userInputRequests).toEqual([]);
    expect(results(response.messages)).toEqual([['c1', 'read']]);
  });

  it('keeps declaration-only calls visible beside an approval request', async () => {
    const guarded = tool({
      name: 'guarded',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      approvalMode: 'always_require',
      execute: async () => 'done',
    });
    const manual = tool({ name: 'manual', description: 'd', parameters: { type: 'object', properties: {} } });
    const mock = new MockChatClient([
      {
        contents: [call('c1', 'guarded'), call('c2', 'manual')],
        finishReason: 'tool_calls',
      },
    ]);
    const agent = new Agent({ client: mock, tools: [guarded, manual] });

    const response = await agent.run('go', { session: agent.createSession() });
    expect(response.userInputRequests).toHaveLength(2);
    expect(
      response.userInputRequests.some(
        (content) => content.type === 'function_approval_request' && content.functionCall.name === 'manual',
      ),
    ).toBe(true);
  });

  it('behaves the same when streamed', async () => {
    const mock = new MockChatClient([
      { contents: [call('c1', 'delete_all')], finishReason: 'tool_calls' },
      { contents: [textContent('all gone')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client: mock, tools: [deleteAll] });
    const session = agent.createSession();

    const stream = agent.run('delete', { session });
    for await (const _ of stream) {
      // drain
    }
    const first = await stream.finalResponse();
    expect(first.userInputRequests).toHaveLength(1);

    const request = approvals(first)[0];
    assert.exists(request);
    const resumeStream = agent.run(approvalResponse(request, true), { session });
    for await (const _ of resumeStream) {
      // drain
    }
    const resumed = await resumeStream.finalResponse();
    expect(results(resumed.messages)).toEqual([['c1', 'deleted']]);
  });

  it('counts an approved call failure toward the shared error budget', async () => {
    // The resume round and the loop of the same run share one consecutive-error budget.
    // With maxConsecutiveErrors: 1, the approved call's failure
    // spends the budget, so the next failing round in the same run must surface the raw error —
    // if the budget were reset on resume, that round would be captured and the model called again.
    const failingGuarded = tool({
      name: 'guarded',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      approvalMode: 'always_require',
      execute: async () => {
        throw new Error('kaboom');
      },
    });
    const failingFree = tool({
      name: 'free',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        throw new Error('kaboom2');
      },
    });
    const mock = new MockChatClient([
      { contents: [call('c1', 'guarded')], finishReason: 'tool_calls' },
      // Served inside the *resume* run, right after the approved call failed.
      { contents: [call('c2', 'free')], finishReason: 'tool_calls' },
      { contents: [textContent('never reached')], finishReason: 'stop' },
    ]);
    const agent = new Agent({
      client: mock,
      tools: [failingGuarded, failingFree],
      functionInvocation: { maxConsecutiveErrors: 1 },
    });
    const session = agent.createSession();

    const first = await agent.run('go', { session });
    expect(approvals(first)).toHaveLength(1);

    const request = approvals(first)[0];
    assert.exists(request);
    await expect(agent.run(approvalResponse(request, true), { session })).rejects.toThrow('kaboom2');
  });

  it('reads a legacy additionalProperties reason when no first-class reason is present', async () => {
    // Older serialized transcripts carried the reason in additionalProperties;
    // approvalReason falls back so replayed old decisions keep their rejection text.
    const mock = new MockChatClient([
      { contents: [call('c1', 'delete_all')], finishReason: 'tool_calls' },
      { contents: [textContent('understood')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client: mock, tools: [deleteAll] });
    const session = agent.createSession();

    const first = await agent.run('delete everything', { session });
    const request = approvals(first)[0];
    assert.exists(request);
    const legacy: FunctionApprovalResponseContent = {
      type: 'function_approval_response',
      id: request.id,
      approved: false,
      functionCall: request.functionCall,
      additionalProperties: { reason: 'legacy veto' },
    };
    const resumed = await agent.run(legacy, { session });

    expect(results(resumed.messages)).toEqual([
      ['c1', 'Error: Tool call invocation was rejected by user. legacy veto'],
    ]);
  });
});

describe('approval occurrences of a reused call id', () => {
  /** A gated tool that records the `value` argument of every call it actually runs. */
  function recordingGate(executed: string[], name = 'gated') {
    return tool({
      name,
      description: 'Needs a human',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
      approvalMode: 'always_require',
      execute: async (input) => {
        const value = String(input.value);
        executed.push(value);
        return `ran ${value}`;
      },
    });
  }

  /** `call()` with the arguments a gated tool records. */
  function valued(callId: string, name: string, value: string): FunctionCallContent {
    return { type: 'function_call', callId, name, arguments: `{"value":"${value}"}` };
  }

  /** The production composition, driven with an explicit transcript instead of through `Agent`. */
  function composed(mock: MockChatClient, store: ApprovalStateStore): ChatClient<ChatOptions> {
    return withToolApproval(withFunctionInvocation(mock), store);
  }

  /** A model that gates the same call id twice, then finishes. */
  function reusingModel(): MockChatClient {
    return new MockChatClient([
      { contents: [valued('reused', 'gated', 'first')], finishReason: 'tool_calls' },
      { contents: [valued('reused', 'gated', 'second')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);
  }

  it('executes a later approval whose call id an earlier completed call already used', async () => {
    const executed: string[] = [];
    const agent = new Agent({ client: reusingModel(), tools: [recordingGate(executed)] });
    const session = agent.createSession();

    const first = await agent.run('go', { session });
    const firstRequest = approvals(first)[0];
    assert.exists(firstRequest);

    const second = await agent.run(approvalResponse(firstRequest, true), { session });
    const secondRequest = approvals(second)[0];
    assert.exists(secondRequest);
    // Same id, because a local request id is derived from the call id.
    expect(secondRequest.id).toBe(firstRequest.id);
    expect(secondRequest.functionCall.arguments).toBe('{"value":"second"}');

    const third = await agent.run(approvalResponse(secondRequest, true), { session });
    expect(executed).toEqual(['first', 'second']);
    expect(third.text).toBe('done');
  });

  it('executes a reused call id whose later occurrence names a different tool', async () => {
    const executed: string[] = [];
    const mock = new MockChatClient([
      { contents: [valued('reused', 'gated', 'first')], finishReason: 'tool_calls' },
      { contents: [valued('reused', 'other_gate', 'second')], finishReason: 'tool_calls' },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);
    const agent = new Agent({
      client: mock,
      tools: [recordingGate(executed), recordingGate(executed, 'other_gate')],
    });
    const session = agent.createSession();

    const first = await agent.run('go', { session });
    const firstRequest = approvals(first)[0];
    assert.exists(firstRequest);
    const second = await agent.run(approvalResponse(firstRequest, true), { session });
    const secondRequest = approvals(second)[0];
    assert.exists(secondRequest);
    expect(secondRequest.functionCall.name).toBe('other_gate');

    await agent.run(approvalResponse(secondRequest, true), { session });
    expect(executed).toEqual(['first', 'second']);
  });

  it('does not let the completed occurrence decision authorize the reused call id', async () => {
    const executed: string[] = [];
    const agent = new Agent({ client: reusingModel(), tools: [recordingGate(executed)] });
    const session = agent.createSession();

    const first = await agent.run('go', { session });
    const firstRequest = approvals(first)[0];
    assert.exists(firstRequest);
    await agent.run(approvalResponse(firstRequest, true), { session });

    // No new decision. The transcript still replays the one that authorized the completed
    // occurrence, and it names the same request id as the occurrence now waiting for a human.
    const third = await agent.run('anything else?', { session });
    expect(executed).toEqual(['first']);
    expect(approvals(third).map((request) => request.functionCall.arguments)).toEqual(['{"value":"second"}']);

    const resurfaced = approvals(third)[0];
    assert.exists(resurfaced);
    await agent.run(approvalResponse(resurfaced, true), { session });
    expect(executed).toEqual(['first', 'second']);
  });

  it('keeps an unanswered stored request through a turn that carries no decision', async () => {
    const executed: string[] = [];
    const session = new AgentSession();
    const store = sessionApprovalStore(session);
    const request = functionApprovalRequestContent(valued('reused', 'gated', 'second'));
    store.addPending([request]);
    const mock = new MockChatClient([{ contents: [textContent('nothing to do')], finishReason: 'stop' }]);

    await composed(mock, store).getResponse(
      [
        { role: 'assistant', contents: [valued('reused', 'gated', 'first')] },
        { role: 'tool', contents: [{ type: 'function_result', callId: 'reused', result: 'ran first' }] },
        { role: 'user', contents: [textContent('anything else?')] },
      ],
      { tools: [recordingGate(executed)] },
    );

    expect(executed).toEqual([]);
    expect(session.state._toolApproval).toEqual({ pending: [request] });
  });

  it('writes every unanswered request back into a destructively read store', async () => {
    const executed: string[] = [];
    const reads: number[] = [];
    let pending: FunctionApprovalRequestContent[] = [];
    let autoApproved: FunctionApprovalRequestContent[] = [];
    const store: ApprovalStateStore = {
      takePending(): FunctionApprovalRequestContent[] {
        reads.push(pending.length);
        const taken = pending;
        pending = [];
        return taken;
      },
      addPending(requests: readonly FunctionApprovalRequestContent[]): void {
        for (const request of requests) {
          if (!pending.some((known) => known.id === request.id)) {
            pending.push(request);
          }
        }
      },
      takeAutoApproved(): FunctionApprovalRequestContent[] {
        const taken = autoApproved;
        autoApproved = [];
        return taken;
      },
      setAutoApproved(requests: readonly FunctionApprovalRequestContent[]): void {
        autoApproved = [...requests];
      },
    };
    const answered = functionApprovalRequestContent(valued('c1', 'gated', 'one'));
    const unanswered = functionApprovalRequestContent(valued('c2', 'gated', 'two'));
    store.addPending([answered, unanswered]);
    const mock = new MockChatClient([{ contents: [textContent('done')], finishReason: 'stop' }]);

    await composed(mock, store).getResponse(
      [
        // `c2` was used by an older call that already completed, so the transcript carries a
        // result for it while the request the human still owes an answer to is only in the store.
        { role: 'assistant', contents: [valued('c2', 'gated', 'older')] },
        { role: 'tool', contents: [{ type: 'function_result', callId: 'c2', result: 'ran older' }] },
        { role: 'user', contents: [approvalResponse(answered, true)] },
      ],
      { tools: [recordingGate(executed)] },
    );

    expect(reads.length).toBeGreaterThan(0);
    expect(executed).toEqual(['one']);
    expect(pending.map((request) => request.id)).toEqual([unanswered.id]);
  });

  it('coalesces replayed copies of one still-open request into a single execution', async () => {
    const executed: string[] = [];
    const session = new AgentSession();
    const store = sessionApprovalStore(session);
    const request = functionApprovalRequestContent(valued('c1', 'gated', 'only'));
    store.addPending([request]);
    const mock = new MockChatClient([{ contents: [textContent('done')], finishReason: 'stop' }]);

    await composed(mock, store).getResponse(
      [
        { role: 'assistant', contents: [request] },
        { role: 'assistant', contents: [request] },
        { role: 'user', contents: [approvalResponse(request, true)] },
      ],
      { tools: [recordingGate(executed)] },
    );

    expect(executed).toEqual(['only']);
    expect(session.state._toolApproval).toBeUndefined();
  });

  it('keeps the first copy canonical when a replay doctors a still-open request', async () => {
    const executed: string[] = [];
    // Nothing in the store: the transcript is the only record, so the copy the caller replays
    // first is the one the decision has to bind against.
    const store = sessionApprovalStore(new AgentSession());
    const request = functionApprovalRequestContent(valued('c1', 'gated', 'safe'));
    const doctored: FunctionApprovalRequestContent = {
      ...request,
      functionCall: valued('c1', 'gated', 'everything'),
    };
    const mock = new MockChatClient([{ contents: [textContent('done')], finishReason: 'stop' }]);

    await composed(mock, store).getResponse(
      [
        { role: 'assistant', contents: [request] },
        { role: 'assistant', contents: [doctored] },
        { role: 'user', contents: [approvalResponse(doctored, true)] },
      ],
      { tools: [recordingGate(executed)] },
    );

    expect(executed).toEqual(['safe']);
  });

  it('resumes a reused call id in a service-managed session', async () => {
    // The service owns the transcript, so history is never replayed: every occurrence is known
    // only from the store, and the decision arrives with nothing beside it.
    const executed: string[] = [];
    const agent = new Agent({ client: reusingModel(), tools: [recordingGate(executed)] });
    const session = agent.createSession({ serviceSessionId: 'conv_1' });

    const first = await agent.run('go', { session });
    const firstRequest = approvals(first)[0];
    assert.exists(firstRequest);
    const second = await agent.run(approvalResponse(firstRequest, true), { session });
    const secondRequest = approvals(second)[0];
    assert.exists(secondRequest);

    const third = await agent.run(approvalResponse(secondRequest, true), { session });
    expect(executed).toEqual(['first', 'second']);
    expect(third.text).toBe('done');
  });

  it('binds a batch of decisions whatever order they arrive in', async () => {
    const executed: string[] = [];
    const mock = new MockChatClient([
      {
        contents: [valued('c1', 'gated', 'first'), valued('c2', 'gated', 'second')],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client: mock, tools: [recordingGate(executed)] });
    const session = agent.createSession();

    const first = await agent.run('do both', { session });
    const [one, two] = approvals(first);
    assert.exists(one);
    assert.exists(two);

    const resumed = await agent.run([approvalResponse(two, true), approvalResponse(one, true)], {
      session,
    });
    expect([...executed].sort()).toEqual(['first', 'second']);
    expect(resumed.text).toBe('done');
  });

  it('re-surfaces only the unanswered remainder when an older result reuses a batch call id', async () => {
    const executed: string[] = [];
    const mock = new MockChatClient([
      {
        contents: [valued('c1', 'gated', 'first'), valued('c2', 'gated', 'second')],
        finishReason: 'tool_calls',
      },
      { contents: [textContent('done')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client: mock, tools: [recordingGate(executed)] });
    const session = agent.createSession();

    // An older, completed call already used `c2`, so the transcript carries a result for it
    // before the batch that is waiting for a human.
    const first = await agent.run(
      [
        { role: 'assistant', contents: [valued('c2', 'gated', 'older')] },
        { role: 'tool', contents: [{ type: 'function_result', callId: 'c2', result: 'ran older' }] },
        { role: 'user', contents: [textContent('do both')] },
      ],
      { session },
    );
    const [one, two] = approvals(first);
    assert.exists(one);
    assert.exists(two);

    const partial = await agent.run(approvalResponse(one, true), { session });
    expect(executed).toEqual(['first']);
    expect(approvals(partial).map((request) => request.functionCall.callId)).toEqual(['c2']);

    const resumed = await agent.run(approvalResponse(two, true), { session });
    expect(executed).toEqual(['first', 'second']);
    expect(resumed.text).toBe('done');
  });

  it('resumes a reused call id across a serialized session', async () => {
    const executed: string[] = [];
    const agent = new Agent({ client: reusingModel(), tools: [recordingGate(executed)] });
    const session = agent.createSession();

    const first = await agent.run('go', { session });
    const firstRequest = approvals(first)[0];
    assert.exists(firstRequest);
    const second = await agent.run(approvalResponse(firstRequest, true), { session });
    const secondRequest = approvals(second)[0];
    assert.exists(secondRequest);

    const serialized = JSON.parse(JSON.stringify(session)) as { state: Record<string, unknown> };
    // Deep equality, so a transcript index, message position or turn number added to the record
    // would fail here: occurrence boundaries are re-derived from the input transcript instead.
    expect(serialized.state._toolApproval).toEqual({
      pending: [
        {
          type: 'function_approval_request',
          id: 'ficc_reused',
          userInputRequest: true,
          functionCall: {
            type: 'function_call',
            callId: 'reused',
            name: 'gated',
            arguments: '{"value":"second"}',
          },
        },
      ],
    });

    const restored = AgentSession.fromJSON(serialized);
    const third = await agent.run(approvalResponse(secondRequest, true), { session: restored });
    expect(executed).toEqual(['first', 'second']);
    expect(third.text).toBe('done');
  });

  it('honours a decision that a replayed copy of its own still-open request follows', async () => {
    const executed: string[] = [];
    const session = new AgentSession();
    const store = sessionApprovalStore(session);
    const request = functionApprovalRequestContent(valued('c1', 'gated', 'only'));
    store.addPending([request]);
    const mock = new MockChatClient([{ contents: [textContent('done')], finishReason: 'stop' }]);

    // A caller that rebuilds the transcript can put the request back after the decision that
    // answered it. No result separates the copies, so both are the same open occurrence: the
    // decision still settles it, and the human is not asked again for what they just granted.
    await composed(mock, store).getResponse(
      [
        { role: 'assistant', contents: [request] },
        { role: 'user', contents: [approvalResponse(request, true)] },
        { role: 'assistant', contents: [request] },
      ],
      { tools: [recordingGate(executed)] },
    );

    expect(executed).toEqual(['only']);
    expect(session.state._toolApproval).toBeUndefined();
  });
});

describe('approval resume for a call carrying no arguments', () => {
  /**
   * A `function_call` as another implementation serialized it: `arguments` omitted — Python drops
   * the field when it is `None` — or written out as a literal `null`.
   */
  function wireCall(fields: Record<string, unknown>): FunctionCallContent {
    return deserializeContent({
      type: 'function_call',
      callId: 'c1',
      name: 'sweep',
      ...fields,
    }) as FunctionCallContent;
  }

  const nullish: Array<[label: string, fields: Record<string, unknown>]> = [
    ['omitted', {}],
    ['native null', { arguments: null }],
  ];

  /** The `function_call` of the single pending approval inside a serialized session. */
  function storedCall(wire: unknown): Record<string, unknown> {
    const state = (wire as { state: Record<string, unknown> }).state;
    const partition = state._toolApproval as { pending: Array<{ functionCall: Record<string, unknown> }> };
    const first = partition.pending[0];
    assert.exists(first);
    return first.functionCall;
  }

  it.each(nullish)(
    'executes a call whose arguments are %s after suspend, serialize, restore and resume',
    async (_label, fields) => {
      const seen: unknown[] = [];
      const sweep = tool({
        name: 'sweep',
        description: 'Sweep everything',
        parameters: { type: 'object', properties: { scope: { type: 'string' } } },
        approvalMode: 'always_require',
        execute: async (input) => {
          seen.push(input);
          return 'swept';
        },
      });
      const mock = new MockChatClient([
        { contents: [wireCall(fields)], finishReason: 'tool_calls' },
        { contents: [textContent('done')], finishReason: 'stop' },
      ]);
      const agent = new Agent({ client: mock, tools: [sweep] });
      const session = agent.createSession();

      const request = approvals(await agent.run('sweep', { session }))[0];
      assert.exists(request);
      expect(seen).toEqual([]);

      // The human answers in another process, so only the serialized session bridges the turns.
      const wire = JSON.parse(JSON.stringify(session)) as unknown;
      // What the session persisted is the wire shape the provider reported, not a normalized copy.
      expect(Object.hasOwn(storedCall(wire), 'arguments')).toBe('arguments' in fields);
      expect(storedCall(wire).arguments).toBe(fields.arguments as undefined);

      const resumed = await agent.run(approvalResponse(request, true), {
        session: AgentSession.fromJSON(wire),
      });

      expect(seen).toEqual([{}]);
      expect(results(resumed.messages)).toEqual([['c1', 'swept']]);
      // The request the caller still holds was never rewritten either.
      expect(request.functionCall.arguments).toBe(fields.arguments as undefined);
    },
  );
});
