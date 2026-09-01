/**
 * What a hosted Foundry turn sends once its session is service-managed.
 *
 * The platform prefetches the whole transcript and replays it as this turn's input, and the
 * handler empties the agent's own history slot so nothing is replayed twice. Nothing, however,
 * empties `serviceSessionId` — it is carried in the session snapshot from turn to turn. A session
 * that adopted the model API's conversation id therefore sends that id *and* the prefetched
 * transcript on every later turn, which is one turn's history twice.
 *
 * `store: false` — what every hosted agent sets, and what `ResponsesHostServer` prescribes — is
 * what keeps that from happening: nothing is kept service-side, so no id is reported and none is
 * adopted. These tests pin both halves, so the pairing cannot come back unnoticed.
 */
import type { CreateResponseRequest, ResponseObject } from '@polymind-inc/agent-framework-agentserver';
import { InMemoryResponseProvider, ResponsesServer } from '@polymind-inc/agent-framework-agentserver';
import type {
  ChatClient,
  ChatClientMetadata,
  ChatOptions,
  ChatResponse,
  ChatResponseStream,
  ChatResponseUpdate,
  Message,
  SerializedAgentSession,
} from '@polymind-inc/agent-framework-core';
import {
  Agent,
  chatResponse,
  chatResponseToUpdates,
  createResponseStream,
  mergeChatUpdates,
  textContent,
} from '@polymind-inc/agent-framework-core';
import { assert, describe, expect, it } from 'vitest';
import { InMemoryApprovalStorage } from './approval-storage.js';
import { createFoundryHandler } from './handler.js';
import type { AgentSessionStore } from './session-store.js';
import { InMemoryAgentSessionStore } from './session-store.js';

async function* streamOf<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

/**
 * A client that reports a conversation id exactly where the OpenAI one does.
 *
 * `parseConversationId` reports nothing when `store` is `false`, and the response id otherwise —
 * so a client that ignores `store` would make a promotion look reachable where it is not.
 * `MockChatClient` reports no conversation id at all, so a promotion cannot be observed with it.
 */
class StoringChatClient implements ChatClient<ChatOptions> {
  readonly metadata: ChatClientMetadata = { providerName: 'mock', modelId: 'mock-model' };
  readonly calls: { messages: Message[]; options: (ChatOptions & { signal?: AbortSignal }) | undefined }[] =
    [];
  readonly #texts: readonly string[];

  constructor(texts: readonly string[]) {
    this.#texts = texts;
  }

  getResponse(
    messages: Message[],
    options?: ChatOptions & { signal?: AbortSignal },
  ): ChatResponseStream<undefined> {
    let direct: ChatResponse<undefined> | undefined;
    return createResponseStream<ChatResponseUpdate, ChatResponse<undefined>>({
      start: () => {
        this.calls.push({ messages, options });
        const turn = this.calls.length;
        const text = this.#texts[Math.min(turn - 1, this.#texts.length - 1)] ?? '';
        const stored = (options as { store?: boolean } | undefined)?.store !== false;
        direct = chatResponse<undefined>({
          messages: [{ role: 'assistant', contents: [textContent(text)], messageId: `msg_${turn}` }],
          responseId: `resp_${turn}`,
          ...(stored ? { conversationId: `resp_${turn}` } : {}),
          finishReason: 'stop',
        });
        return streamOf(chatResponseToUpdates(direct));
      },
      finalize: (updates) => direct ?? mergeChatUpdates<undefined>(updates),
    });
  }
}

/**
 * The state promotion would leave behind: the run adopts the model's conversation id, and the
 * handler saves the session carrying it.
 */
class PromotedSessionStore implements AgentSessionStore {
  readonly #inner = new InMemoryAgentSessionStore();
  readonly #conversationId: string;

  constructor(conversationId: string) {
    this.#conversationId = conversationId;
  }

  async load(userId: string, key: string): Promise<SerializedAgentSession | undefined> {
    return this.#inner.load(userId, key);
  }

