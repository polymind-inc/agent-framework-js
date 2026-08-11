import type { Span } from '@opentelemetry/api';
import type { ChatClient, ChatOptions, ResponseFormat } from '../client/chat-client.js';
import type { FunctionInvocationConfig } from '../client/function-invocation.js';
import { withFunctionInvocation } from '../client/function-invocation.js';
import { applyStructuredOutput } from '../client/structured-output.js';
import { withChatTelemetry } from '../client/telemetry.js';
import { APPROVAL_STATE_KEY, sessionApprovalStore, withToolApproval } from '../client/tool-approval.js';
import type {
  ContextProvider,
  HistoryProvider,
  ProviderAfterRunContext,
  ProviderRunContext,
  RunContextAccumulator,
} from '../context/context-provider.js';
import { createProviderRunContext, isHistoryProvider } from '../context/context-provider.js';
import { InMemoryHistoryProvider } from '../context/in-memory-history-provider.js';
import { ConfigurationError } from '../errors.js';
import { runAgentPipeline } from '../middleware/agent-pipeline.js';
import type {
  AgentMiddleware,
  AgentMiddlewareContext,
  FunctionMiddleware,
  Middleware,
} from '../middleware/middleware.js';
import { categorizeMiddleware } from '../middleware/middleware.js';
import { attachRunScope } from '../middleware/run-scope.js';
import { GEN_AI, GEN_AI_OPERATION } from '../observability/attributes.js';
import {
  agentSpanAttributes,
  inActiveSpan,
  recordSpanError,
  setMessageContent,
  setResponseAttributes,
  spanName,
  startSpan,
  withActiveSpan,
} from '../observability/tracing.js';
import type { ResponseStream } from '../streaming/response-stream.js';
import { createResponseStream } from '../streaming/response-stream.js';
import type { StandardSchemaV1 } from '../tools/standard-schema.js';
import type { FunctionTool, Tool } from '../tools/tool.js';
import type { AgentRunInput, Message } from '../types/message.js';
import { normalizeInput } from '../types/message.js';
import type {
  AgentResponse,
  AgentResponseUpdate,
  ChatResponseUpdate,
  ContinuationToken,
} from '../types/response.js';
import { chatResponseToUpdates, chatToAgentUpdate, mergeUpdates } from '../types/response.js';
import type { AgentAsToolOptions } from './as-tool.js';
import { agentAsTool } from './as-tool.js';
import { parseContinuationToken, wrapContinuationToken } from './continuation.js';
import { AgentSession } from './session.js';

/**
 * The hybrid stream returned by {@link Agent.run}: awaitable and iterable.
 *
 * ## Stopping early
 *
 * A caller may stop reading at any point — `break` out of the `for await`, or abort the run's
 * signal. Relaying a run to an HTTP client makes that the normal case rather than the exceptional
 * one, so what each does is part of the contract:
 *
 * - **`break`** closes the underlying provider stream, so the connection is released rather than
 *   left to drain. The run then ends the way a finished one does: context providers get their
 *   `afterRun`, the history provider persists the exchange *as far as it got*, and the
 *   `invoke_agent` span is ended. Structured output is **not** parsed — the text stops wherever
 *   the `break` landed, so parsing it would turn a legitimate `break` into an error. This follows
 *   Go, whose run loop falls through to its `Invoked` calls after the consumer stops; .NET
 *   abandons the run without notifying its providers, so a caller porting between the two should
 *   not assume the transcript matches.
 * - **Abort** ends the run as a failure instead. Providers are told with the error rather than a
 *   response, so a history provider that stores only completed exchanges — the default — writes
 *   nothing for that turn, and the span carries the error.
 *
 * Either way {@link ResponseStream.finalResponse} still returns what was collected, and the
 * teardown runs exactly once no matter which path got there first.
 */
export type AgentRunStream<T = undefined> = ResponseStream<AgentResponseUpdate, AgentResponse<T>>;

/** Maps a `responseFormat` to the type of `response.value`. */
export type StructuredValue<TFormat> = [TFormat] extends [undefined]
  ? undefined
  : TFormat extends StandardSchemaV1<unknown, infer Output>
    ? Output
    : unknown;

