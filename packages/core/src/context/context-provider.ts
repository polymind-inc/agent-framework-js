import type { AgentSession } from '../agent/session.js';
import type { Middleware } from '../middleware/middleware.js';
import type { Tool } from '../tools/tool.js';
import type { Message, MessageFilter, MessageSourceType } from '../types/message.js';
import { getMessageSource, withMessageSource } from '../types/message.js';
import type { AgentResponse } from '../types/response.js';

/** The minimal agent surface a provider is allowed to see. */
export interface ProviderAgentInfo {
  readonly id: string;
  readonly name?: string;
}

/** What a provider may read and contribute during one run. */
export interface ProviderRunContext {
  readonly agent: ProviderAgentInfo;
  readonly session: AgentSession;
  /** The provider's own partition of {@link AgentSession.state}, keyed by its `sourceId`. */
  readonly state: Record<string, unknown>;
  /** The caller's messages for this run. Read-only; use {@link ProviderRunContext.extendMessages} to add. */
  readonly inputMessages: readonly Message[];
  /** Prepends messages to the model call. Each is stamped with this provider's source attribution. */
  extendMessages(messages: readonly Message[]): void;
  /** Appends to the system instructions for this run. */
  extendInstructions(instructions: string): void;
  /** Adds tools for this run only. */
  extendTools(tools: readonly Tool[]): void;
  readonly signal?: AbortSignal;
}

/** The context passed to {@link ContextProvider.afterRun}. */
export interface ProviderAfterRunContext extends ProviderRunContext {
  /** The run's result, absent when the run failed. */
  readonly response?: AgentResponse<unknown>;
  /** The failure, absent when the run succeeded. */
  readonly error?: unknown;
  /**
   * Everything the providers of this run injected ahead of {@link ProviderRunContext.inputMessages},
   * in the order the model saw it.
   *
   * Each message carries the source stamp of the provider that contributed it, so a history
   * provider can persist retrieved documents or replayed memories alongside the exchange — see
   * {@link HistoryStoreOptions.storeContextMessages}. A resumed run re-enters after the context
   * was already applied, so it injects nothing itself; when resuming a streamed suspension this
   * carries what the suspended run injected (minus replayed history, which the store already
   * holds), since that run deferred persistence to the one that completes the exchange.
   */
  readonly contextMessages: readonly Message[];
}

/**
 * Supplies extra context — memories, retrieved documents, instructions, tools — around a run.
 *
 * ## Security considerations
 *
 * Everything a provider injects becomes model context and is indistinguishable from user input to
 * the model. Treat retrieved documents and remembered text as untrusted, and never inject
 * credentials.
 */
export interface ContextProvider {
  /** Unique per agent; also names this provider's partition of {@link AgentSession.state}. */
  readonly sourceId: string;
  /**
   * Additional top-level {@link AgentSession.state} keys this provider claims.
   *
   * `Agent` fails fast at construction time when two providers claim the same key, so a
   * misconfiguration never silently corrupts session state.
   */
  readonly stateKeys?: readonly string[];
  /**
   * Middleware this provider contributes to every run of the agent it is registered on.
   *
   * One of the four middleware collection sites (agent config, context providers, history
   * provider, chat client). Read when the agent is constructed, not per run: an agent middleware
   * wraps the run that would otherwise have to discover it.
   */
  readonly middleware?: readonly Middleware[];
  beforeRun?(ctx: ProviderRunContext): void | Promise<void>;
  afterRun?(ctx: ProviderAfterRunContext): void | Promise<void>;
}

/** The provenance stamped on messages a provider injects. */
export function sourceTypeOf(provider: ContextProvider): MessageSourceType {
  return isHistoryProvider(provider) ? 'ChatHistory' : 'AIContextProvider';
}

