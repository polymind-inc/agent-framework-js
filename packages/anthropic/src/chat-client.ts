import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatClient,
  ChatClientMetadata,
  ChatResponse,
  ChatResponseStream,
  ChatResponseUpdate,
  ClientErrorNormalizer,
  HostedTool,
  McpToolOptions,
  Message,
  SupportsMcpTool,
  SupportsWebSearchTool,
  WebSearchToolOptions,
} from '@polymind-inc/agent-framework-core';
import {
  ChatClientError,
  ConfigurationError,
  chatResponseToUpdates,
  createClientErrorNormalizer,
  createResponseStream,
  guardClientStream,
  mergeChatUpdates,
} from '@polymind-inc/agent-framework-core';
import { arrayToStream, setIfDefined } from '@polymind-inc/agent-framework-core/internal';
import { createStreamParseState, parseMessage, parseStreamEvent } from './from-anthropic.js';
import { mcpTool, webSearchTool } from './hosted-tools.js';
import type { AnthropicChatOptions } from './options.js';
import {
  toAnthropicMessages,
  toAnthropicOutputFormat,
  toAnthropicSystem,
  toAnthropicToolChoice,
  toAnthropicTools,
} from './to-anthropic.js';

/**
 * Messages API requires `max_tokens`.
 *
 * The value matches `ANTHROPIC_DEFAULT_MAX_TOKENS` in the Python reference implementation
 * (microsoft/agent-framework), so an agent that does not set one behaves the same across
 * implementations.
 */
export const DEFAULT_MAX_TOKENS = 1024;

/**
 * Beta flags sent on every request, matching `BETA_FLAGS` in the Python reference implementation
 * (microsoft/agent-framework).
 *
 * They keep remote MCP servers (`mcp_servers`) and code execution usable without per-call opt-in.
 * Flags from {@link AnthropicChatOptions.betas} are merged on top.
 */
export const DEFAULT_BETA_FLAGS: readonly string[] = ['mcp-client-2025-04-04', 'code-execution-2025-08-25'];

/**
 * The minimal surface {@link AnthropicChatClient} needs from the SDK's **beta** Messages namespace.
 *
 * Requests must go through `client.beta.messages`: only that namespace destructures the body-level
 * `betas` into the `anthropic-beta` header (SDK `resources/beta/messages`). The GA namespace would
 * forward `betas` as an unknown body field, which the API rejects. The beta response and stream
 * event types are structurally compatible with the GA ones for every field the parsers read, so
 * the loose `unknown`-based shape below covers both.
 */
interface MessagesApi {
  /**
   * Returns a promise of a whole message, or (with `stream: true`) an async-iterable stream of
   * events. `unknown` rather than that union: each call site knows which shape it asked for and
   * narrows accordingly, and the union would only force a wrapper to please the type checker.
   */
  create(body: Record<string, unknown>, options?: { signal?: AbortSignal }): unknown;
}

/** Construction options for {@link AnthropicChatClient}. */
export interface AnthropicChatClientConfig {
  /**
   * A configured SDK client. Omit to build one from the environment (`ANTHROPIC_API_KEY`).
   *
   * Pass an `AnthropicBedrock`, `AnthropicVertex` or `AnthropicFoundry` instance to reach Claude
   * through those gateways — the wire format is the same, so there is no separate class.
   */
  client?: Anthropic;
  /** Model name, for example `claude-sonnet-4-5`. */
  model: string;
  /** Convenience for `new Anthropic({ apiKey })` when `client` is omitted. */
  apiKey?: string;
  /** Convenience for `new Anthropic({ baseURL })` when `client` is omitted. */
  baseURL?: string;
  /** Default `max_tokens` for requests that do not set `maxTokens`. Defaults to 1024. */
  defaultMaxTokens?: number;
}

/**
 * A {@link ChatClient} backed by the Anthropic Messages API.
 *
 * ```ts
 * const client = new AnthropicChatClient({ model: 'claude-sonnet-4-5' });   // ANTHROPIC_API_KEY
 * const agent = new Agent({ client, instructions: 'You are helpful.' });
 * ```
 *
 * Like the OpenAI client, this is a thin adapter over the official SDK: HTTP, retries and
 * authentication stay in the SDK, and automatic tool calling is the separate `withFunctionInvocation`
 * layer that `Agent` applies. The request/response mapping mirrors the Python reference
 * implementation (microsoft/agent-framework).
 *
 * ## Security considerations
 *
 * - **Keep the API key server-side.** A key shipped to a browser is readable by anyone who loads
 *   the page and grants full account access.
 * - **Messages leave your process.** Everything in `messages` — tool results and retrieved
 *   documents included — is sent to Anthropic. Redact before sending.
 * - **`mcpTool` points the model at a third-party server.** Its tools run without a human in the
 *   loop and the authorization token is disclosed to it on every call.
 */
