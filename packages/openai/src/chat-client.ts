import type {
  ChatClient,
  ChatClientMetadata,
  ChatResponse,
  ChatResponseStream,
  ChatResponseUpdate,
  ClientErrorNormalizer,
  CodeInterpreterToolOptions,
  ContinuationToken,
  FileSearchToolOptions,
  HostedTool,
  MCPToolOptions,
  Message,
  SupportsCodeInterpreterTool,
  SupportsFileSearchTool,
  SupportsMCPTool,
  SupportsWebSearchTool,
  WebSearchToolOptions,
} from '@polymind-inc/agent-framework-core';
import {
  arrayToStream,
  ChatClientError,
  ConfigurationError,
  ContentFilterError,
  chatResponseToUpdates,
  createClientErrorNormalizer,
  createResponseStream,
  guardClientStream,
  mergeChatUpdates,
  NotImplementedError,
  setIfDefined,
} from '@polymind-inc/agent-framework-core';
import OpenAI, { AzureOpenAI } from 'openai';
import type { ParseContext } from './from-openai.js';
import {
  createStreamParseState,
  isTerminalResponseEvent,
  parseResponse,
  parseStreamEvent,
} from './from-openai.js';
import { codeInterpreterTool, fileSearchTool, mcpTool, webSearchTool } from './hosted-tools.js';
import type { OpenAIChatOptions } from './options.js';
import {
  toResponsesInput,
  toResponsesTextFormat,
  toResponsesToolChoice,
  toResponsesTools,
} from './to-openai.js';

/** The options {@link OpenAIChatClient} takes regardless of how the model is decided. */
export interface OpenAIChatClientOptions {
  /**
   * A configured SDK client. Omit to build one from the environment (`OPENAI_API_KEY`).
   *
   * Pass an `AzureOpenAI` instance to talk to Azure OpenAI — there is no separate class.
   */
  client?: OpenAI;
  /**
   * Which OpenAI API to use. **Only `'responses'` is implemented**; anything else throws
   * `NotImplementedError` at construction.
   *
   * Chat Completions is out of scope. To reach a provider that only speaks Chat Completions,
   * point `baseURL` at an OpenAI-compatible Responses endpoint, or implement the `ChatClient`
   * interface directly.
   */
  api?: 'responses' | 'chat_completions';
  /** Convenience for `new OpenAI({ apiKey })` when `client` is omitted. */
  apiKey?: string;
  /** Convenience for `new OpenAI({ baseURL })` when `client` is omitted. */
  baseURL?: string;
  /**
   * Whether to ask for `reasoning.encrypted_content` on requests whose transcript is replayed from
   * this side. Defaults to `true`.
   *
   * A reasoning model needs its opaque reasoning payload back to accept a replayed transcript, so
   * the request asks for it whenever there is no service-side storage to hold it. Set this to
   * `false` for an endpoint whose deployments do not support encrypted reasoning and reject a
   * request that asks for it. Only the implicit request is affected: an entry the caller puts in
   * `include` themselves is always sent.
   */
  includeReasoningEncryptedContent?: boolean;
}

/**
 * Construction options for {@link OpenAIChatClient}.
 *
 * `model` is required, except behind the explicit {@link EndpointNamedModel} opt-in: forgetting it
 * is a misconfiguration worth catching at compile time rather than as a service 400.
 */
export type OpenAIChatClientConfig = OpenAIChatClientOptions & (NamedModel | EndpointNamedModel);

/** The ordinary case: the caller names the model or Azure deployment. */
export interface NamedModel {
  model: string;
  endpointProvidesModel?: false;
}

/**
 * The endpoint itself decides what answers, so no model is named.
 *
 * The case this exists for is a Foundry server agent: it is addressed by its own endpoint and the
 * agent definition picks the model, so the request carries no `model` at all — which is what .NET
 * does explicitly (`Patch.Remove("$.model")`) and Go by leaving it unset. Inventing a placeholder
 * would put a name that identifies nothing on the wire, in `metadata.modelId`, and in every
 * telemetry span. The opt-in is explicit so that an ordinary misconfiguration cannot reach it.
 */
export interface EndpointNamedModel {
  model?: undefined;
  endpointProvidesModel: true;
}

const AZURE_HOST_PATTERN = /\.(openai|cognitiveservices|services\.ai)\.azure\.com|\.azure-api\.net/i;

function detectProviderName(client: OpenAI): string {
  const baseURL = String((client as { baseURL?: unknown }).baseURL ?? '');
  if (AZURE_HOST_PATTERN.test(baseURL)) {
    return 'azure.ai.openai';
  }
  return client instanceof AzureOpenAI ? 'azure.ai.openai' : 'openai';
}