/** Per-run options for {@link Agent.run}. */
export interface AgentRunOptions<
  TOptions extends ChatOptions = ChatOptions,
  TFormat extends ResponseFormat | undefined = undefined,
> {
  /** Continues an existing conversation. A fresh session is created when omitted. */
  session?: AgentSession;
  /** Chat options for this run; they take precedence over the agent's `defaultOptions`. */
  options?: Partial<TOptions>;
  /** Extra tools for this run, appended to the agent's tools. */
  tools?: Tool[];
  /** Middleware for this run only, applied inside the agent's own middleware. */
  middleware?: readonly Middleware[];
  /** Requests structured output; the parsed value lands on `response.value`. */
  responseFormat?: TFormat;
  /**
   * Resumes a suspended background run. Pass back the `continuationToken` of the response that
   * produced it, unchanged, and no `input`.
   */
  continuationToken?: ContinuationToken;
  /**
   * Lets the provider answer in the background and hand back a `continuationToken`.
   *
   * Requires an explicit `session`: an auto-created session cannot be reached again, so the token
   * would have nothing to resume into.
   */
  allowBackgroundResponses?: boolean;
  signal?: AbortSignal;
}

/**
 * The minimal agent contract.
 *
 * Orchestration and workflow code depends on this rather than on {@link Agent}, so a custom agent
 * that never touches a {@link ChatClient} still fits.
 */
export interface AgentLike {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  /** `value` is `unknown` at this seam; {@link Agent.run} narrows it via its `responseFormat` parameter. */
  run(
    input?: AgentRunInput,
    options?: AgentRunOptions<ChatOptions, ResponseFormat | undefined>,
  ): AgentRunStream<unknown>;
  createSession(options?: { sessionId?: string; serviceSessionId?: string }): AgentSession;
  deserializeSession(state: unknown): AgentSession;
  /**
   * Exposes this agent as a tool another agent can call.
   *
   * A one-line implementation for a custom agent: `return agentAsTool(this, options);`.
   */
  asTool(options?: AgentAsToolOptions): FunctionTool<Record<string, unknown>, string>;
}

/** Construction options for {@link Agent}. */
export interface AgentConfig<TOptions extends ChatOptions = ChatOptions> {
  client: ChatClient<TOptions>;
  /** System prompt. Concatenated ahead of any per-run instructions. */
  instructions?: string;
  id?: string;
  name?: string;
  description?: string;
  tools?: Tool[];
  /** Chat options applied to every run; per-run options win. */
  defaultOptions?: Partial<TOptions>;
  contextProviders?: ContextProvider[];
  /** Defaults to a fresh {@link InMemoryHistoryProvider}. */
  historyProvider?: HistoryProvider;
  /**
   * Cross-cutting concerns wrapped around every run of this agent.
   *
   * Build entries with `agentMiddleware()` or `functionMiddleware()`. They are collected together
   * with the chat client's own middleware, the context providers' and `run({ middleware })`.
   */
  middleware?: readonly Middleware[];
  functionInvocation?: FunctionInvocationConfig;
}

/**
 * A chat client that carries middleware of its own.
 *
 * Providers do not have to know about middleware: wrap any client with {@link withMiddleware} and
 * the agent picks it up as one of the four collection sites.
 */
interface ClientWithMiddleware {
  readonly middleware?: readonly Middleware[];
}

function concatInstructions(parts: ReadonlyArray<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined && part.trim() !== '');
  return present.length === 0 ? undefined : present.join('\n');
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
}

