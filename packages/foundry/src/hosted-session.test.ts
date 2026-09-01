/**
 * The Foundry hosted-agent session id: sent, captured, and kept for the session that owns it.
 *
 * The id names a Foundry sandbox — compute and a persistent `$HOME` — and is a different thing
 * from the conversation the transcript lives in. The service mints one on the first request that
 * carries none, and hands out a different sandbox for a later request that carries none again, so
 * what these tests pin is *when* the id goes out and *where* it is kept.
 */
import type {
  AgentSession,
  ChatClient,
  ChatClientMetadata,
  ChatResponse,
  ChatResponseStream,
  ChatResponseUpdate,
  Message,
} from '@polymind-inc/agent-framework-core';
import {
  Agent,
  ConfigurationError,
  chatResponse,
  chatResponseToUpdates,
  createResponseStream,
  mergeChatUpdates,
  textContent,
  tool,
} from '@polymind-inc/agent-framework-core';
import type { OpenAIChatOptions } from '@polymind-inc/agent-framework-openai';
import { assert, describe, expect, it } from 'vitest';
import { FOUNDRY_HOSTED_SESSION_STATE_KEY, withHostedSessionId } from './hosted-session.js';

const echo = tool({
  name: 'echo',
  description: 'Echoes',
  parameters: { type: 'object', properties: {} },
  execute: () => 'ok',
});

async function* streamOf<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

/** What one scripted turn answers with. */
interface Turn {
  contents: ChatResponse<unknown>['messages'][number]['contents'];
  /** The `agent_session_id` Foundry reports on this turn's raw payload, if any. */
  reports?: string;
}

/**
 * A Foundry-shaped client: it reports `agent_session_id` on the raw response the way the service
 * does, and records the id each request carried.
 */
class FoundryLikeClient implements ChatClient<OpenAIChatOptions> {
  readonly metadata: ChatClientMetadata = { providerName: 'azure.ai.foundry', modelId: 'gpt-4o' };
  /** The `agent_session_id` on each outgoing request, in order. */
  readonly sent: (string | undefined)[] = [];
  #index = 0;
  readonly #turns: readonly Turn[];

  constructor(turns: readonly Turn[]) {
    this.#turns = turns;
  }

  getResponse(
    _messages: Message[],
    options?: OpenAIChatOptions & { signal?: AbortSignal },
  ): ChatResponseStream<unknown> {
    const carried = options?.additionalProperties?.agent_session_id;
    this.sent.push(typeof carried === 'string' ? carried : undefined);
    const turn = this.#turns[Math.min(this.#index, this.#turns.length - 1)] ?? { contents: [] };
    this.#index++;
    const n = this.sent.length;
    let direct: ChatResponse<unknown> | undefined;
    return createResponseStream<ChatResponseUpdate, ChatResponse<unknown>>({
      start: (ctx) => {
        direct = chatResponse<unknown>({
          messages: [{ role: 'assistant', contents: turn.contents, messageId: `msg_${n}` }],
          responseId: `resp_${n}`,
          finishReason: turn.contents.some((c) => c.type === 'function_call') ? 'tool_calls' : 'stop',
          // The Responses object itself, which is where the service stamps the id.
          rawRepresentation: {
            id: `resp_${n}`,
            ...(turn.reports === undefined ? {} : { agent_session_id: turn.reports }),
          },
        });
        if (!ctx.stream) {
          return streamOf(chatResponseToUpdates(direct));
        }
        // Streaming reports it on the event's `response`, not at the top level.
        return streamOf(
          chatResponseToUpdates(direct).map((update) => ({
            ...update,
            rawRepresentation: {
              type: 'response.completed',
              response: {
                id: `resp_${n}`,
                ...(turn.reports === undefined ? {} : { agent_session_id: turn.reports }),
              },
            },
          })),
        );
      },
      finalize: (updates) => direct ?? mergeChatUpdates<unknown>(updates),
    });
  }

  forSession(session: AgentSession): ChatClient<OpenAIChatOptions> {
    return withHostedSessionId(this, session);
  }
}

/** A tool round followed by an answer; the first turn is where the service mints the id. */
function mintingThenAnswer(id: string): Turn[] {
  return [
    { contents: [{ type: 'function_call', callId: 'c1', name: 'echo', arguments: '{}' }], reports: id },
    { contents: [textContent('done')], reports: id },
  ];
}