export class AnthropicChatClient
  implements ChatClient<AnthropicChatOptions>, SupportsMcpTool, SupportsWebSearchTool
{
  readonly metadata: ChatClientMetadata;
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #defaultMaxTokens: number;
  /**
   * Normalizes anything thrown around an SDK call into the value this client throws, following
   * the `createClientErrorNormalizer` contract: a cancellation passes through as the
   * standards-shaped abort value rather than being laundered into a provider failure.
   *
   * This SDK's specifics: `APIUserAbortError` never sets `this.name`, so it arrives as a plain
   * `"Error"` (@anthropic-ai/sdk `core/error.mjs`) and is recognized by type instead.
   */
  readonly #toClientError: ClientErrorNormalizer = createClientErrorNormalizer({
    abortErrorClass: Anthropic.APIUserAbortError,
    wrap: (error, detail) =>
      new ChatClientError(`Anthropic Messages API request failed: ${detail}`, { cause: error }),
  });

  constructor(config: AnthropicChatClientConfig) {
    if (config.model === '') {
      throw new ConfigurationError('AnthropicChatClient requires a non-empty model.');
    }
    this.#client =
      config.client ??
      new Anthropic({
        ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
        ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
      });
    this.#model = config.model;
    this.#defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    const baseURL = String(this.#client.baseURL ?? '');
    this.metadata = {
      providerName: 'anthropic',
      modelId: config.model,
      ...(baseURL === '' ? {} : { providerUri: baseURL }),
    };
  }

  /** The underlying SDK client, for provider features the framework does not model. */
  get client(): Anthropic {
    return this.#client;
  }

  /** Declares a remote MCP server Anthropic calls directly. See {@link supportsMcp}. */
  getMcpTool(options: McpToolOptions): HostedTool {
    return mcpTool(options);
  }

  /** Declares the provider-hosted web search tool. See {@link supportsWebSearch}. */
  getWebSearchTool(options?: WebSearchToolOptions): HostedTool {
    return webSearchTool(options);
  }

  /**
   * Builds the Messages API request body.
   *
   * Exposed so callers can inspect exactly what would be sent, and so tests can assert on the
   * mapping without a network round-trip.
   */
  buildRequest(messages: Message[], options?: AnthropicChatOptions): Record<string, unknown> {
    const converted = toAnthropicMessages(messages);
    if (converted.length === 0) {
      // The API rejects an empty message list with an opaque 400; Python raises up front too.
      throw new ChatClientError('Messages are required: the request would carry no messages.');
    }

    const request: Record<string, unknown> = {
      model: options?.model ?? this.#model,
      messages: converted,
      max_tokens: options?.maxTokens ?? this.#defaultMaxTokens,
    };

    setIfDefined(request, 'system', toAnthropicSystem(messages, options?.instructions));
    setIfDefined(request, 'temperature', options?.temperature);
    setIfDefined(request, 'top_p', options?.topP);
    setIfDefined(request, 'top_k', options?.topK);
    setIfDefined(request, 'service_tier', options?.serviceTier);
    // Framework option names are camelCase; rebuild the snake_case wire form here.
    const thinking = options?.thinking;
    if (thinking !== undefined) {
      // Re-read through an unknown-shaped view: JavaScript callers and deserialized config can
      // violate the public discriminated union, and must still fail locally rather than at HTTP.
      const rawThinking = thinking as { type?: unknown; budgetTokens?: unknown };
      if (rawThinking.type === 'enabled') {
        if (
          typeof rawThinking.budgetTokens !== 'number' ||
          !Number.isSafeInteger(rawThinking.budgetTokens) ||
          rawThinking.budgetTokens < 1024
        ) {
          throw new ConfigurationError(
            'thinking.budgetTokens must be a safe integer of at least 1024 when thinking is enabled.',
          );
        }
      } else if (rawThinking.type === 'disabled') {
        if (rawThinking.budgetTokens !== undefined) {
          throw new ConfigurationError('thinking.budgetTokens must be omitted when thinking is disabled.');
        }
      } else {
        throw new ConfigurationError(`Unsupported Anthropic thinking type '${String(rawThinking.type)}'.`);
      }
      const { budgetTokens, ...thinkingRest } = thinking;
      request.thinking = {
        ...thinkingRest,
        ...(budgetTokens !== undefined ? { budget_tokens: budgetTokens } : {}),
      };
    }
    setIfDefined(request, 'container', options?.container);
    // Always present, matching Python `_prepare_betas`: the default flags plus any caller-supplied
    // ones, deduplicated. `client.beta.messages` lifts this body-level param into the
    // `anthropic-beta` header.
    request.betas = [...new Set([...DEFAULT_BETA_FLAGS, ...(options?.betas ?? [])])];

    const stop = options?.stop;
    if (stop !== undefined) {
      const sequences = typeof stop === 'string' ? [stop] : stop;
      if (sequences.length > 0) {
        request.stop_sequences = sequences;
      }
    }

    // Messages API has no `user`; the tracking id lives on `metadata.user_id` instead.
    const metadata: Record<string, unknown> = { ...options?.metadata };
    if (options?.user !== undefined && metadata.user_id === undefined) {
      metadata.user_id = options.user;
    }
    if (Object.keys(metadata).length > 0) {
      request.metadata = metadata;
    }

    // `seed`, `frequencyPenalty`, `presencePenalty`, `store` and `conversationId` have no Messages
    // API equivalent and are dropped, matching how Python types them as unavailable.

    const { tools, mcp_servers } = toAnthropicTools(options?.tools);
    if (tools !== undefined) {
      request.tools = tools;
    }
    if (mcp_servers !== undefined) {
      request.mcp_servers = mcp_servers;
    }
    // The choice travels on the option alone, never gated on what this request declares. The
    // function-calling loop's final round withdraws local declarations while pinning the choice to
    // `'none'`, so gating would drop the instruction on exactly the request that exists to send it.
    // Python and Go build it from the option alone too; it is omitted only when none was configured.
    setIfDefined(request, 'tool_choice', toAnthropicToolChoice(options?.toolChoice));

    Object.assign(request, options?.additionalProperties ?? {});

    // After the escape hatch, deliberately: `output_config` has no typed option, so a caller
    // reaching for a sibling setting (adaptive thinking's `effort`) can only do it through
    // `additionalProperties` — and a whole-object assignment there would take `format` with it,
    // silently dropping the structured-output request. Merging keeps both, which is Python's
    // order too (caller kwargs applied first, then `output_config["format"]` set on top).
    if (options?.responseFormat !== undefined) {
      const outputConfig = { ...(request.output_config as Record<string, unknown> | undefined) };
      outputConfig.format = toAnthropicOutputFormat(options.responseFormat);
      request.output_config = outputConfig;
    }

    return options?.rawRequestTransform?.(request) ?? request;
  }

  getResponse(
    messages: Message[],
    options?: AnthropicChatOptions & { signal?: AbortSignal },
  ): ChatResponseStream<undefined> {
    if (options?.continuationToken !== undefined) {
      throw new ChatClientError(
        'AnthropicChatClient does not issue continuation tokens: the Messages API has no background mode.',
      );
    }
    let directResponse: ChatResponse<undefined> | undefined;

    return createResponseStream<ChatResponseUpdate, ChatResponse<undefined>>({
      start: async (ctx) => {
        const request = this.buildRequest(messages, options);
        const requestOptions = options?.signal === undefined ? undefined : { signal: options.signal };
        // The beta namespace, never `this.#client.messages`: see the {@link MessagesApi} contract.
        const messagesApi = this.#client.beta.messages as unknown as MessagesApi;

        if (!ctx.stream) {
          const raw = await this.#call(
            async () => messagesApi.create({ ...request, stream: false }, requestOptions),
            options?.signal,
          );
          directResponse = parseMessage(raw);
          return arrayToStream(chatResponseToUpdates(directResponse));
        }

        const stream = (await this.#call(
          async () => messagesApi.create({ ...request, stream: true }, requestOptions),
          options?.signal,
        )) as AsyncIterable<unknown>;
        return this.#parseStream(stream, options?.signal);
      },
      finalize: (updates) => directResponse ?? mergeChatUpdates<undefined>(updates),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  #parseStream(events: AsyncIterable<unknown>, signal?: AbortSignal): AsyncGenerator<ChatResponseUpdate> {
    const state = createStreamParseState();
    return guardClientStream(events, (event) => parseStreamEvent(event, state), this.#toClientError, signal);
  }

  /** Wraps SDK failures in {@link ChatClientError} while letting cancellation through untouched. */
  async #call<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.#toClientError(error, signal);
    }
  }
}