/**
 * An agent: a chat client plus instructions, tools, history and context providers.
 *
 * ```ts
 * const agent = new Agent({
 *   client: new OpenAIChatClient({ model: 'gpt-4o' }),
 *   instructions: 'You are a helpful assistant.',
 *   tools: [getWeather],
 * });
 *
 * const session = agent.createSession();
 * const response = await agent.run('Hello', { session });          // non-streaming
 * for await (const update of agent.run('And now?', { session })) { } // streaming
 * ```
 *
 * The run pipeline is:
 *
 * 1. `historyProvider.beforeRun` — load the transcript;
 * 2. `contextProviders[].beforeRun` — inject memories, instructions, tools;
 * 3. the chat client call, with the function-calling loop running inside it;
 * 4. `historyProvider.afterRun` and `contextProviders[].afterRun` — persist and learn.
 *
 * The function-calling loop sits *inside* the client layer, so history is saved once per run
 * rather than once per tool round.
 *
 * ## Security considerations
 *
 * - **Everything in the context window is untrusted.** Instructions, history, retrieved documents
 *   and tool results all reach the model as text; any of them can attempt to redirect the agent
 *   (prompt injection). System instructions constrain behaviour, they do not enforce it — put
 *   real authorization checks inside tools and around the agent, never in the prompt.
 * - **Tools execute without confirmation** unless they declare `approvalMode: 'always_require'`.
 *   See {@link FunctionTool}.
 * - **Sessions are a trust boundary.** A session restored from storage replays into the model;
 *   authorize the caller before restoring, and never share one session across users.
 * - **Model output is untrusted output.** Do not pass `response.text` to a shell, a SQL query, an
 *   `eval`, or an HTML sink without escaping it.
 * - **Instructions are not secret.** A determined user can usually get the model to reveal them.
 *
 * @typeParam TOptions - The chat client's option type, so provider-specific options stay typed
 * through `run({ options })`.
 */
export class Agent<TOptions extends ChatOptions = ChatOptions> implements AgentLike {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: string;

  readonly #client: ChatClient<TOptions>;
  readonly #tools: Tool[];
  readonly #defaultOptions: Partial<TOptions>;
  /**
   * The provider that owns this agent's transcript.
   *
   * Exposed for hosting layers, where the platform owns the transcript instead: they need to know
   * which slot of {@link AgentSession.state} to clear so the same history is not replayed twice.
   */
  readonly historyProvider: HistoryProvider;
  /**
   * `true` when the caller supplied `historyProvider` rather than letting it default.
   *
   * A hosting layer refuses such an agent: two things claiming the transcript is a configuration
   * error, not something to resolve at runtime.
   */
  readonly hasExplicitHistoryProvider: boolean;

  readonly #contextProviders: ContextProvider[];
  readonly #functionInvocation: FunctionInvocationConfig;
  readonly #agentMiddleware: readonly AgentMiddleware[];

  constructor(config: AgentConfig<TOptions>) {
    this.id = config.id ?? crypto.randomUUID();
    if (config.name !== undefined) this.name = config.name;
    if (config.description !== undefined) this.description = config.description;
    if (config.instructions !== undefined) this.instructions = config.instructions;

    this.#tools = config.tools ?? [];
    this.#defaultOptions = config.defaultOptions ?? {};
    this.hasExplicitHistoryProvider = config.historyProvider !== undefined;
    this.historyProvider = config.historyProvider ?? new InMemoryHistoryProvider();
    this.#contextProviders = config.contextProviders ?? [];

    for (const provider of this.#contextProviders) {
      if (isHistoryProvider(provider)) {
        throw new ConfigurationError(
          `Context provider '${provider.sourceId}' is a HistoryProvider; pass it as 'historyProvider' instead.`,
        );
      }
    }
    this.#validateProviderStateKeys();

    // Three of the four collection sites are fixed when the agent is built; the fourth is the run
    // itself. Provider-supplied middleware is read here rather than per run on
    // purpose: an agent middleware wraps the whole run, including the `beforeRun` hooks that would
    // otherwise have to discover it, so the set has to be known before the run starts.
    const collected = categorizeMiddleware(
      config.middleware,
      ...this.#contextProviders.map((provider) => provider.middleware),
      this.historyProvider.middleware,
      (config.client as ClientWithMiddleware).middleware,
    );
    this.#agentMiddleware = collected.agent;

    // The function-calling loop is a chat-client layer, so it runs inside one agent run.
    // Structured output is applied by the agent itself, after the loop.
    // Telemetry sits *inside* the loop, so each round gets its own `chat` span that closes before
    // that round's tools run.
    this.#functionInvocation = config.functionInvocation ?? {};
    this.#client = withFunctionInvocation(withChatTelemetry(config.client), {
      ...this.#functionInvocation,
      middleware: [...(this.#functionInvocation.middleware ?? []), ...collected.function],
    });
  }

