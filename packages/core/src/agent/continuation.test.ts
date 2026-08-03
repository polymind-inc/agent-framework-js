import { describe, expect, it } from 'vitest';
import type { ChatClient, ChatOptions, ChatResponseStream } from '../client/chat-client.js';
import { ConfigurationError } from '../errors.js';
import { createResponseStream } from '../streaming/response-stream.js';
import { textContent } from '../types/content.js';
import type { Message } from '../types/message.js';
import type { ChatResponse, ChatResponseUpdate, ContinuationToken } from '../types/response.js';
import { chatResponse, chatResponseUpdate, mergeChatUpdates } from '../types/response.js';
import { Agent } from './agent.js';
import { isAgentContinuationToken } from './continuation.js';

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
