import type { ResponseStream } from '../streaming/response-stream.js';
import type { JsonSchema, SchemaInput } from '../tools/json-schema.js';
import type { Tool } from '../tools/tool.js';
import type { Message } from '../types/message.js';
import type { ChatResponse, ChatResponseUpdate, ContinuationToken } from '../types/response.js';

/** Identifies the provider behind a {@link ChatClient}. */
export interface ChatClientMetadata {
  /** Used as OpenTelemetry's `gen_ai.provider.name`, for example `'openai'` or `'azure.ai.openai'`. */
  readonly providerName: string;
  readonly modelId?: string;
}

/** How the model should pick tools. */
export type ToolChoice = 'auto' | 'required' | 'none' | { required: string[] };

/** A JSON Schema plus the naming a provider's structured-output mode needs. */
export interface JsonSchemaResponseFormat {
  name?: string;
  description?: string;
  schema: JsonSchema;
  /** Ask the provider to enforce the schema exactly, where supported. */
  strict?: boolean;
}

/** What `responseFormat` accepts: a Standard Schema, a raw JSON Schema, or a named JSON Schema. */
export type ResponseFormat = SchemaInput | JsonSchemaResponseFormat;

/** Provider-independent options for a single model call. */
export interface ChatOptions {
  model?: string;
  /** System prompt for this call. Agent and run instructions are concatenated before this arrives. */
  instructions?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string | string[];
  seed?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  tools?: Tool[];
  toolChoice?: ToolChoice;
  /** Requests structured output; the parsed value lands on `response.value`. */
  responseFormat?: ResponseFormat;
  /** Service-side conversation id, when the provider stores the transcript. */
  conversationId?: string;
  /** Ask the provider to persist the response. Passed through untouched. */
  store?: boolean;
  metadata?: Record<string, unknown>;
  user?: string;
  /** Resumes a background operation. This is the provider's own token, never the agent wrapper. */
  continuationToken?: ContinuationToken;
  /** Lets the provider run in the background and return a `continuationToken` instead of a result. */
  allowBackgroundResponses?: boolean;
  /** Passed through to the provider request verbatim. */
  additionalProperties?: Record<string, unknown>;
}

/** The stream returned by {@link ChatClient.getResponse}. */
export type ChatResponseStream<T = undefined> = ResponseStream<ChatResponseUpdate, ChatResponse<T>>;

/**
 * The provider seam: turn messages into a response.
 *
 * A single method serves both modes. The returned {@link ChatResponseStream} is awaitable *and*
 * iterable, and how the caller consumes it decides whether the provider uses a streaming
 * transport.
 *
 * @typeParam TOptions - Extend {@link ChatOptions} to expose provider-specific options with full
 * type inference, for example `OpenAIChatOptions`.
 */
export interface ChatClient<TOptions extends ChatOptions = ChatOptions> {
  readonly metadata: ChatClientMetadata;
  /**
   * The result's `value` is typed `unknown` at this seam: whether and how structured output is
   * parsed is decided by the layer that knows the format (`Agent` / `withStructuredOutput`), so
   * the interface neither promises a typed value (`any` would let `.value.x` compile unchecked)
   * nor forbids implementations from returning one (`undefined` would).
   */
  getResponse(
    messages: Message[],
    options?: TOptions & { signal?: AbortSignal },
  ): ChatResponseStream<unknown>;
}
