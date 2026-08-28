import type { Content, Message } from '../index.js';
import { createResponseStream } from '../streaming/response-stream.js';
import type { ChatResponse, ChatResponseUpdate } from '../types/response.js';
import {
  chatResponse,
  chatResponseToUpdates,
  chatResponseUpdate,
  mergeChatUpdates,
} from '../types/response.js';
import type { UsageDetails } from '../types/usage.js';
import type { ChatClient, ChatClientMetadata, ChatOptions, ChatResponseStream } from './chat-client.js';
import { arrayToStream } from './provider-utils.js';

/** One scripted turn of a {@link MockChatClient}. */
export interface MockTurn {
  /** The assistant contents this turn answers with. */
  contents: Content[];
  /** The finish reason reported on the turn's final update and on the merged response. */
  finishReason?: string;
  /** The `responseId` reported on this turn's response and updates. */
  responseId?: string;
  /**
   * Token usage for this turn, reported the way a real provider does: on the response for an
   * awaited call, and as a trailing `usage` content while streaming.
   */
  usage?: UsageDetails;
}

/** A recorded call to {@link MockChatClient.getResponse}. */
export interface RecordedCall {
  /** The messages the caller passed, unmodified. */
  messages: Message[];
  /** The options the caller passed, unmodified. */
  options: (ChatOptions & { signal?: AbortSignal }) | undefined;
  /** Whether the caller consumed the call as a stream (`for await`) or awaited it whole. */
  stream: boolean;
}

/**
 * A scripted {@link ChatClient} for tests.
 *
 * Each entry of `turns` answers one model call in order, so a tool loop can be exercised without
 * a network round-trip; when the script runs out, the last turn repeats. Every call is recorded
 * in {@link MockChatClient.calls} for assertions on what reached the client.
 */
export class MockChatClient implements ChatClient<ChatOptions> {
  readonly metadata: ChatClientMetadata = { providerName: 'mock', modelId: 'mock-model' };
  /** Every call received so far, in order. */
  readonly calls: RecordedCall[] = [];
  #index = 0;
  readonly #turns: MockTurn[];

  constructor(turns: MockTurn[]) {
    this.#turns = turns;
  }

  /** Shorthand for `calls.length`. */
  get callCount(): number {
    return this.calls.length;
  }

  #nextTurn(): MockTurn {
    const turn = this.#turns[Math.min(this.#index, this.#turns.length - 1)];
    this.#index++;
    return turn ?? { contents: [] };
  }

  getResponse(
    messages: Message[],
    options?: ChatOptions & { signal?: AbortSignal },
  ): ChatResponseStream<undefined> {
    let direct: ChatResponse<undefined> | undefined;
    return createResponseStream<ChatResponseUpdate, ChatResponse<undefined>>({
      start: (ctx) => {
        this.calls.push({ messages, options, stream: ctx.stream });
        const turn = this.#nextTurn();
        const responseId = turn.responseId ?? `resp_${this.calls.length}`;

        if (!ctx.stream) {
          direct = chatResponse<undefined>({
            messages: [{ role: 'assistant', contents: turn.contents, messageId: `msg_${this.calls.length}` }],
            responseId,
            ...(turn.finishReason === undefined ? {} : { finishReason: turn.finishReason }),
            ...(turn.usage === undefined ? {} : { usageDetails: turn.usage }),
          });
          return arrayToStream(chatResponseToUpdates(direct));
        }

        const updates = turn.contents.map((content, index) =>
          chatResponseUpdate({
            contents: [content],
            role: 'assistant',
            messageId: `msg_${this.calls.length}`,
            responseId,
            ...(index === turn.contents.length - 1 && turn.finishReason !== undefined
              ? { finishReason: turn.finishReason }
              : {}),
          }),
        );
        if (turn.usage !== undefined) {
          updates.push(
            chatResponseUpdate({
              contents: [{ type: 'usage', usageDetails: turn.usage }],
              responseId,
            }),
          );
        }
        return arrayToStream(updates);
      },
      finalize: (updates) => direct ?? mergeChatUpdates<undefined>(updates),
    });
  }
}

export { must } from '../must.js';