describe('the hosted session id on the wire', () => {
  it('sends the id from the round after the service minted it, within one run', async () => {
    // The case no caller-side code can reach: the id does not exist when the run starts.
    const client = new FoundryLikeClient(mintingThenAnswer('sess_1'));
    const agent = new Agent({ client, tools: [echo] });
    const session = agent.createSession();

    await agent.run('go', { session });

    expect(client.sent).toEqual([undefined, 'sess_1']);
    expect(session.state[FOUNDRY_HOSTED_SESSION_STATE_KEY]).toBe('sess_1');
  });

  it('does the same on a streamed run, where the id arrives on the event', async () => {
    const client = new FoundryLikeClient(mintingThenAnswer('sess_2'));
    const agent = new Agent({ client, tools: [echo] });
    const session = agent.createSession();

    for await (const _ of agent.run('go', { session })) {
      // drain
    }

    expect(client.sent).toEqual([undefined, 'sess_2']);
    expect(session.state[FOUNDRY_HOSTED_SESSION_STATE_KEY]).toBe('sess_2');
  });

  it('sends it on every later run of the session', async () => {
    const client = new FoundryLikeClient([{ contents: [textContent('done')], reports: 'sess_3' }]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    await agent.run('one', { session });
    await agent.run('two', { session });

    expect(client.sent).toEqual([undefined, 'sess_3']);
  });

  it('survives serializing and restoring the session', async () => {
    const client = new FoundryLikeClient([{ contents: [textContent('done')], reports: 'sess_4' }]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    await agent.run('one', { session });
    const restored = agent.deserializeSession(JSON.parse(JSON.stringify(session)));
    await agent.run('two', { session: restored });

    expect(client.sent).toEqual([undefined, 'sess_4']);
  });

  it('keeps one session out of another session sandbox', async () => {
    const client = new FoundryLikeClient([{ contents: [textContent('done')], reports: 'sess_a' }]);
    const agent = new Agent({ client });
    const a = agent.createSession();
    const b = agent.createSession();

    await agent.run('one', { session: a });
    await agent.run('two', { session: b });

    // `b` starts without a sandbox rather than borrowing `a`'s.
    expect(client.sent).toEqual([undefined, undefined]);
  });

  it('follows the service to a new sandbox when it reports a different id', async () => {
    // Foundry owns provisioning, idle suspend and TTL: a recycled sandbox comes back under a new
    // id, and a session still sending the old one would be asking for something that is gone.
    const client = new FoundryLikeClient([
      { contents: [textContent('one')], reports: 'sess_old' },
      { contents: [textContent('two')], reports: 'sess_new' },
      { contents: [textContent('three')], reports: 'sess_new' },
    ]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    await agent.run('one', { session });
    await agent.run('two', { session });
    await agent.run('three', { session });

    expect(client.sent).toEqual([undefined, 'sess_old', 'sess_new']);
    expect(session.state[FOUNDRY_HOSTED_SESSION_STATE_KEY]).toBe('sess_new');
  });

  it('sends nothing when the service never reports one', async () => {
    const client = new FoundryLikeClient([{ contents: [textContent('done')] }]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    await agent.run('one', { session });
    await agent.run('two', { session });

    expect(client.sent).toEqual([undefined, undefined]);
    expect(session.state[FOUNDRY_HOSTED_SESSION_STATE_KEY]).toBeUndefined();
  });
});

describe('an id the caller supplies', () => {
  it('is sent as given when the session holds none', async () => {
    const client = new FoundryLikeClient([{ contents: [textContent('done')] }]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    await agent.run('one', {
      session,
      options: { additionalProperties: { agent_session_id: 'pinned_by_caller' } },
    });

    expect(client.sent).toEqual(['pinned_by_caller']);
  });

  it('is accepted when it names the same sandbox the session already holds', async () => {
    const client = new FoundryLikeClient([{ contents: [textContent('done')], reports: 'same' }]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    await agent.run('one', { session });
    await expect(
      agent.run('two', { session, options: { additionalProperties: { agent_session_id: 'same' } } }),
    ).resolves.toBeDefined();
  });

  it('fails before sending when it names a different sandbox', async () => {
    // Either choice would be a guess, and the wrong guess reaches a different `$HOME`.
    const client = new FoundryLikeClient([{ contents: [textContent('done')], reports: 'held' }]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    await agent.run('one', { session });
    const before = client.sent.length;

    await expect(
      agent.run('two', { session, options: { additionalProperties: { agent_session_id: 'other' } } }),
    ).rejects.toThrow(ConfigurationError);
    expect(client.sent).toHaveLength(before);
  });
});

describe('what the layer leaves alone', () => {
  it('does not mutate the options the caller handed over', async () => {
    const client = new FoundryLikeClient(mintingThenAnswer('sess_5'));
    const agent = new Agent({ client, tools: [echo] });
    const session = agent.createSession();
    const options = { additionalProperties: { trace: 'keep' } } as Partial<OpenAIChatOptions>;

    await agent.run('go', { session, options });

    expect(options).toEqual({ additionalProperties: { trace: 'keep' } });
  });

  it('leaves other additionalProperties on the request untouched', async () => {
    const client = new FoundryLikeClient([{ contents: [textContent('done')], reports: 'sess_6' }]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    await agent.run('one', { session, options: { additionalProperties: { trace: 'keep' } } });
    await agent.run('two', { session, options: { additionalProperties: { trace: 'keep' } } });

    expect(client.sent).toEqual([undefined, 'sess_6']);
  });

  it('does not touch the conversation id, which is a different Foundry concept', async () => {
    const client = new FoundryLikeClient([{ contents: [textContent('done')], reports: 'sess_7' }]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    await agent.run('one', { session });

    expect(session.state[FOUNDRY_HOSTED_SESSION_STATE_KEY]).toBe('sess_7');
    // The sandbox id is not a conversation id and must not be mistaken for one.
    expect(session.serviceSessionId).toBeUndefined();
  });

  it('keeps an id already reported when the run fails afterwards', async () => {
    const failing = tool({
      name: 'boom',
      description: 'Fails',
      parameters: { type: 'object', properties: {} },
      execute: () => {
        throw new Error('tool failed');
      },
    });
    const client = new FoundryLikeClient([
      {
        contents: [{ type: 'function_call', callId: 'c1', name: 'boom', arguments: '{}' }],
        reports: 'sess_8',
      },
      { contents: [textContent('done')], reports: 'sess_8' },
    ]);
    const agent = new Agent({ client, tools: [failing] });
    const session = agent.createSession();

    await agent.run('go', { session });

    // The tool failed and was reported to the model; the sandbox the service already minted is
    // still the session's, and the second round used it.
    const second = client.sent[1];
    assert.exists(second);
    expect(second).toBe('sess_8');
    expect(session.state[FOUNDRY_HOSTED_SESSION_STATE_KEY]).toBe('sess_8');
  });
});
