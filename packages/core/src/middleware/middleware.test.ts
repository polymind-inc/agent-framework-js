import { describe, expect, it } from 'vitest';
import { Agent } from '../agent/agent.js';
import type { ChatOptions } from '../client/chat-client.js';
import { MockChatClient } from '../client/test-support.js';
import type { ContextProvider } from '../context/context-provider.js';
import { ConfigurationError } from '../errors.js';
import { approvalResponse } from '../tools/approval.js';
import { supportsMCP, supportsWebSearch } from '../tools/hosted.js';
import { tool } from '../tools/tool.js';
import { textContent } from '../types/content.js';
import type { AgentResponse, AgentResponseUpdate } from '../types/response.js';
import { agentResponse, agentResponseUpdate } from '../types/response.js';
import { agentMiddleware, categorizeMiddleware, functionMiddleware, withMiddleware } from './middleware.js';
import { toolApprovalMiddleware } from './tool-approval-middleware.js';

function client(...texts: string[]): MockChatClient {
  return new MockChatClient(texts.map((text) => ({ contents: [textContent(text)], finishReason: 'stop' })));
}

function callingClient(name: string, args: Record<string, unknown>, then: string): MockChatClient {
  return new MockChatClient([
    { contents: [{ type: 'function_call', callId: 'call_1', name, arguments: args }] },
    { contents: [textContent(then)], finishReason: 'stop' },
  ]);
}

const echo = tool({
  name: 'echo',
  description: 'Echoes its input',
  parameters: { type: 'object', properties: { value: { type: 'string' } } },
  execute: (({ value }: { value: string }) => `echo:${value}`) as never,
});

describe('categorizeMiddleware', () => {
  it('splits by kind and keeps registration order', () => {
    const a1 = agentMiddleware(async (_ctx, next) => next());
    const a2 = agentMiddleware(async (_ctx, next) => next());
    const f1 = functionMiddleware(async (_ctx, next) => next());
    const result = categorizeMiddleware([a1, f1], undefined, [a2]);
    expect(result.agent).toEqual([a1, a2]);
    expect(result.function).toEqual([f1]);
  });

  it('rejects a bare function, since the kind cannot be inferred at runtime', () => {
    expect(() => categorizeMiddleware([(): void => {}])).toThrow(ConfigurationError);
  });
});

