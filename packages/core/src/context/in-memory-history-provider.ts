import type { AgentSession } from '../agent/session.js';
import type { Message, MessageFilter } from '../types/message.js';
import { notSourceTypes, passThrough } from '../types/message.js';
import type { SerializedMessage } from '../types/serialization.js';
import { deserializeMessages, serializeMessages } from '../types/serialization.js';
import type { HistoryProvider, ProviderAfterRunContext, ProviderRunContext } from './context-provider.js';

const MESSAGES_KEY = 'messages';

/** Options for {@link InMemoryHistoryProvider}. */
export interface InMemoryHistoryProviderConfig {
  /**
   * Defaults to `'in_memory'` (Python `InMemoryHistoryProvider.DEFAULT_SOURCE_ID`, which also
   * names the session-state partition). Override when running several history providers side by
   * side.
   */
  sourceId?: string;
  /**
   * Narrows what the stored transcript contributes to a run. Defaults to everything.
   *
   * Go `ChatHistoryProviderOptions.ProvideOutputMessageFilter`.
   */
  provideFilter?: MessageFilter;
  /**
   * Narrows what a finished run writes back.
   *
   * Defaults to `notSourceTypes('ChatHistory')`: re-saving replayed history would grow the
   * transcript geometrically (Go's `notSourceTypes(SourceTypeHistoryProvider)`). Replacing this is
   * how a caller stores, say, only external messages.
   */
  storeFilter?: MessageFilter;
}

/**
 * Stores the transcript inside {@link AgentSession.state}, so history travels with the session.
 *
 * Messages are held in their serialized (wire) form, which means a session survives
 * `JSON.stringify` / {@link AgentSession.fromJSON} without losing unknown content types and
 * without dragging provider objects (`rawRepresentation`) along.
 *
 * Messages the provider itself injected are not written back, so replaying a session never
 * duplicates history (Go's `notSourceTypes(SourceTypeHistoryProvider)`).
 *
 * ## Security considerations
 *
 * History is replayed verbatim into every later model call. Text a tool or a user placed in the
 * transcript keeps influencing the model for the rest of the session, so treat a shared or
 * restored session as untrusted context.
 */
export class InMemoryHistoryProvider implements HistoryProvider {
  readonly sourceId: string;
  readonly #provideFilter: MessageFilter;
  readonly #storeFilter: MessageFilter;

  constructor(options?: InMemoryHistoryProviderConfig) {
    this.sourceId = options?.sourceId ?? 'in_memory';
    this.#provideFilter = options?.provideFilter ?? passThrough;
    this.#storeFilter = options?.storeFilter ?? notSourceTypes('ChatHistory');
  }

  async getMessages(_session: AgentSession, state: Record<string, unknown>): Promise<Message[]> {
    const stored = state[MESSAGES_KEY];
    if (!Array.isArray(stored)) {
      return [];
    }
    return deserializeMessages(stored as SerializedMessage[]);
  }

  async saveMessages(
    _session: AgentSession,
    messages: Message[],
    state: Record<string, unknown>,
  ): Promise<void> {
    const existing = Array.isArray(state[MESSAGES_KEY]) ? (state[MESSAGES_KEY] as SerializedMessage[]) : [];
    state[MESSAGES_KEY] = [...existing, ...serializeMessages(messages)];
  }

  async beforeRun(ctx: ProviderRunContext): Promise<void> {
    const history = this.#provideFilter(await this.getMessages(ctx.session, ctx.state));
    if (history.length > 0) {
      ctx.extendMessages(history);
    }
  }

  async afterRun(ctx: ProviderAfterRunContext): Promise<void> {
    if (ctx.response === undefined) {
      return;
    }
    const toSave = this.#storeFilter([...ctx.inputMessages, ...ctx.response.messages]);
    if (toSave.length > 0) {
      await this.saveMessages(ctx.session, toSave, ctx.state);
    }
  }
}