/**
 * Loads and persists conversation history for a session.
 *
 * Registered before every other {@link ContextProvider}, so history is the oldest context in the
 * request.
 *
 * ## What an implementation may rely on
 *
 * The store behind this interface is append-only, and the framework holds up its side of that:
 *
 * - `saveMessages` is handed **only the messages new to that turn**. The transcript is never
 *   re-sent, so an implementation appends what it is given and never has to diff or de-duplicate.
 *   A background turn split across a suspension and a resume still appends once: a streaming run
 *   that ends suspended stores nothing (its continuation token replays the whole exchange, and
 *   the run that completes stores it), while an awaited suspension stores its own half and the
 *   resumed run appends only its tail.
 * - It is called once per run, not once per round of the tool loop, so one turn's function calls
 *   and their results arrive together with the answer they produced.
 * - `getMessages` returns the transcript oldest first, and whatever it returns is replayed ahead
 *   of the caller's input for that run.
 * - `beforeRun` runs before every other context provider's, so history is the oldest thing in the
 *   request rather than something interleaved with retrieved documents.
 *
 * ## What an implementation decides
 *
 * `afterRun` is called for a failed run too, with `error` set and no `response`. The bundled
 * providers store nothing in that case — a turn with an input and no answer would replay as an
 * unanswered question — and an implementation that stores anyway is choosing differently, not
 * fixing an omission. A run the caller abandoned partway *does* have a response, so it is stored
 * like any other; see the note on stopping early in `AgentRunStream`.
 *
 * What reaches the store beyond the caller's input and the response is
 * {@link HistoryStoreOptions.storeContextMessages}.
 */
export interface HistoryProvider extends ContextProvider {
  /** Returns the stored transcript, oldest first. */
  getMessages(session: AgentSession, state: Record<string, unknown>): Promise<Message[]>;
  /** Appends `messages` to the stored transcript. */
  saveMessages(session: AgentSession, messages: Message[], state: Record<string, unknown>): Promise<void>;
}

/**
 * What a bundled history provider replays and writes back.
 *
 * Shared by every history provider this framework ships, so switching storage does not change
 * which messages are stored.
 */
export interface HistoryStoreOptions {
  /**
   * Narrows what the stored transcript contributes to a run. Defaults to everything.
   */
  provideFilter?: MessageFilter;
  /**
   * Narrows what a finished run writes back.
   *
   * Defaults to `notSourceTypes('ChatHistory')`: re-saving replayed history would grow the
   * transcript geometrically. Replacing this is how a caller stores, say, only external messages.
   */
  storeFilter?: MessageFilter;
  /**
   * Also store the messages other context providers injected into the run.
   *
   * Off by default, matching Python: retrieved documents and remembered text are usually
   * re-derived on the next run, and persisting them would both duplicate them and freeze a
   * snapshot of something meant to stay live. .NET and Go store them by default instead, so a
   * transcript written by this framework is the narrower of the two.
   *
   * `true` stores every injected message. A list of `sourceId`s stores only the ones those
   * providers contributed, which is how a caller persists retrieved documents without also
   * persisting everything else in the context window. Messages the history provider itself
   * replayed are dropped by the default {@link HistoryStoreOptions.storeFilter} either way.
   */
  storeContextMessages?: boolean | readonly string[];
}

/** Applies {@link HistoryStoreOptions.storeContextMessages} to one run's injected messages. */
export function selectContextMessages(
  messages: readonly Message[],
  option: boolean | readonly string[] | undefined,
): Message[] {
  if (option === undefined || option === false) {
    return [];
  }
  if (option === true) {
    return [...messages];
  }
  const wanted = new Set(option);
  return messages.filter((message) => {
    const sourceId = getMessageSource(message)?.sourceId;
    return sourceId !== undefined && wanted.has(sourceId);
  });
}

/** Returns `true` when `provider` also implements {@link HistoryProvider}. */
export function isHistoryProvider(provider: ContextProvider): provider is HistoryProvider {
  const candidate = provider as Partial<HistoryProvider>;
  return typeof candidate.getMessages === 'function' && typeof candidate.saveMessages === 'function';
}

/** Mutable state accumulated by the providers of one run. */
export interface RunContextAccumulator {
  messages: Message[];
  instructions: string[];
  tools: Tool[];
}

/** Builds the {@link ProviderRunContext} handed to a single provider. */
export function createProviderRunContext(
  provider: ContextProvider,
  base: {
    agent: ProviderAgentInfo;
    session: AgentSession;
    inputMessages: readonly Message[];
    accumulator: RunContextAccumulator;
    signal?: AbortSignal;
  },
): ProviderRunContext {
  const sourceType = sourceTypeOf(provider);
  const ctx: ProviderRunContext = {
    agent: base.agent,
    session: base.session,
    state: base.session.partition(provider.sourceId),
    inputMessages: base.inputMessages,
    extendMessages(messages) {
      for (const msg of messages) {
        base.accumulator.messages.push(withMessageSource(msg, { sourceType, sourceId: provider.sourceId }));
      }
    },
    extendInstructions(instructions) {
      if (instructions !== '') {
        base.accumulator.instructions.push(instructions);
      }
    },
    extendTools(tools) {
      base.accumulator.tools.push(...tools);
    },
    ...(base.signal === undefined ? {} : { signal: base.signal }),
  };
  return ctx;
}