  async save(userId: string, key: string, session: SerializedAgentSession): Promise<void> {
    await this.#inner.save(userId, key, { ...session, serviceSessionId: this.#conversationId });
  }
}

function post(body: CreateResponseRequest): Request {
  return new Request('http://localhost:8088/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function hostedApp(
  client: ChatClient<ChatOptions>,
  sessionStore: AgentSessionStore,
  defaultOptions?: Partial<ChatOptions>,
): ResponsesServer {
  return new ResponsesServer({
    handler: createFoundryHandler({
      agent: new Agent({
        client,
        instructions: 'Be helpful.',
        ...(defaultOptions === undefined ? {} : { defaultOptions }),
      }),
      sessionStore,
      approvalStorage: new InMemoryApprovalStorage(),
      hosted: false,
    }),
    store: new InMemoryResponseProvider(),
  });
}

function textsSent(call: { messages: Message[] }): string[] {
  return call.messages.flatMap((message) =>
    message.contents.flatMap((content) => (content.type === 'text' ? [content.text] : [])),
  );
}

async function twoHostedTurns(
  client: StoringChatClient,
  sessionStore: AgentSessionStore,
  defaultOptions?: Partial<ChatOptions>,
): Promise<void> {
  const app = hostedApp(client, sessionStore, defaultOptions);
  const first = (await (await app.handle(post({ input: 'one' }))).json()) as ResponseObject;
  expect(first.status).toBe('completed');
  const second = (await (
    await app.handle(post({ input: 'two', previous_response_id: first.id }))
  ).json()) as ResponseObject;
  expect(second.status).toBe('completed');
}

describe('hosted turns and service-managed sessions', () => {
  it('adopts the model conversation id when the hosted agent leaves store unset', async () => {
    // The pairing this file exists to document: the platform's prefetched transcript *and* the id
    // the provider is told to continue from, both in one request. A hosted agent that leaves
    // `store` unset gets it, which is why every hosted example sets `store: false`.
    const client = new StoringChatClient(['first', 'second']);

    await twoHostedTurns(client, new InMemoryAgentSessionStore());

    const second = client.calls[1];
    assert.exists(second);
    expect(textsSent(second)).toEqual(['one', 'first', 'two']);
    expect(second.options?.conversationId).toBe('resp_1');
  });

  it('sends the prefetched transcript AND the conversation id once the session is service-managed', async () => {
    const client = new StoringChatClient(['first', 'second']);

    await twoHostedTurns(client, new PromotedSessionStore('resp_1'));

    const second = client.calls[1];
    assert.exists(second);
    // Both copies of turn one reach the provider: the id it is told to continue from, and the
    // transcript the platform prefetched.
    expect(second.options?.conversationId).toBe('resp_1');
    expect(textsSent(second)).toEqual(['one', 'first', 'two']);
  });

  it('reports no conversation id to adopt when the hosted agent sets store false', async () => {
    // What every hosted example configures, and what `ResponsesHostServer`'s own doc prescribes:
    // the hosting infrastructure owns the transcript, so the provider must not store it too.
    const client = new StoringChatClient(['first', 'second']);

    await twoHostedTurns(client, new InMemoryAgentSessionStore(), { store: false });

    for (const call of client.calls) {
      expect(call.options?.store).toBe(false);
      expect(call.options?.conversationId).toBeUndefined();
    }
  });

  it('still sends a conversation id an already-service-managed session holds, store false or not', async () => {
    // `store: false` stops a session from *becoming* service-managed. It does nothing about one
    // that already is: the id is forwarded from the session, not derived from the response.
    const client = new StoringChatClient(['first', 'second']);

    await twoHostedTurns(client, new PromotedSessionStore('resp_1'), { store: false });

    const second = client.calls[1];
    assert.exists(second);
    expect(second.options?.conversationId).toBe('resp_1');
    expect(textsSent(second)).toEqual(['one', 'first', 'two']);
  });
});