  /** Fails fast when two providers would write to the same slot of {@link AgentSession.state}. */
  #validateProviderStateKeys(): void {
    // The approval layer stores its pending requests under a framework-reserved slot; a provider
    // claiming the same key would silently corrupt the approval binding state.
    const owners = new Map<string, string>([[APPROVAL_STATE_KEY, 'the framework tool-approval layer']]);
    for (const provider of [this.historyProvider, ...this.#contextProviders]) {
      const keys = [provider.sourceId, ...(provider.stateKeys ?? [])];
      for (const key of keys) {
        const existing = owners.get(key);
        if (existing !== undefined) {
          throw new ConfigurationError(
            `Session state key '${key}' is claimed by both '${existing}' and '${provider.sourceId}'. ` +
              'Give each provider a unique sourceId and stateKeys.',
          );
        }
        owners.set(key, provider.sourceId);
      }
    }
  }

  createSession(options?: { sessionId?: string; serviceSessionId?: string }): AgentSession {
    return new AgentSession(options);
  }

  /** Restores a session from {@link AgentSession.toJSON} output (or its parsed JSON). */
  deserializeSession(state: unknown): AgentSession {
    return AgentSession.fromJSON(state);
  }

  /**
   * Exposes this agent as a tool another agent can call.
   *
   * ```ts
   * const writer = new Agent({ client, tools: [researcher.asTool()] });
   * ```
   *
   * See {@link agentAsTool} for the semantics and the security note.
   */
  asTool(options?: AgentAsToolOptions): FunctionTool<Record<string, unknown>, string> {
    return agentAsTool(this, options);
  }

