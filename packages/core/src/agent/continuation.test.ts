import { describe, expect, it } from 'vitest';
import type { ChatClient, ChatOptions, ChatResponseStream } from '../client/chat-client.js';
import { ConfigurationError } from '../errors.js';
import { createResponseStream } from '../streaming/response-stream.js';
import { textContent } from '../types/content.js';
import type { Message } from '../types/message.js';
import type { ChatResponse, ChatResponseUpdate, ContinuationToken } from '../types/response.js';
import {
  agentResponseUpdate,
  chatResponse,
  chatResponseUpdate,
  mergeChatUpdates,
} from '../types/response.js';
import { Agent } from './agent.js';
import { isAgentContinuationToken, parseContinuationToken, wrapContinuationToken } from './continuation.js';

/** Narrows away undefined; a missing value fails the test with a clear error. */
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value');
  return value;
}

/** One scripted turn: some text, and optionally a token meaning "not finished yet". */
interface Turn {
  text: string;
  token?: ContinuationToken;
}

/** A client that suspends with a provider token and finishes when handed that token back. */
class BackgroundClient implements ChatClient<ChatOptions> {
  readonly metadata = { providerName: 'mock' };
  readonly seen: Array<{ messages: Message[]; token: ContinuationToken | undefined }> = [];
  #index = 0;
  readonly #turns: Turn[];

  constructor(turns: Turn[]) {
    this.#turns = turns;
  }