describe('agent middleware', () => {
  it('runs as an onion in registration order', async () => {
    const order: string[] = [];
    const outer = agentMiddleware(async (_ctx, next) => {
      order.push('outer:before');
      await next();
      order.push('outer:after');
    });
    const inner = agentMiddleware(async (_ctx, next) => {
      order.push('inner:before');
      await next();
      order.push('inner:after');
    });
    const agent = new Agent({ client: client('hi'), middleware: [outer, inner] });

    await agent.run('x');

    expect(order).toEqual(['outer:before', 'inner:before', 'inner:after', 'outer:after']);
  });

  it('applies run-level middleware inside the agent-level ones', async () => {
    const order: string[] = [];
    const construct = agentMiddleware(async (_ctx, next) => {
      order.push('construct');
      await next();
    });
    const perRun = agentMiddleware(async (_ctx, next) => {
      order.push('run');
      await next();
    });
    const agent = new Agent({ client: client('hi'), middleware: [construct] });

    await agent.run('x', { middleware: [perRun] });

    expect(order).toEqual(['construct', 'run']);
  });

  it('collects middleware from the chat client and from context providers', async () => {
    const seen: string[] = [];
    const fromClient = agentMiddleware(async (_ctx, next) => {
      seen.push('client');
      await next();
    });
    const fromProvider = agentMiddleware(async (_ctx, next) => {
      seen.push('provider');
      await next();
    });
    const provider: ContextProvider = { sourceId: 'memory', middleware: [fromProvider] };
    const agent = new Agent({
      client: withMiddleware(client('hi'), [fromClient]),
      contextProviders: [provider],
    });

    await agent.run('x');

    expect(seen).toEqual(['provider', 'client']);
  });

  it('short-circuits the run when a middleware sets a response', async () => {
    const mock = client('never used');
    const canned = agentMiddleware(async (ctx) => {
      ctx.response = agentResponse({
        messages: [{ role: 'assistant', contents: [textContent('cached')] }],
      });
    });
    const agent = new Agent({ client: mock, middleware: [canned] });

    const response = await agent.run('x');

    expect(response.text).toBe('cached');
    expect(mock.callCount).toBe(0);
  });

  it('observes and replaces the response of an awaited run', async () => {
    let observed: string | undefined;
    const rewrite = agentMiddleware(async (ctx, next) => {
      await next();
      observed = ctx.response?.text;
      ctx.response = agentResponse({
        messages: [{ role: 'assistant', contents: [textContent('rewritten')] }],
      });
    });
    const agent = new Agent({ client: client('original'), middleware: [rewrite] });

    const response = await agent.run('x');

    expect(observed).toBe('original');
    expect(response.text).toBe('rewritten');
  });

  it('ends the run without an error when a middleware terminates', async () => {
    const mock = client('never used');
    const blocked = agentMiddleware(async (ctx) => {
      ctx.terminate(agentResponse({ messages: [{ role: 'assistant', contents: [textContent('refused')] }] }));
    });
    const agent = new Agent({ client: mock, middleware: [blocked] });

    const response = await agent.run('x');

    expect(response.text).toBe('refused');
    expect(mock.callCount).toBe(0);
  });

  it('returns an empty response when a middleware terminates without one', async () => {
    const agent = new Agent({
      client: client('never used'),
      middleware: [agentMiddleware(async (ctx) => ctx.terminate())],
    });

    const response = await agent.run('x');

    expect(response.messages).toEqual([]);
    expect(response.text).toBe('');
  });

  it('skips the rest of the chain when an outer middleware terminates', async () => {
    const reached: string[] = [];
    const stop = agentMiddleware(async (ctx, next) => {
      await next();
      reached.push('outer:after');
      ctx.terminate(ctx.response);
    });
    const innerMw = agentMiddleware(async (_ctx, next) => {
      reached.push('inner');
      await next();
    });
    const agent = new Agent({ client: client('done'), middleware: [stop, innerMw] });

    const response = await agent.run('x');

    expect(reached).toEqual(['inner', 'outer:after']);
    expect(response.text).toBe('done');
  });

  it('rewrites the input messages seen by the client', async () => {
    const mock = client('ok');
    const inject = agentMiddleware(async (ctx, next) => {
      ctx.messages = [{ role: 'user', contents: [textContent('rewritten input')] }];
      await next();
    });
    const agent = new Agent({ client: mock, middleware: [inject] });

    await agent.run('original input');

    const sent = mock.calls[0]?.messages ?? [];
    expect(sent.at(-1)?.contents[0]).toMatchObject({ type: 'text', text: 'rewritten input' });
  });

  it('adds tools and chat options for the run', async () => {
    const mock = client('ok');
    const configure = agentMiddleware(async (ctx, next) => {
      ctx.tools.push(echo);
      ctx.options.temperature = 0.1;
      await next();
    });
    const agent = new Agent({ client: mock, middleware: [configure] });

    await agent.run('x');

    const options = mock.calls[0]?.options as ChatOptions;
    expect(options.tools).toContain(echo);
    expect(options.temperature).toBe(0.1);
  });

  it('reports the consumption mode on ctx.stream', async () => {
    const modes: boolean[] = [];
    const record = agentMiddleware(async (ctx, next) => {
      modes.push(ctx.stream);
      await next();
    });
    const agent = new Agent({ client: client('a', 'b'), middleware: [record] });

    await agent.run('x');
    for await (const _update of agent.run('y')) {
      // drain
    }

    expect(modes).toEqual([false, true]);
  });

  it('transforms streamed updates without changing the folded result', async () => {
    const shout = agentMiddleware(async (ctx, next) => {
      ctx.onUpdate((update: AgentResponseUpdate) =>
        agentResponseUpdate({ ...update, contents: [textContent(update.text.toUpperCase())] }),
      );
      await next();
    });
    const agent = new Agent({ client: client('quiet'), middleware: [shout] });

    const stream = agent.run('x');
    const seen: string[] = [];
    for await (const update of stream) {
      seen.push(update.text);
    }

    expect(seen).toEqual(['QUIET']);
    expect((await stream.finalResponse()).text).toBe('quiet');
  });

  it('transforms the folded result of a streamed run', async () => {
    const suffix = agentMiddleware(async (ctx, next) => {
      ctx.onResult((response: AgentResponse<unknown>) =>
        agentResponse({
          messages: [...response.messages, { role: 'assistant', contents: [textContent('!')] }],
        }),
      );
      await next();
    });
    const agent = new Agent({ client: client('hey'), middleware: [suffix] });

    const stream = agent.run('x');
    for await (const _update of stream) {
      // drain
    }

    expect((await stream.finalResponse()).text).toBe('hey!');
  });

  it('streams the updates of a response a middleware supplied', async () => {
    const canned = agentMiddleware(async (ctx) => {
      ctx.response = agentResponse({
        messages: [{ role: 'assistant', contents: [textContent('from cache')] }],
      });
    });
    const agent = new Agent({ client: client('never used'), middleware: [canned] });

    const seen: string[] = [];
    for await (const update of agent.run('x')) {
      seen.push(update.text);
    }

    expect(seen).toEqual(['from cache']);
  });

  it('shares metadata between middleware of the same run', async () => {
    let read: unknown;
    const write = agentMiddleware(async (ctx, next) => {
      ctx.metadata.trace = 'abc';
      await next();
    });
    const readBack = agentMiddleware(async (ctx, next) => {
      read = ctx.metadata.trace;
      await next();
    });
    const agent = new Agent({ client: client('hi'), middleware: [write, readBack] });

    await agent.run('x');

    expect(read).toBe('abc');
  });

  it('lets errors out of the run', async () => {
    const failing = agentMiddleware(() => {
      throw new Error('boom');
    });
    const agent = new Agent({ client: client('hi'), middleware: [failing] });

    await expect(agent.run('x')).rejects.toThrow('boom');
  });

  it('refuses a middleware that continues the chain twice', async () => {
    const twice = agentMiddleware(async (_ctx, next) => {
      await next();
      await next();
    });
    const agent = new Agent({ client: client('hi'), middleware: [twice] });

    await expect(agent.run('x')).rejects.toThrow(ConfigurationError);
  });

  it('sees the session the run will use', async () => {
    let seen: string | undefined;
    const inspect = agentMiddleware(async (ctx, next) => {
      seen = ctx.session.sessionId;
      ctx.session.state.visits = 1;
      await next();
    });
    const agent = new Agent({ client: client('hi'), middleware: [inspect] });
    const session = agent.createSession();

    await agent.run('x', { session });

    expect(seen).toBe(session.sessionId);
    expect(session.state.visits).toBe(1);
  });
});

