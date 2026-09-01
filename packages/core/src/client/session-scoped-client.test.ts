/**
 * The {@link SessionScopedChatClient} capability: a provider asking for a view of itself bound to
 * the run's session.
 *
 * What the tests pin is where that view sits — around every service call of the run, on both
 * consumption modes, with the run's own session and nobody else's.
 */
import { describe, expect, it } from 'vitest';
import { Agent } from '../agent/agent.js';
import type { AgentSession } from '../agent/session.js';
import { functionMiddleware, tool, withMiddleware } from '../index.js';
import { textContent } from '../types/content.js';
import type { ChatClient, ChatOptions, ChatResponseStream, SessionScopedChatClient } from './chat-client.js';
import { MockChatClient } from './test-support.js';

const echo = tool({
  name: 'echo',
  description: 'Echoes',
  parameters: { type: 'object', properties: {} },
  execute: () => 'ok',
});

/** Two rounds: a tool call, then an answer. Needs `echo` registered, or the call goes unanswered. */
function twoRounds(): ConstructorParameters<typeof MockChatClient>[0] {
  return [
    {
      contents: [{ type: 'function_call', callId: 'c1', name: 'echo', arguments: '{}' }],
      finishReason: 'tool_calls',
    },
    { contents: [textContent('done')], finishReason: 'stop' },
  ];
}

/** One round, for the tests that are about runs rather than about rounds. */
function oneRound(): ConstructorParameters<typeof MockChatClient>[0] {
  return [{ contents: [textContent('done')], finishReason: 'stop' }];
}

/**
 * A client that stamps a per-session counter onto every request it makes.
 *
 * Stands in for a provider whose service hands back an identifier the session has to keep: the
 * value lives on the session, the wrapper is an ordinary client, and nothing is held on `this`.
 */
class StampingClient extends MockChatClient implements SessionScopedChatClient<ChatOptions> {
  /** Every `ticket` value seen on an outgoing request, in order, across all sessions. */
  readonly stamps: (string | undefined)[] = [];
  /** Sessions this client was asked to bind to, in order. */
  readonly bound: AgentSession[] = [];

  forSession(session: AgentSession): ChatClient<ChatOptions> {
    this.bound.push(session);
    return {
      metadata: this.metadata,
      getResponse: (messages, options): ChatResponseStream<unknown> => {
        const held = session.state.ticket;
        this.stamps.push(typeof held === 'string' ? held : undefined);
        // Copy, never mutate what the caller handed over.
        const next = {
          ...options,
          additionalProperties: { ...options?.additionalProperties, ticket: held },
        } as ChatOptions & { signal?: AbortSignal };
        const stream = this.getResponse(messages, next);
        // What a service that mints the value on the first call would leave behind.
        session.state.ticket ??= `ticket-${session.sessionId}`;
        return stream;
      },
    };
  }
}

describe('SessionScopedChatClient', () => {
  it('binds once per run and wraps every round of it', async () => {
    const client = new StampingClient(twoRounds());
    const agent = new Agent({ client, tools: [echo] });
    const session = agent.createSession({ sessionId: 's1' });

    await agent.run('go', { session });

    // One binding for the run, one stamp per service call.
    expect(client.bound).toHaveLength(1);
    // Round one had nothing yet; round two carries what round one left on the session — the case
    // a caller outside the run cannot reach, because the value did not exist when the run started.
    expect(client.stamps).toEqual([undefined, 'ticket-s1']);
  });

  it('wraps every round of an awaited run and a streamed one alike', async () => {
    const streamed = new StampingClient(twoRounds());
    const agent = new Agent({ client: streamed, tools: [echo] });
    const session = agent.createSession({ sessionId: 's2' });

    for await (const _ of agent.run('go', { session })) {
      // drain
    }

    expect(streamed.stamps).toEqual([undefined, 'ticket-s2']);
  });

  it('carries the value into later runs of the same session', async () => {
    const client = new StampingClient(oneRound());
    const agent = new Agent({ client });
    const session = agent.createSession({ sessionId: 's3' });

    await agent.run('one', { session });
    await agent.run('two', { session });

    expect(client.stamps).toEqual([undefined, 'ticket-s3']);
    expect(client.bound).toHaveLength(2);
  });

  it('never lets one session see the value another one holds', async () => {
    const client = new StampingClient(oneRound());
    const agent = new Agent({ client });
    const a = agent.createSession({ sessionId: 'a' });
    const b = agent.createSession({ sessionId: 'b' });

    await agent.run('one', { session: a });
    await agent.run('two', { session: b });

    // `b`'s run starts empty rather than inheriting `a`'s ticket.
    expect(client.stamps).toEqual([undefined, undefined]);
    expect(a.state.ticket).toBe('ticket-a');
    expect(b.state.ticket).toBe('ticket-b');
  });

  it('survives a session round-trip, because the value lives in session state', async () => {
    const client = new StampingClient(oneRound());
    const agent = new Agent({ client });
    const session = agent.createSession({ sessionId: 's4' });

    await agent.run('one', { session });
    const restored = agent.deserializeSession(JSON.parse(JSON.stringify(session)));
    await agent.run('two', { session: restored });

    expect(client.stamps).toEqual([undefined, 'ticket-s4']);
  });

  it('survives being wrapped with withMiddleware, which the agent still collects from', async () => {
    // `withMiddleware` is the documented way to wrap any client, and the agent reads both the
    // middleware and this capability off the client it was handed. A wrapper that carried only the
    // first would turn a session-scoped provider into an ordinary one with nothing to say so.
    const client = new StampingClient(twoRounds());
    const seen: string[] = [];
    const observer = functionMiddleware(async (ctx, next) => {
      seen.push(ctx.tool.name);
      await next();
    });
    const agent = new Agent({ client: withMiddleware(client, [observer]), tools: [echo] });
    const session = agent.createSession({ sessionId: 'w1' });

    await agent.run('go', { session });

    expect(client.stamps).toEqual([undefined, 'ticket-w1']);
    expect(seen).toEqual(['echo']);
  });

  it('leaves a client without the capability on the layer prepared once', async () => {
    const plain = new MockChatClient(twoRounds());
    const agent = new Agent({ client: plain, tools: [echo] });

    const response = await agent.run('go');

    // Nothing to bind, nothing to change: the ordinary path still runs both rounds.
    expect(plain.callCount).toBe(2);
    expect(response.text).toBe('done');
  });

  it('does not mutate the options the caller handed over', async () => {
    const client = new StampingClient(oneRound());
    const agent = new Agent({ client });
    const session = agent.createSession({ sessionId: 's5' });
    const options = { temperature: 0.5 } as Partial<ChatOptions>;

    await agent.run('one', { session, options });
    await agent.run('two', { session, options });

    expect(options).toEqual({ temperature: 0.5 });
  });
});
