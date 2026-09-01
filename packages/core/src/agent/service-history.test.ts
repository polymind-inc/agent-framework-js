import { assert, describe, expect, it } from 'vitest';
import type {
  ChatClient,
  ChatClientMetadata,
  ChatOptions,
  ChatResponseStream,
} from '../client/chat-client.js';
import { InMemoryHistoryProvider } from '../context/in-memory-history-provider.js';
import { ConfigurationError } from '../errors.js';
import { createResponseStream } from '../streaming/response-stream.js';
import { textContent } from '../types/content.js';
import type { Message } from '../types/message.js';
import type { ChatResponse, ChatResponseUpdate } from '../types/response.js';
import { chatResponseUpdate, mergeChatUpdates } from '../types/response.js';
import { Agent } from './agent.js';

/** A client that answers with text and reports a service-side conversation id, like Responses. */
class StoringClient implements ChatClient<ChatOptions> {
  readonly metadata: ChatClientMetadata;
  readonly calls: Array<{ messages: Message[]; conversationId: string | undefined }> = [];
  #turn = 0;
  readonly #conversationIds: string[];

  constructor(conversationIds: string[], metadata: ChatClientMetadata = { providerName: 'mock' }) {
    this.#conversationIds = conversationIds;
    this.metadata = metadata;
  }

  getResponse(messages: Message[], options?: ChatOptions): ChatResponseStream {
    this.calls.push({ messages, conversationId: options?.conversationId });
    const conversationId = this.#conversationIds[Math.min(this.#turn, this.#conversationIds.length - 1)];
    assert.exists(conversationId);
    this.#turn++;
    // A provider reports a conversation id only when it kept the turn, so `store: false` reports
    // none — the same rule every provider mapping applies.
    const kept = options?.store !== false;
    const update = chatResponseUpdate({
      contents: [textContent(`answer ${this.calls.length}`)],
      role: 'assistant',
      messageId: `msg_${this.calls.length}`,
      finishReason: 'stop',
      ...(kept ? { conversationId } : {}),
    });
    return createResponseStream<ChatResponseUpdate, ChatResponse<undefined>>({
      start: async function* () {
        yield update;
      },
      finalize: (updates) => mergeChatUpdates<undefined>(updates),
    });
  }
}

/** What the default in-memory history provider has stored in a session. */
function historyOf(session: { state: Record<string, unknown> }): unknown[] {
  const slot = session.state.in_memory as { messages?: unknown[] } | undefined;
  return slot?.messages ?? [];
}