describe('function middleware', () => {
  it('wraps the tool invocation', async () => {
    const order: string[] = [];
    const trace = functionMiddleware(async (ctx, next) => {
      order.push(`before:${ctx.tool.name}`);
      await next();
      order.push(`after:${String(ctx.result)}`);
    });
    const agent = new Agent({
      client: callingClient('echo', { value: 'hi' }, 'done'),
      tools: [echo],
      middleware: [trace],
    });

    await agent.run('x');

    expect(order).toEqual(['before:echo', 'after:echo:hi']);
  });

  it('sees validated arguments and can rewrite them', async () => {
    const rewrite = functionMiddleware(async (ctx, next) => {
      ctx.arguments = { value: 'replaced' };
      await next();
    });
    const agent = new Agent({
      client: callingClient('echo', { value: 'original' }, 'done'),
      tools: [echo],
      middleware: [rewrite],
    });

    const response = await agent.run('x');

    const results = response.messages
      .flatMap((msg) => msg.contents)
      .filter((c) => c.type === 'function_result');
    expect(results[0]).toMatchObject({ result: 'echo:replaced' });
  });

  it('answers for the tool when it sets a result without continuing', async () => {
    let ran = false;
    const cached = tool({
      name: 'echo',
      description: 'Echoes its input',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
      execute: () => {
        ran = true;
        return 'from tool';
      },
    });
    const short = functionMiddleware((ctx) => {
      ctx.result = 'from middleware';
    });
    const agent = new Agent({
      client: callingClient('echo', { value: 'hi' }, 'done'),
      tools: [cached],
      middleware: [short],
    });

    const response = await agent.run('x');

    expect(ran).toBe(false);
    const results = response.messages
      .flatMap((msg) => msg.contents)
      .filter((c) => c.type === 'function_result');
    expect(results[0]).toMatchObject({ result: 'from middleware' });
  });

  it('recovers from a failing tool by supplying a result', async () => {
    const failing = tool({
      name: 'echo',
      description: 'Always fails',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
      execute: () => {
        throw new Error('tool exploded');
      },
    });
    const recover = functionMiddleware(async (ctx, next) => {
      await next();
      if (ctx.error !== undefined) {
        ctx.result = 'recovered';
        ctx.error = undefined;
      }
    });
    const agent = new Agent({
      client: callingClient('echo', { value: 'hi' }, 'done'),
      tools: [failing],
      middleware: [recover],
    });

    const response = await agent.run('x');

    const results = response.messages
      .flatMap((msg) => msg.contents)
      .filter((c) => c.type === 'function_result');
    expect(results[0]).toMatchObject({ result: 'recovered' });
    expect(results[0]).not.toHaveProperty('exception');
  });

  it('stops the loop when a middleware terminates', async () => {
    const mock = callingClient('echo', { value: 'hi' }, 'second turn');
    const stop = functionMiddleware((ctx) => ctx.terminate('halted'));
    const agent = new Agent({ client: mock, tools: [echo], middleware: [stop] });

    const response = await agent.run('x');

    // One model call only: the tool result is reported, but the model never gets to answer it.
    expect(mock.callCount).toBe(1);
    const results = response.messages
      .flatMap((msg) => msg.contents)
      .filter((c) => c.type === 'function_result');
    expect(results[0]).toMatchObject({ result: 'halted' });
  });

  it('receives the run session', async () => {
    let seen: string | undefined;
    const inspect = functionMiddleware(async (ctx, next) => {
      seen = ctx.session?.sessionId;
      await next();
    });
    const agent = new Agent({
      client: callingClient('echo', { value: 'hi' }, 'done'),
      tools: [echo],
      middleware: [inspect],
    });
    const session = agent.createSession();

    await agent.run('x', { session });

    expect(seen).toBe(session.sessionId);
  });

  it('never reaches the provider through the chat options', async () => {
    const mock = callingClient('echo', { value: 'hi' }, 'done');
    const agent = new Agent({
      client: mock,
      tools: [echo],
      middleware: [functionMiddleware(async (_ctx, next) => next())],
    });

    await agent.run('x');

    for (const call of mock.calls) {
      expect(Object.getOwnPropertySymbols(call.options ?? {})).toEqual([]);
    }
  });
});