/** What the SDK's request objects offer: a promise that can also hand back the raw response. */
interface APIPromiseLike<T> extends Promise<T> {
  withResponse?: () => Promise<{ data: T; response: { headers?: { get(name: string): string | null } } }>;
}

/** The Azure OpenAI header naming the model snapshot that actually served the request. */
const SERVED_MODEL_HEADER = 'x-ms-served-model';

/** Reads `x-ms-served-model`, ignoring an empty or whitespace-only value (Python parity). */
function servedModelOf(response: { headers?: { get(name: string): string | null } }): string | undefined {
  const raw = response.headers?.get(SERVED_MODEL_HEADER);
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The parse context to use once the served model is known.
 *
 * `ParseContext.model` is the fallback for a response that names no model; overriding it with the
 * served snapshot means both the folded response and every streamed update report what actually
 * ran rather than the deployment alias.
 */
function withServedModel(context: ParseContext, servedModel: string | undefined): ParseContext {
  return servedModel === undefined ? context : { ...context, model: servedModel, servedModel };
}

/**
 * Whether a conversation id names a Responses API conversation *object* — a service-side anchor
 * that stays stable across responses — as opposed to a response id chained through
 * `previous_response_id`, which advances every round.
 *
 * The single spelling of this distinction: the request builder maps the id onto the right wire
 * parameter with it, and the tool loop consults it through `metadata.stableConversationId`.
 */
function isConversationObjectId(id: string): boolean {
  return id.startsWith('conv_');
}

/** Whether a raw Responses API conversation value refers to service-managed history. */
function isServiceConversation(value: unknown): boolean {
  if (typeof value === 'string') {
    return value !== '';
  }
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id !== ''
  );
}

/**
 * The response id a continuation token points at.
 *
 * @throws {ChatClientError} When the token is not one this client issued.
 */
function resumeResponseId(token: ContinuationToken | undefined): string | undefined {
  if (token === undefined) {
    return undefined;
  }
  const responseId = token.responseId;
  if (typeof responseId !== 'string' || responseId === '') {
    throw new ChatClientError(
      'The continuationToken passed to OpenAIChatClient was not issued by it. Pass back the token ' +
        'from a previous response unchanged.',
    );
  }
  return responseId;
}

/**
 * A {@link ChatClient} backed by the OpenAI Responses API.
 *
 * ```ts
 * const client = new OpenAIChatClient({ model: 'gpt-4o' });                  // OPENAI_API_KEY
 * const azure = new OpenAIChatClient({ client: new AzureOpenAI({ ... }), model: 'gpt-4o' });
 * ```
 *
 * The client is a thin adapter over the official SDK: it never re-implements HTTP, retries or
 * authentication. Automatic tool calling is *not* part of this class — it is a separate layer
 * (`withFunctionInvocation`) that `Agent` applies, so this client stays a faithful, inspectable
 * view of one API call.
 *
 * ## Security considerations
 *
 * - **Keep the API key server-side.** A key embedded in browser code is readable by anyone who
 *   loads the page and grants full account access; proxy through your own backend instead.
 * - **Messages leave your process.** Everything in `messages`, including tool results and
 *   retrieved documents, is sent to the provider. Redact before you send, not after.
 * - **`store` is pass-through.** Leaving service-side storage on means the transcript is retained
 *   by the provider; set `store: false` when that is not acceptable.
 */
