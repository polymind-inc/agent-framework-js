import type { AgentSession } from '../agent/session.js';
import type { Middleware } from '../middleware/middleware.js';
import type { Tool } from '../tools/tool.js';
import type { Message, MessageSourceType } from '../types/message.js';
import { withMessageSource } from '../types/message.js';
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
 */
export interface HistoryProvider extends ContextProvider {
  /** Returns the stored transcript, oldest first. */
  getMessages(session: AgentSession, state: Record<string, unknown>): Promise<Message[]>;
  /** Appends `messages` to the stored transcript. */
  saveMessages(session: AgentSession, messages: Message[], state: Record<string, unknown>): Promise<void>;
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