  /**
   * Runs the agent.
   *
   * The result is both a promise and an async iterable; the first use decides whether the
   * provider streams. It can only be consumed once — use `finalResponse()` to fold a stream you
   * have already iterated.
   *
   * @param input - A string, content item, message, or an array of those.
   * @param options - Session, per-run chat options, extra tools, structured output, cancellation.
   */
  run<TFormat extends ResponseFormat | undefined = undefined>(
    input?: AgentRunInput,
    options?: AgentRunOptions<TOptions, TFormat>,
  ): AgentRunStream<StructuredValue<TFormat>> {
    // Run-level middleware is applied inside the agent's own, so the agent's outermost layer sees
    // everything a single call adds (Python appends run middleware after the base list).
    const perRun = categorizeMiddleware(options?.middleware);
    const chain = [...this.#agentMiddleware, ...perRun.agent];
    const callerMessages = normalizeInput(input);

    // Go `prepareRun`: a resumed background run carries its own input, so accepting more would
    // silently drop it.
    if (options?.continuationToken !== undefined && callerMessages.length > 0) {
      throw new ConfigurationError(
        'Messages are not allowed when resuming a background response with a continuationToken.',
      );
    }
    if (options?.allowBackgroundResponses === true && options.session === undefined) {
      // An auto-created session dies with the call, leaving no way to resume — so refuse up front
      // rather than hand back a token nothing can redeem (Go `prepareRun`). Checked here rather
      // than in the inner run because the middleware layer resolves a session for every run.
      throw new ConfigurationError('A session must be provided when allowBackgroundResponses is enabled.');
    }

    if (chain.length === 0) {
      return this.#runCore(callerMessages, options, undefined, perRun.function);
    }
    return this.#runWithMiddleware(chain, perRun.function, callerMessages, options);
  }

  /**
   * Wraps one run in its agent middleware.
   *
   * The chain runs inside `start`, where the caller's consumption mode is already known, so
   * `ctx.stream` is accurate and the inner run is created with whatever the middleware left in the
   * context.
   */
  #runWithMiddleware<TFormat extends ResponseFormat | undefined>(
    chain: readonly AgentMiddleware[],
    functionMiddleware: readonly FunctionMiddleware[],
    callerMessages: Message[],
    options: AgentRunOptions<TOptions, TFormat> | undefined,
  ): AgentRunStream<StructuredValue<TFormat>> {
    type Final = AgentResponse<StructuredValue<TFormat>>;
    const signal = options?.signal;
    let pipeline: { updates: AsyncIterable<AgentResponseUpdate>; final: () => Promise<Final> } | undefined;

    return createResponseStream<AgentResponseUpdate, Final>({
      start: async (ctx): Promise<AsyncIterable<AgentResponseUpdate>> => {
        // Resolved here rather than inside the inner run so middleware can read and write session
        // state before the agent touches it.
        const session = options?.session ?? this.createSession();
        pipeline = await runAgentPipeline<Final>({
          middleware: chain,
          agent: { id: this.id, ...(this.name === undefined ? {} : { name: this.name }) },
          session,
          messages: [...callerMessages],
          tools: [...(options?.tools ?? [])],
          options: { ...options?.options },
          stream: ctx.stream,
          ...(signal === undefined ? {} : { signal }),
          invoke: (mwCtx: AgentMiddlewareContext) =>
            this.#runCore<TFormat>(
              mwCtx.messages,
              {
                ...options,
                session,
                tools: mwCtx.tools,
                options: mwCtx.options as Partial<TOptions>,
              },
              session,
              functionMiddleware,
            ),
        });
        return pipeline.updates;
      },
      // The pipeline owns the result: an awaited run folded inside the inner stream, and a
      // middleware may have replaced it outright. Re-folding the updates here would lose both.
      finalize: (): Promise<Final> => (pipeline as { final: () => Promise<Final> }).final(),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  #runCore<TFormat extends ResponseFormat | undefined>(
    callerMessages: Message[],
    options: AgentRunOptions<TOptions, TFormat> | undefined,
    presetSession: AgentSession | undefined,
    functionMiddleware: readonly FunctionMiddleware[],
  ): AgentRunStream<StructuredValue<TFormat>> {
    const continuation = parseContinuationToken(options?.continuationToken);
    const resuming = continuation.innerToken !== undefined;
    const inputMessages = resuming ? continuation.inputMessages : callerMessages;

    const signal = options?.signal;
    // The effective format follows the same precedence as #mergeOptions, so a format supplied
    // through `defaultOptions` or `run({ options })` fills `response.value` too.
    // Only the explicit `responseFormat` parameter carries the static type, hence `StructuredValue`.
    const responseFormat: ResponseFormat | undefined =
      options?.responseFormat ?? options?.options?.responseFormat ?? this.#defaultOptions.responseFormat;

    let providerContexts: Array<{ provider: ContextProvider; ctx: ProviderRunContext }> = [];
    let afterRunDone = false;
    let activeSession: AgentSession | undefined;
    // The `invoke_agent` span covers the whole run, including the tool loop and history
    // persistence, so it is started in `start` and closed by hand rather than around a call.
    let runSpan: Span | undefined;
    let runFailure: unknown;

    /** Ends the run span once, on whichever path gets there first. */
    const endRunSpan = (): void => {
      if (runSpan === undefined) {
        return;
      }
      if (runFailure !== undefined) {
        recordSpanError(runSpan, runFailure);
      }
      runSpan.end();
      runSpan = undefined;
    };

    const runAfterRun = async (response?: AgentResponse<unknown>, error?: unknown): Promise<void> => {
      if (afterRunDone) {
        return;
      }
      afterRunDone = true;
      // The session can become service-managed while the run is in flight, which retires the
      // default history provider for this run: its stored transcript is no longer the source of
      // truth, so appending to it would make the next run replay messages the service also sends
      // (Go `shouldStoreHistoryProvider`).
      const serviceOwnsHistory = activeSession?.serviceSessionId !== undefined;
      for (const { provider, ctx } of providerContexts) {
        if (provider.afterRun === undefined) {
          continue;
        }
        if (serviceOwnsHistory && provider === this.historyProvider) {
          continue;
        }
        const afterCtx: ProviderAfterRunContext = {
          ...ctx,
          ...(response === undefined ? {} : { response }),
          ...(error === undefined ? {} : { error }),
        };
        await provider.afterRun(afterCtx);
      }
    };

    /**
     * Fails a run where both the service and an explicit history provider claim the transcript.
     *
     * Go `handleHistoryProviderConflict`. Checked again after the run because the session can be
     * promoted to service-managed while it is in flight.
     */
    const rejectHistoryConflict = (session: AgentSession): void => {
      if (session.serviceSessionId !== undefined && this.hasExplicitHistoryProvider) {
        throw new ConfigurationError(
          `Session '${session.sessionId}' has a serviceSessionId, so the service manages history, ` +
            'but this agent was configured with an explicit historyProvider. Use one or the other.',
        );
      }
    };

    const start = async (ctx: { stream: boolean }): Promise<AsyncIterable<AgentResponseUpdate>> => {
      const session = presetSession ?? options?.session ?? this.createSession();
      activeSession = session;
      rejectHistoryConflict(session);
      const usesServiceHistory = session.serviceSessionId !== undefined;

      const accumulator: RunContextAccumulator = { messages: [], instructions: [], tools: [] };
      // When the service owns the transcript, the default in-memory history provider steps aside.
      const providers: ContextProvider[] = usesServiceHistory
        ? [...this.#contextProviders]
        : [this.historyProvider, ...this.#contextProviders];

      providerContexts = providers.map((provider) => ({
        provider,
        ctx: createProviderRunContext(provider, {
          agent: { id: this.id, ...(this.name === undefined ? {} : { name: this.name }) },
          session,
          inputMessages,
          accumulator,
          ...(signal === undefined ? {} : { signal }),
        }),
      }));

      // A resumed run re-enters mid-exchange: history and context were already applied when the
      // operation started, so only the `afterRun` half runs (Go `historyProviderForRun`).
      if (!resuming) {
        for (const { provider, ctx: providerCtx } of providerContexts) {
          await provider.beforeRun?.(providerCtx);
        }
      }

      const messages: Message[] = resuming ? [] : [...accumulator.messages, ...inputMessages];
      const chatOptions = this.#mergeOptions(
        options,
        accumulator,
        session,
        continuation.innerToken,
        functionMiddleware,
      );
      const client = withToolApproval(this.#client, sessionApprovalStore(session), {
        ...(this.#functionInvocation.additionalTools === undefined
          ? {}
          : { additionalTools: this.#functionInvocation.additionalTools }),
      });

      runSpan = startSpan(
        spanName(GEN_AI_OPERATION.invokeAgent, this.name ?? this.id),
        agentSpanAttributes({
          id: this.id,
          ...(this.name === undefined ? {} : { name: this.name }),
          ...(this.description === undefined ? {} : { description: this.description }),
          providerName: this.#client.metadata.providerName,
          ...(chatOptions.model === undefined ? {} : { model: chatOptions.model }),
          ...(session.serviceSessionId === undefined ? {} : { conversationId: session.serviceSessionId }),
        }),
      );
      setMessageContent(runSpan, GEN_AI.inputMessages, messages);
      const inner = client.getResponse(messages, chatOptions);
      const span = runSpan;
      const agentName = this.name;
      const agentId = this.id;
      // Everything the caller will have seen by the time a token is issued, so a resumed run can
      // persist the whole exchange rather than just its tail (Go `continuationUpdates`).
      const seen: AgentResponseUpdate[] = [...continuation.updates];
      const wantsTokenReplay = ctx.stream;

      /**
       * Keeps a service-managed session pointing at the newest turn.
       *
       * Runs per update rather than at the end (Python `_propagate_conversation_id`) so a caller
       * who abandons a stream still holds a session that can continue the conversation.
       *
       * A session that is *not* already service-managed is never promoted here: with `store`
       * defaulting to on, every response carries an id, and adopting one would silently move the
       * transcript from the framework to the provider. Handing the framework a conversation id is
       * the caller's decision to make.
       */
      const stableConversationId = this.#client.metadata.stableConversationId;
      const propagateConversationId = (update: ChatResponseUpdate): void => {
        const conversationId = update.conversationId;
        const current = session.serviceSessionId;
        if (
          conversationId === undefined ||
          conversationId === '' ||
          current === undefined ||
          current === conversationId
        ) {
          return;
        }
        // An anchor the provider declares stable stays the session's id: a per-response id
        // reported mid-run must not unhook the session from the stored conversation. The same
        // guard the function-calling loop applies between tool rounds, applied where the
        // reference puts it — on the session update itself (Go `updateConversationID`).
        if (stableConversationId?.(current) === true) {
          return;
        }
        session.serviceSessionId = conversationId;
      };

      const mapUpdate = (update: ChatResponseUpdate): AgentResponseUpdate => {
        propagateConversationId(update);
        const mapped = chatToAgentUpdate(update, {
          ...(agentName === undefined ? {} : { agentName }),
          agentId,
        });
        seen.push(mapped);
        if (mapped.continuationToken !== undefined) {
          // Both halves ride on the same gate (Go `agent.go`): an awaited run folds its own
          // updates *and* has already persisted its own input, so carrying either in the token
          // makes the resumed run store the exchange a second time.
          mapped.continuationToken = wrapContinuationToken(
            mapped.continuationToken,
            wantsTokenReplay ? inputMessages : [],
            wantsTokenReplay ? seen : [],
          );
        }
        return mapped;
      };

      const carried = continuation.updates;

      async function* pipe(): AsyncGenerator<AgentResponseUpdate> {
        try {
          // The updates the suspended run already produced come first, so a resumed stream reads
          // as one continuous response.
          yield* carried;
          if (ctx.stream) {
            // Driven inside the run span so the tool loop's `chat` and `execute_tool` spans become
            // its children — the generator body would otherwise run outside any span context.
            for await (const update of withActiveSpan(span, inner)) {
              yield mapUpdate(update);
            }
          } else {
            const response = await inActiveSpan(span, () => inner);
            for (const update of chatResponseToUpdates(response)) {
              yield mapUpdate(update);
            }
          }
        } catch (error) {
          runFailure = error;
          await runAfterRun(undefined, error);
          throw error;
        }
      }
      return pipe();
    };

    const finalize = (updates: AgentResponseUpdate[]): AgentResponse<StructuredValue<TFormat>> => {
      const response = mergeUpdates<StructuredValue<TFormat>>(updates);
      response.agentId = this.id;
      if (this.name !== undefined) {
        for (const msg of response.messages) {
          msg.authorName ??= this.name;
        }
      }
      return response;
    };

    return createResponseStream<AgentResponseUpdate, AgentResponse<StructuredValue<TFormat>>>({
      start,
      finalize,
      onResult: [
        async (response, resultCtx) => {
          try {
            // Re-checked here because the session may have been promoted to service-managed during
            // the run; storing into an explicit provider now would fork the transcript.
            if (activeSession !== undefined) {
              rejectHistoryConflict(activeSession);
            }
            if (runSpan !== undefined) {
              setResponseAttributes(runSpan, response);
              setMessageContent(runSpan, GEN_AI.outputMessages, response.messages);
            }
            // Persist first, parse second. The model answered:
            // whether the answer happens to satisfy the caller's schema does not change what was
            // said, and parsing before persisting loses the whole exchange — the next turn then
            // replays a conversation with a hole in it, so the model cannot even be asked to fix
            // its own output.
            await runAfterRun(response, undefined);
            // A caller who stopped iterating early asked for *this much* of the run, not for a
            // finished answer: the text is truncated wherever the `break` landed, so parsing it
            // would make the `break` itself throw. Both reference implementations parse lazily
            // (.NET `AgentResponse{T}.Result`, Python `AgentResponse.value`) and therefore never
            // raise on abandonment; this framework's eager parse has to skip it explicitly,
            // exactly as it already skips the suspended states.
            if (responseFormat !== undefined && !resultCtx.abandoned) {
              await applyStructuredOutput(response, responseFormat);
            }
            return response;
          } catch (error) {
            runFailure = error;
            // A parse failure arrives after `afterRun` has already run for the success path;
            // `runAfterRun` is once-only, so providers are not told twice.
            await runAfterRun(undefined, error);
            throw error;
          } finally {
            endRunSpan();
          }
        },
      ],
      cleanup: [
        async (cleanupFailure?: unknown): Promise<void> => {
          // Cleanup runs before finalization, so on the happy path the span stays open for the
          // response attributes. A source failure never reaches `onResult`, so it ends here — and
          // the hook's `failure` parameter covers deaths the pipeline never sees (an abort between
          // pulls, a consumer `iterator.throw()`).
          runFailure ??= cleanupFailure;
          try {
            // Providers are told about a failed run wherever it died, not only when the failure
            // travelled through the source generator. .NET notifies them from the `catch` around
            // every `MoveNextAsync()` (`ChatClientAgent.RunCoreStreamingAsync` →
            // `NotifyProvidersOfFailureAtEndOfRunAsync`), which is where a cancellation between
            // pulls lands there. Here the equivalent abort is raised by `throwIfAborted` *outside*
            // the generator, so `pipe()`'s own `catch` never sees it — and neither does a consumer
            // `iterator.throw()`, which closes the generator with a return completion. Without this
            // the run would end with no `afterRun` at all, so a provider holding resources for the
            // run never gets told to let go. `runAfterRun` is once-only, so the paths that already
            // reported the failure from `pipe()` do not report it twice.
            if (cleanupFailure !== undefined) {
              await runAfterRun(undefined, cleanupFailure);
            }
          } finally {
            if (runFailure !== undefined) {
              endRunSpan();
            }
          }
        },
      ],
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * Merges agent-level and run-level chat options.
   *
   * Follows .NET `ChatClientAgent.CreateConfiguredChatOptions`: run options win and agent options
   * fill the blanks, instructions are concatenated agent-first, and tools and stop sequences are
   * concatenated run-first. Context-provider contributions are appended last.
   */
  #mergeOptions(
    options: AgentRunOptions<TOptions, ResponseFormat | undefined> | undefined,
    accumulator: RunContextAccumulator,
    session: AgentSession,
    innerContinuationToken: ContinuationToken | undefined,
    functionMiddleware: readonly FunctionMiddleware[],
  ): TOptions & { signal?: AbortSignal } {
    const agentOptions: Partial<ChatOptions> = this.#defaultOptions;
    const runOptions: Partial<ChatOptions> = options?.options ?? {};

    const merged = { ...agentOptions, ...runOptions } as TOptions & { signal?: AbortSignal };

    const instructions = concatInstructions([
      this.instructions,
      agentOptions.instructions,
      runOptions.instructions,
      ...accumulator.instructions,
    ]);
    if (instructions === undefined) {
      delete merged.instructions;
    } else {
      merged.instructions = instructions;
    }

    const tools: Tool[] = [
      ...(options?.tools ?? []),
      ...(runOptions.tools ?? []),
      ...this.#tools,
      ...(agentOptions.tools ?? []),
      ...accumulator.tools,
    ];
    if (tools.length === 0) {
      delete merged.tools;
    } else {
      merged.tools = tools;
    }

    const stop = [...toArray(runOptions.stop), ...toArray(agentOptions.stop)];
    if (stop.length === 0) {
      delete merged.stop;
    } else {
      merged.stop = stop;
    }

    const additionalProperties = { ...agentOptions.additionalProperties, ...runOptions.additionalProperties };
    if (Object.keys(additionalProperties).length === 0) {
      delete merged.additionalProperties;
    } else {
      merged.additionalProperties = additionalProperties;
    }

    if (options?.responseFormat !== undefined) {
      merged.responseFormat = options.responseFormat;
    }
    // The provider gets its own token back, not the agent-level wrapper around it.
    if (innerContinuationToken !== undefined) {
      merged.continuationToken = innerContinuationToken;
    } else {
      delete merged.continuationToken;
    }
    if (options?.allowBackgroundResponses !== undefined) {
      merged.allowBackgroundResponses = options.allowBackgroundResponses;
    }
    if (session.serviceSessionId !== undefined && merged.conversationId === undefined) {
      merged.conversationId = session.serviceSessionId;
    }
    if (options?.signal !== undefined) {
      merged.signal = options.signal;
    }
    // Run-scoped values for the client layers, on a symbol key so they never reach the provider.
    attachRunScope(merged, { middleware: functionMiddleware, session });
    return merged;
  }
}