  getResponse(messages: Message[], options?: ChatOptions & { signal?: AbortSignal }): ChatResponseStream {
    const turn = must(this.#turns[Math.min(this.#index, this.#turns.length - 1)]);
    this.#index++;
    this.seen.push({ messages, token: options?.continuationToken });

    const update = chatResponseUpdate({
      contents: [textContent(turn.text)],
      role: 'assistant',
      messageId: `msg_${this.seen.length}`,
      ...(turn.token === undefined ? { finishReason: 'stop' } : { continuationToken: turn.token }),
    });

    return createResponseStream<ChatResponseUpdate, ChatResponse<undefined>>({
      start: async function* () {
        yield update;
      },
      finalize: (updates) => mergeChatUpdates<undefined>(updates),
    });
  }
}

/** A client that never suspends, used for the guard-rail cases. */
function plain(text: string): ChatClient<ChatOptions> {
  return {
    metadata: { providerName: 'mock' },
    getResponse: () =>
      createResponseStream<ChatResponseUpdate, ChatResponse<undefined>>({
        start: async function* () {},
        finalize: () =>
          chatResponse<undefined>({
            messages: [{ role: 'assistant', contents: [textContent(text)] }],
          }),
      }),
  };
}

describe('token payload round trip', () => {
  it('carries every update field across the serialization boundary', () => {
    const update = agentResponseUpdate({
      contents: [textContent('partial')],
      role: 'assistant',
      authorName: 'writer',
      responseId: 'resp_1',
      messageId: 'msg_1',
      createdAt: '2026-08-04T00:00:00Z',
      finishReason: 'stop',
      agentId: 'agent_1',
      additionalProperties: { turn: 1 },
    });
    const token = wrapContinuationToken(
      { responseId: 'resp_1' },
      [{ role: 'user', contents: [textContent('question')] }],
      [update],
    );

    const state = parseContinuationToken(token);
    expect(state.innerToken).toEqual({ responseId: 'resp_1' });
    expect(state.inputMessages).toEqual([
      expect.objectContaining({ role: 'user', contents: [expect.objectContaining({ text: 'question' })] }),
    ]);
    const restored = must(state.updates[0]);
    expect(restored.text).toBe('partial');
    expect(restored.role).toBe('assistant');
    expect(restored.authorName).toBe('writer');
    expect(restored.responseId).toBe('resp_1');
    expect(restored.messageId).toBe('msg_1');
    expect(restored.createdAt).toBe('2026-08-04T00:00:00Z');
    expect(restored.finishReason).toBe('stop');
    expect(restored.agentId).toBe('agent_1');
    expect(restored.additionalProperties).toEqual({ turn: 1 });
  });

  it('round-trips a bare update without inventing fields', () => {
    const token = wrapContinuationToken(
      { responseId: 'resp_1' },
      [],
      [agentResponseUpdate({ contents: [] })],
    );
    expect(token.inputMessages).toBeUndefined();

    const restored = must(parseContinuationToken(token).updates[0]);
    expect(restored.contents).toEqual([]);
    expect(restored.authorName).toBeUndefined();
    expect(restored.responseId).toBeUndefined();
    expect(restored.finishReason).toBeUndefined();
    expect(restored.additionalProperties).toBeUndefined();
  });

  it('parses an absent token to empty state and rejects a foreign one', () => {
    expect(parseContinuationToken(undefined)).toEqual({ inputMessages: [], updates: [] });
    expect(() => parseContinuationToken({ responseId: 'raw' })).toThrow(ConfigurationError);
  });
});

describe('continuation tokens', () => {
  it('wraps the provider token so a resumed run can persist the whole exchange', async () => {
    const client = new BackgroundClient([{ text: 'working…', token: { responseId: 'resp_1' } }]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    const suspended = await agent.run('long job', { session, allowBackgroundResponses: true });

    expect(isAgentContinuationToken(suspended.continuationToken)).toBe(true);
    expect(suspended.continuationToken?.innerToken).toEqual({ responseId: 'resp_1' });
    // An awaited run carries nothing else: it folded its own updates and persisted its own input
    // before handing the token back, so a resumed run replaying either would duplicate both.
    expect(suspended.continuationToken?.inputMessages).toBeUndefined();
    expect(suspended.continuationToken?.responseUpdates).toBeUndefined();
  });

  it('carries the input and the updates when the run was streamed', async () => {
    const client = new BackgroundClient([{ text: 'working…', token: { responseId: 'resp_1' } }]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    const stream = agent.run('long job', { session, allowBackgroundResponses: true });
    for await (const _ of stream) {
      // drain
    }
    const suspended = await stream.finalResponse();

    // A streamed caller reads the response update by update, so a resumed stream has to be able to
    // reproduce the whole thing from the token alone (Go `agent.go`).
    expect(suspended.continuationToken?.inputMessages).toHaveLength(1);
    expect(suspended.continuationToken?.responseUpdates).toHaveLength(1);
  });

  it('hands the provider its own token back, not the wrapper', async () => {
    const client = new BackgroundClient([
      { text: 'working…', token: { responseId: 'resp_1' } },
      { text: 'finished' },
    ]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    const suspended = await agent.run('long job', { session, allowBackgroundResponses: true });
    const resumed = await agent.run(undefined, {
      session,
      continuationToken: must(suspended.continuationToken),
    });

    expect(client.seen[1]?.token).toEqual({ responseId: 'resp_1' });
    expect(resumed.text).toBe('finished');
    expect(resumed.continuationToken).toBeUndefined();
  });

  it('replays the updates seen before suspension when streaming', async () => {
    const client = new BackgroundClient([
      { text: 'part one ', token: { responseId: 'resp_1' } },
      { text: 'part two' },
    ]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    const first = agent.run('long job', { session, allowBackgroundResponses: true });
    for await (const _ of first) {
      // drain
    }
    const suspended = await first.finalResponse();

    const resumed = agent.run(undefined, { session, continuationToken: must(suspended.continuationToken) });
    const texts: string[] = [];
    for await (const update of resumed) {
      texts.push(update.text);
    }

    // The caller reading only the resumed stream still sees the complete response.
    expect(texts.join('')).toBe('part one part two');
  });

  it('does not replay updates for an awaited run', async () => {
    const client = new BackgroundClient([
      { text: 'part one ', token: { responseId: 'resp_1' } },
      { text: 'part two' },
    ]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    const suspended = await agent.run('long job', { session, allowBackgroundResponses: true });
    expect(suspended.continuationToken?.responseUpdates).toBeUndefined();

    const resumed = await agent.run(undefined, {
      session,
      continuationToken: must(suspended.continuationToken),
    });
    expect(resumed.text).toBe('part two');
  });

  it('requires an explicit session for background responses', () => {
    expect(() => new Agent({ client: plain('x') }).run('hi', { allowBackgroundResponses: true })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects input alongside a continuation token', () => {
    const token = { type: 'agentContinuationToken', innerToken: { responseId: 'r' } };
    expect(() => new Agent({ client: plain('x') }).run('more input', { continuationToken: token })).toThrow(
      /Messages are not allowed/,
    );
  });

  it('rejects a token this framework did not produce', () => {
    expect(() =>
      new Agent({ client: plain('x') }).run(undefined, { continuationToken: { responseId: 'raw' } }),
    ).toThrow(/not produced by this framework/);
  });

  it('defers structured-output parsing while suspended and parses it after resume', async () => {
    // Regression: the eager parse used to throw on the suspended turn, so a
    // background run with responseFormat could never even hand its token back.
    const format = { toJsonSchema: () => ({ type: 'object' }) };
    const client = new BackgroundClient([
      { text: 'working…', token: { responseId: 'resp_1' } },
      { text: '{"ok":true}' },
    ]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    const suspended = await agent.run('long job', {
      session,
      allowBackgroundResponses: true,
      responseFormat: format as never,
    });
    expect(suspended.continuationToken).toBeDefined();
    expect(suspended.value).toBeUndefined();

    const resumed = await agent.run(undefined, {
      session,
      continuationToken: must(suspended.continuationToken),
      responseFormat: format as never,
    });
    expect(resumed.value).toEqual({ ok: true });
  });

  it('stores a streamed suspension exactly once, when the resumed run completes', async () => {
    const client = new BackgroundClient([
      { text: 'part one ', token: { responseId: 'resp_1' } },
      { text: 'part two' },
      { text: 'next turn' },
    ]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    let token: ContinuationToken | undefined;
    for await (const update of agent.run('long job', { session, allowBackgroundResponses: true })) {
      token = update.continuationToken ?? token;
    }
    const resumed = await agent.run(undefined, { session, continuationToken: must(token) });
    expect(resumed.continuationToken).toBeUndefined();
    expect(resumed.text).toContain('part one');
    expect(resumed.text).toContain('part two');

    // A streaming token replays the input and every update already produced, so the completing
    // run stores the whole exchange; the suspended run storing its half too would make the next
    // turn replay the question and the partial answer twice.
    await agent.run('and now?', { session });
    const replayed = must(client.seen[2]).messages.flatMap((msg) =>
      msg.contents.flatMap((c) => (c.type === 'text' ? [c.text] : [])),
    );
    expect(replayed.filter((text) => text === 'long job')).toHaveLength(1);
    expect(replayed.filter((text) => text.includes('part one'))).toHaveLength(1);
    expect(replayed.join('')).toContain('part two');
  });

  it('stores a twice-suspended streamed exchange exactly once', async () => {
    const client = new BackgroundClient([
      { text: 'one ', token: { responseId: 'r1' } },
      { text: 'two ', token: { responseId: 'r2' } },
      { text: 'three' },
      { text: 'next turn' },
    ]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    let token1: ContinuationToken | undefined;
    for await (const update of agent.run('long job', { session, allowBackgroundResponses: true })) {
      token1 = update.continuationToken ?? token1;
    }
    // The second run resumes as a stream and suspends again; its token carries the whole
    // exchange so far, so only the run that finally completes appends to history.
    let token2: ContinuationToken | undefined;
    for await (const update of agent.run(undefined, { session, continuationToken: must(token1) })) {
      token2 = update.continuationToken ?? token2;
    }
    const resumed = await agent.run(undefined, { session, continuationToken: must(token2) });
    expect(resumed.continuationToken).toBeUndefined();

    await agent.run('and now?', { session });
    const replayed = must(client.seen[3]).messages.flatMap((msg) =>
      msg.contents.flatMap((c) => (c.type === 'text' ? [c.text] : [])),
    );
    expect(replayed.filter((text) => text === 'long job')).toHaveLength(1);
    expect(replayed.filter((text) => text.includes('one'))).toHaveLength(1);
    expect(replayed.filter((text) => text.includes('two'))).toHaveLength(1);
    expect(replayed.join('')).toContain('three');
  });

  it('skips history replay on resume but still persists the exchange', async () => {
    const client = new BackgroundClient([
      { text: 'working…', token: { responseId: 'resp_1' } },
      { text: 'finished' },
      { text: 'next turn' },
    ]);
    const agent = new Agent({ client });
    const session = agent.createSession();

    const suspended = await agent.run('long job', { session, allowBackgroundResponses: true });
    await agent.run(undefined, { session, continuationToken: must(suspended.continuationToken) });

    // The resumed call sends nothing: the operation is already running service-side.
    expect(client.seen[1]?.messages).toEqual([]);

    // History still records the original input and the completed answer, so the next turn has it.
    await agent.run('and now?', { session });
    const replayed = must(client.seen[2]).messages.flatMap((msg) =>
      msg.contents.flatMap((c) => (c.type === 'text' ? [c.text] : [])),
    );
    expect(replayed).toContain('long job');
    expect(replayed).toContain('finished');
    // Exactly once. The suspending run already stored the input; a token that carries it again
    // makes the resumed run store a second copy, and the model then reads the question twice.
    expect(replayed.filter((text) => text === 'long job')).toHaveLength(1);
  });
});