export class OpenAIChatClient
  implements
    ChatClient<OpenAIChatOptions>,
    SupportsWebSearchTool,
    SupportsFileSearchTool,
    SupportsCodeInterpreterTool,
    SupportsMCPTool
{
  readonly metadata: ChatClientMetadata;
  readonly #client: OpenAI;
  readonly #model: string | undefined;
  readonly #includeReasoningEncryptedContent: boolean;
  /**
   * Normalizes anything thrown around an SDK call into the value this client throws.
   *
   * A cancellation is not a provider failure and must not be laundered into one: hosting maps
   * `AbortError` to `response.incomplete`/`interrupted` and everything else to `response.failed`.
   * The SDK's own abort error is *not* named `AbortError` — `APIUserAbortError` never sets
   * `this.name`, so it arrives as a plain `"Error"` (openai@7 `core/error.mjs`); the normalizer
   * recognizes it by type and converts it to the standards-shaped abort value the rest of the
   * stack matches on, preferring the caller's own abort reason.
   */
  readonly #toClientError: ClientErrorNormalizer = createClientErrorNormalizer({
    abortErrorClass: OpenAI.APIUserAbortError,
    wrap: (error, detail) => {
      // A content-filter rejection is not a transport fault: retrying it never helps, and the
      // caller usually wants to show it rather than log it (Python `_handle_request_error`).
      const code = (error as { code?: unknown } | null)?.code;
      if (error instanceof OpenAI.BadRequestError && code === 'content_filter') {
        return new ContentFilterError(`OpenAI Responses API rejected the request: ${detail}`, {
          cause: error,
          code: 'content_filter',
        });
      }
      return new ChatClientError(`OpenAI Responses API request failed: ${detail}`, { cause: error });
    },
  });

  constructor(config: OpenAIChatClientConfig) {
    if ((config.api ?? 'responses') !== 'responses') {
      throw new NotImplementedError(
        "Only the 'responses' API is implemented; Chat Completions is not on the roadmap. Point " +
          'baseURL at an OpenAI-compatible Responses endpoint, or implement ChatClient directly.',
      );
    }
    // The type already requires one of the two; this catches the JavaScript caller and the
    // `as` cast. An *empty* model is always a mistake — the opt-in spells absence explicitly.
    if (config.model === '' || (config.model === undefined && config.endpointProvidesModel !== true)) {
      throw new ConfigurationError(
        'OpenAIChatClient requires a non-empty model, or endpointProvidesModel: true when the ' +
          'endpoint names what answers.',
      );
    }

    this.#client =
      config.client ??
      new OpenAI({
        ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
        ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
      });
    this.#model = config.model;
    this.#includeReasoningEncryptedContent = config.includeReasoningEncryptedContent ?? true;
    this.metadata = {
      providerName: detectProviderName(this.#client),
      ...(config.model === undefined ? {} : { modelId: config.model }),
      stableConversationId: isConversationObjectId,
    };
  }

  /** The underlying SDK client, for provider features the framework does not model. */
  get client(): OpenAI {
    return this.#client;
  }

  /** Declares the provider-hosted web search tool. See {@link supportsWebSearch}. */
  getWebSearchTool(options?: WebSearchToolOptions): HostedTool {
    return webSearchTool(options);
  }

  /** Declares the provider-hosted file search tool. See {@link supportsFileSearch}. */
  getFileSearchTool(options?: FileSearchToolOptions): HostedTool {
    return fileSearchTool(options);
  }

  /** Declares the provider-hosted code interpreter. See {@link supportsCodeInterpreter}. */
  getCodeInterpreterTool(options?: CodeInterpreterToolOptions): HostedTool {
    return codeInterpreterTool(options);
  }

  /** Declares a remote MCP server the provider calls directly. See {@link supportsMCP}. */
  getMCPTool(options: MCPToolOptions): HostedTool {
    return mcpTool(options);
  }

  /**
   * Builds the Responses API request body.
   *
   * Exposed so callers can inspect exactly what would be sent, and so tests can assert on the
   * mapping without a network round-trip.
   */
  buildRequest(messages: Message[], options?: OpenAIChatOptions): Record<string, unknown> {
    const conversationId = options?.conversationId;
    const previousResponseId = options?.previousResponseId;
    // `conversation` / `previous_response_id` may also arrive through the raw pass-through, and
    // they change how the input list must be built (Python checks the same three keys).
    const extra = options?.additionalProperties ?? {};
    const extraConversation = extra.conversation;
    const extraPreviousResponseId = extra.previous_response_id;
    const usesServiceStorage =
      (conversationId !== undefined && conversationId !== '') ||
      (previousResponseId !== undefined && previousResponseId !== '') ||
      isServiceConversation(extraConversation) ||
      (typeof extraPreviousResponseId === 'string' && extraPreviousResponseId !== '');

    const input = toResponsesInput(messages, { serviceStorage: usesServiceStorage });
    if (input.length === 0) {
      // Python raises the same way ("Messages are required for chat completions"); sending an
      // empty input list would only produce an opaque service 400.
      throw new ChatClientError('Messages are required: the request input would be empty after conversion.');
    }
    const model = options?.model ?? this.#model;
    const request: Record<string, unknown> = {
      // Absent when the endpoint names what answers (see `OpenAIChatClientConfig.model`); the key
      // is omitted rather than sent as null, which the service rejects.
      ...(model === undefined ? {} : { model }),
      input,
    };

    setIfDefined(request, 'instructions', options?.instructions);
    setIfDefined(request, 'temperature', options?.temperature);
    setIfDefined(request, 'top_p', options?.topP);
    setIfDefined(request, 'max_output_tokens', options?.maxTokens);
    setIfDefined(request, 'metadata', options?.metadata);
    setIfDefined(request, 'user', options?.user);
    setIfDefined(request, 'store', options?.store);
    setIfDefined(request, 'truncation', options?.truncation);
    setIfDefined(request, 'reasoning', options?.reasoning);
    setIfDefined(request, 'background', options?.background ?? options?.allowBackgroundResponses);
    setIfDefined(request, 'previous_response_id', previousResponseId);
    if (request.background === true) {
      // The Responses API only lets a response be polled or replayed if it was stored, so a
      // background request that opted out of storage could never be resumed.
      request.store = true;
    }

    // The Responses API has no equivalent for these; dropping them silently matches Python.
    // (`stop`, `seed`, `frequencyPenalty`, `presencePenalty` are Chat Completions concepts.)

    if (conversationId !== undefined && conversationId !== '') {
      if (isConversationObjectId(conversationId)) {
        request.conversation = conversationId;
      } else {
        request.previous_response_id = conversationId;
      }
    }

    const tools = toResponsesTools(options?.tools);
    if (tools !== undefined) {
      request.tools = tools;
      setIfDefined(request, 'tool_choice', toResponsesToolChoice(options?.toolChoice));
      setIfDefined(request, 'parallel_tool_calls', options?.parallelToolCalls);
    }

    const text: Record<string, unknown> = {};
    if (options?.responseFormat !== undefined) {
      text.format = toResponsesTextFormat(options.responseFormat);
    }
    if (options?.verbosity !== undefined) {
      text.verbosity = options.verbosity;
    }
    if (Object.keys(text).length > 0) {
      request.text = text;
    }

    Object.assign(request, options?.additionalProperties ?? {});

    // `include` is *computed*, so it is merged after the raw pass-through rather than before it.
    // Without service-side storage the transcript is replayed from our side, and a reasoning model
    // needs its opaque reasoning payload back or the replay is rejected — an `include` that
    // arrived through `additionalProperties` would otherwise replace the computed list wholesale
    // and disable that silently. Python has one `include` and *appends* to whatever the caller
    // supplied (`_prepare_options`), so the entry can never be lost; doing the merge here
    // reproduces that while leaving "additionalProperties wins" intact for the field itself and
    // for every other key.
    //
    // `includeReasoningEncryptedContent: false` suppresses only the *implicit* request, for an
    // endpoint that rejects it. The caller's own entry is restored either way: with the implicit
    // request off there is nothing else to add it back, so a raw `include` that replaced the typed
    // list would drop an explicit opt-in — the one thing that reaches encrypted reasoning on such
    // an endpoint — as silently as it would have disabled the implicit request.
    const passthroughInclude = request.include;
    if (passthroughInclude === undefined || Array.isArray(passthroughInclude)) {
      const include = [...((passthroughInclude as string[] | undefined) ?? options?.include ?? [])];
      const callerAskedForEncryptedReasoning =
        options?.include?.includes('reasoning.encrypted_content') === true;
      const wanted =
        callerAskedForEncryptedReasoning || (this.#includeReasoningEncryptedContent && !usesServiceStorage);
      if (wanted && !include.includes('reasoning.encrypted_content')) {
        include.push('reasoning.encrypted_content');
      }
      if (include.length > 0) {
        request.include = include;
      }
    }

    return options?.rawRequestTransform?.(request) ?? request;
  }

  /**
   * WORKAROUND, service-side defect: stops pulling an SSE event stream once its terminal event
   * has been yielded, instead of draining to the connection close the way the SDK's own iterator
   * does.
   *
   * Azure AI Foundry's `/openai/v1/responses` holds the socket open for ~5 seconds after
   * `response.completed` and never sends a `[DONE]` sentinel (measured 2026-08-09; the OpenAI
   * platform sends `[DONE]` and closes immediately), so an iterator that waits for the close
   * pays that tail on every streamed round. Returning here lets the enclosing `for await`
   * release the SDK stream — which aborts the request — and skips the idle tail. Against a
   * well-behaved endpoint this is a no-op: nothing is defined after the terminal event, and the
   * close follows it at once.
   *
   * Delete this wrapper (restoring the plain pass-through of the SDK stream) once Foundry ends
   * its streams promptly after the terminal event; the paired test named "releases the SSE
   * stream at the terminal event" documents and pins the behaviour until then.
   *
   * The terminal set is exactly the events the stream parser folds as terminal
   * (`isTerminalResponseEvent`, shared with `parseStreamEvent`); an event the parser does not
   * treat as terminal must not end the iteration early, or the two would disagree about when a
   * stream is over.
   */
  static async *#untilTerminalEvent(events: AsyncIterable<unknown>): AsyncGenerator<unknown> {
    for await (const event of events) {
      yield event;
      if (isTerminalResponseEvent((event as { type?: string }).type)) {
        return;
      }
    }
  }

  getResponse(
    messages: Message[],
    options?: OpenAIChatOptions & { signal?: AbortSignal },
  ): ChatResponseStream<undefined> {
    const resumeId = resumeResponseId(options?.continuationToken);
    // A background request forces `store: true` onto the wire, so parsing
    // has to see the store value that was actually sent, not the caller's original flag —
    // otherwise a genuinely stored response would suppress its conversation id.
    const background = options?.background ?? options?.allowBackgroundResponses;
    const effectiveStore = background === true ? true : options?.store;
    const configuredModel = options?.model ?? this.#model;
    const parseContext: ParseContext = {
      ...(configuredModel === undefined ? {} : { model: configuredModel }),
      ...(effectiveStore === undefined ? {} : { store: effectiveStore }),
    };
    let directResponse: ChatResponse<undefined> | undefined;

    return createResponseStream<ChatResponseUpdate, ChatResponse<undefined>>({
      start: async (ctx) => {
        const requestOptions = options?.signal === undefined ? undefined : { signal: options.signal };

        // Resuming a background response retrieves the existing one; posting the messages again
        // would start a second response.
        if (resumeId !== undefined) {
          if (!ctx.stream) {
            const { data, servedModel } = await this.#callWithHeaders(
              () => this.#client.responses.retrieve(resumeId, undefined, requestOptions),
              options?.signal,
            );
            directResponse = parseResponse(data, withServedModel(parseContext, servedModel));
            return arrayToStream(chatResponseToUpdates(directResponse));
          }
          const replay = await this.#callWithHeaders(
            () => this.#client.responses.retrieve(resumeId, { stream: true }, requestOptions),
            options?.signal,
          );
          return this.#parseStream(
            OpenAIChatClient.#untilTerminalEvent(replay.data as unknown as AsyncIterable<unknown>),
            withServedModel(parseContext, replay.servedModel),
            options?.signal,
          );
        }

        const request = this.buildRequest(messages, options);

        if (!ctx.stream) {
          const { data, servedModel } = await this.#callWithHeaders(
            () =>
              this.#client.responses.create(
                // buildRequest returns the loosely-typed wire shape (unknown keys ride along on
                // purpose); the SDK's param type cannot describe that, so the shape is asserted.
                { ...request, stream: false } as OpenAI.Responses.ResponseCreateParamsNonStreaming,
                requestOptions,
              ),
            options?.signal,
          );
          directResponse = parseResponse(data, withServedModel(parseContext, servedModel));
          return arrayToStream(chatResponseToUpdates(directResponse));
        }

        const created = await this.#callWithHeaders(
          () =>
            this.#client.responses.create(
              { ...request, stream: true } as OpenAI.Responses.ResponseCreateParamsStreaming,
              requestOptions,
            ),
          options?.signal,
        );
        return this.#parseStream(
          OpenAIChatClient.#untilTerminalEvent(created.data as unknown as AsyncIterable<unknown>),
          withServedModel(parseContext, created.servedModel),
          options?.signal,
        );
      },
      finalize: (updates) => directResponse ?? mergeChatUpdates<undefined>(updates),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /**
   * Adapts the SDK's event stream to framework updates.
   *
   * The stream state and parse context are created up front and captured by the `parse` closure;
   * `guardClientStream` supplies the error contract (any failure while iterating or parsing is
   * normalized exactly as a request-phase failure would be).
   */
  #parseStream(
    events: AsyncIterable<unknown>,
    parseContext: ParseContext,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatResponseUpdate> {
    const state = createStreamParseState();
    return guardClientStream(
      events,
      (event) => parseStreamEvent(event, state, parseContext),
      this.#toClientError,
      signal,
    );
  }

  /**
   * Runs an SDK call and reads the response headers alongside its body.
   *
   * Only `x-ms-served-model` is taken: Azure OpenAI returns the *deployment alias* in
   * `response.model` and the snapshot that actually served the request in this header (Python
   * `_extract_served_model`). An SDK request object without `withResponse` — a hand-rolled test
   * double, an older SDK — simply reports no header rather than failing the call.
   */
  async #callWithHeaders<T>(
    fn: () => APIPromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<{ data: T; servedModel?: string }> {
    try {
      const promise = fn();
      if (typeof promise.withResponse !== 'function') {
        return { data: await promise };
      }
      const { data, response } = await promise.withResponse();
      const servedModel = servedModelOf(response);
      return servedModel === undefined ? { data } : { data, servedModel };
    } catch (error) {
      throw this.#toClientError(error, signal);
    }
  }
}