describe('service-managed history', () => {
  it('sends no local transcript and chains through the conversation id', async () => {
    const client = new StoringClient(['resp_1', 'resp_2']);
    const agent = new Agent({ client });
    const session = agent.createSession({ serviceSessionId: 'resp_0' });

    await agent.run('first', { session });
    await agent.run('second', { session });

    // Each call carries only that turn's input; the service holds everything before it.
    expect(client.calls[0]?.messages.map((m) => m.contents.length)).toEqual([1]);
    expect(client.calls[1]?.messages.map((m) => m.contents.length)).toEqual([1]);
    // …and points at the previous response, not the original id.
    expect(client.calls[0]?.conversationId).toBe('resp_0');
    expect(client.calls[1]?.conversationId).toBe('resp_1');
    expect(session.serviceSessionId).toBe('resp_2');
  });

  it('updates the session id mid-stream, before the response is folded', async () => {
    const client = new StoringClient(['resp_1']);
    const agent = new Agent({ client });
    const session = agent.createSession({ serviceSessionId: 'resp_0' });

    const stream = agent.run('hi', { session });
    for await (const _ of stream) {
      // The id is available to a caller that never waits for the final response.
      expect(session.serviceSessionId).toBe('resp_1');
    }
  });

  it('holds a session anchor the provider declares stable', async () => {
    // The per-update propagation must apply the same guard the tool loop does: a response-chain
    // id reported mid-run must not unhook the session from a stored conversation the provider
    // resolves by its stable anchor.
    const client = new StoringClient(['resp_1'], {
      providerName: 'mock',
      stableConversationId: (id) => id.startsWith('stable_'),
    });
    const agent = new Agent({ client });
    const session = agent.createSession({ serviceSessionId: 'stable_1' });

    await agent.run('hi', { session });

    expect(client.calls[0]?.conversationId).toBe('stable_1');
    expect(session.serviceSessionId).toBe('stable_1');
  });

  it('adopts the conversation id the first response reports', async () => {
    const client = new StoringClient(['resp_1', 'resp_2']);
    const agent = new Agent({ client });
    const session = agent.createSession();

    await agent.run('first', { session });
    await agent.run('second', { session });

    // Turn one has nothing to continue from and sends its own input…
    expect(client.calls[0]?.conversationId).toBeUndefined();
    // …and from turn two the service holds the history, so only the new input is sent.
    expect(client.calls[1]?.conversationId).toBe('resp_1');
    expect(client.calls[1]?.messages).toHaveLength(1);
    expect(session.serviceSessionId).toBe('resp_2');
  });

  it('keeps the framework transcript when the caller asks the provider not to store', async () => {
    // `store: false` is the switch for a caller who needs the framework to stay in charge of
    // history: nothing is kept service-side, so no id is reported and none is adopted.
    const client = new StoringClient(['resp_1', 'resp_2']);
    const agent = new Agent({ client, defaultOptions: { store: false } });
    const session = agent.createSession();

    await agent.run('first', { session });
    await agent.run('second', { session });

    expect(client.calls[1]?.messages).toHaveLength(3);
    expect(client.calls[1]?.conversationId).toBeUndefined();
    expect(session.serviceSessionId).toBeUndefined();
  });

  it('rejects a service-managed session when a history provider was configured explicitly', async () => {
    const agent = new Agent({
      client: new StoringClient(['resp_1']),
      historyProvider: new InMemoryHistoryProvider(),
    });
    const session = agent.createSession({ serviceSessionId: 'resp_0' });

    await expect(agent.run('hi', { session })).rejects.toThrow(ConfigurationError);
  });

  it('rejects a session promoted to service-managed while the run is in flight', async () => {
    const client = new StoringClient(['resp_1']);
    const agent = new Agent({
      client,
      historyProvider: new InMemoryHistoryProvider(),
      contextProviders: [
        {
          sourceId: 'promoter',
          // Stands in for anything that can hand the session a service conversation mid-run,
          // such as the Foundry hosting adapter.
          beforeRun: (ctx) => {
            ctx.session.serviceSessionId = 'resp_0';
          },
        },
      ],
    });

    await expect(agent.run('hi', { session: agent.createSession() })).rejects.toThrow(/Use one or the other/);
  });

  it('stops the default history provider from storing once the service takes over', async () => {
    const agent = new Agent({
      client: new StoringClient(['resp_1']),
      contextProviders: [
        {
          sourceId: 'promoter',
          beforeRun: (ctx) => {
            ctx.session.serviceSessionId = 'resp_0';
          },
        },
      ],
    });

    const session = agent.createSession();
    await agent.run('hi', { session });

    // Appending here would make the next run replay messages the service also sends.
    expect(historyOf(session)).toEqual([]);
  });

  it('still stores locally when nothing promoted the session', async () => {
    const agent = new Agent({
      client: new StoringClient(['resp_1']),
      defaultOptions: { store: false },
    });
    const session = agent.createSession();

    await agent.run('hi', { session });

    expect(historyOf(session)).toHaveLength(2);
  });

  it('stops storing locally from the turn that hands the transcript to the service', async () => {
    // The run that adopts the id retires the local store for that same run: appending there too
    // would make the next request replay messages the service is already sending.
    const agent = new Agent({ client: new StoringClient(['resp_1']) });
    const session = agent.createSession();

    await agent.run('hi', { session });

    expect(session.serviceSessionId).toBe('resp_1');
    expect(historyOf(session)).toHaveLength(0);
  });
});