describe('toolApprovalMiddleware', () => {
  const transfer = tool({
    name: 'transfer',
    description: 'Transfers money',
    parameters: { type: 'object', properties: { amount: { type: 'number' } } },
    execute: (({ amount }: { amount: number }) => `sent ${amount}`) as never,
  });

  it('surfaces a matching call for approval instead of running it', async () => {
    const mock = callingClient('transfer', { amount: 500 }, 'done');
    const agent = new Agent({
      client: mock,
      tools: [transfer],
      middleware: [toolApprovalMiddleware([{ tools: 'transfer', reason: 'Irreversible' }])],
    });

    const response = await agent.run('send money', { session: agent.createSession() });

    expect(response.userInputRequests).toHaveLength(1);
    expect(response.userInputRequests[0]).toMatchObject({
      type: 'function_approval_request',
      additionalProperties: { requiredByMiddleware: true, reason: 'Irreversible' },
    });
    expect(mock.callCount).toBe(1);
  });

  it('executes the call once a human approves it, without asking again', async () => {
    const agent = new Agent({
      client: new MockChatClient([
        {
          contents: [
            { type: 'function_call', callId: 'call_1', name: 'transfer', arguments: { amount: 500 } },
          ],
        },
        { contents: [textContent('sent')], finishReason: 'stop' },
      ]),
      tools: [transfer],
      middleware: [toolApprovalMiddleware([{ tools: 'transfer' }])],
    });
    const session = agent.createSession();

    const first = await agent.run('send money', { session });
    const request = first.userInputRequests[0];
    const resumed = await agent.run(approvalResponse(request as never, true), { session });

    const results = resumed.messages
      .flatMap((msg) => msg.contents)
      .filter((c) => c.type === 'function_result');
    expect(results[0]).toMatchObject({ result: 'sent 500' });
    expect(resumed.userInputRequests).toHaveLength(0);
  });

  it('sends the approved call to the provider exactly once (no duplicate call id)', async () => {
    // Unlike `approvalMode: 'always_require'` (which buffers and strips the raw call before the
    // caller sees it), a middleware-deferred round flushes the raw `function_call` first and only
    // then surfaces the approval request. The resume turn re-materializes the decided call, so the
    // replayed raw call must be dropped — otherwise the wire history carries the same call id
    // twice and a stateless-replay provider rejects the request.
    const mock = new MockChatClient([
      {
        contents: [{ type: 'function_call', callId: 'call_1', name: 'transfer', arguments: { amount: 500 } }],
      },
      { contents: [textContent('sent')], finishReason: 'stop' },
    ]);
    const agent = new Agent({
      client: mock,
      tools: [transfer],
      middleware: [toolApprovalMiddleware([{ tools: 'transfer' }])],
    });
    const session = agent.createSession();

    const first = await agent.run('send money', { session });
    await agent.run(approvalResponse(first.userInputRequests[0] as never, true), { session });

    const secondTurnCalls = mock.calls[1]?.messages
      .flatMap((msg) => msg.contents)
      .filter((c) => c.type === 'function_call')
      .map((c) => c.callId);
    expect(secondTurnCalls).toEqual(['call_1']);
    const secondTurnResults = mock.calls[1]?.messages
      .flatMap((msg) => msg.contents)
      .filter((c) => c.type === 'function_result')
      .map((c) => c.callId);
    expect(secondTurnResults).toEqual(['call_1']);
    // Approval control content never reaches the provider either.
    const types = mock.calls[1]?.messages.flatMap((msg) => msg.contents.map((c) => c.type));
    expect(types).not.toContain('function_approval_request');
    expect(types).not.toContain('function_approval_response');
  });

  it('keeps the wrapped client hosted-tool capabilities visible through withMiddleware', () => {
    const capable = Object.assign(new MockChatClient([{ contents: [textContent('x')] }]), {
      getMCPTool: (options: { serverLabel: string }) => ({
        kind: 'hosted' as const,
        name: 'mcp',
        spec: { server_label: options.serverLabel },
      }),
    });
    const wrapped = withMiddleware(capable, []);
    expect(supportsMCP(wrapped)).toBe(true);
    expect(supportsMCP(wrapped) && wrapped.getMCPTool({ serverLabel: 'docs' }).spec).toEqual({
      server_label: 'docs',
    });
    expect(supportsWebSearch(wrapped)).toBe(false);
  });

  it('lets an earlier allow rule win over a later require rule', async () => {
    const agent = new Agent({
      client: callingClient('transfer', { amount: 5 }, 'done'),
      tools: [transfer],
      middleware: [
        toolApprovalMiddleware([
          {
            tools: 'transfer',
            when: ({ arguments: args }) => (args as { amount: number }).amount < 100,
            decision: 'allow',
          },
          { tools: 'transfer' },
        ]),
      ],
    });

    const response = await agent.run('send a little', { session: agent.createSession() });

    expect(response.userInputRequests).toHaveLength(0);
    const results = response.messages
      .flatMap((msg) => msg.contents)
      .filter((c) => c.type === 'function_result');
    expect(results[0]).toMatchObject({ result: 'sent 5' });
  });

  it('leaves calls no rule matches alone', async () => {
    const agent = new Agent({
      client: callingClient('echo', { value: 'hi' }, 'done'),
      tools: [echo],
      middleware: [toolApprovalMiddleware([{ tools: 'transfer' }])],
    });

    const response = await agent.run('x', { session: agent.createSession() });

    expect(response.userInputRequests).toHaveLength(0);
  });
});
