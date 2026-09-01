import type { AgentSession } from '../agent/session.js';
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
  /**
   * The endpoint requests go to, as an absolute URL.
   *
   * Its host becomes `server.address` on chat spans and on the chat metrics. Leave it unset when
   * the client has no single endpoint; the address is then reported as `'unknown'` rather than
   * dropped, so a dashboard's dimension set stays the same shape across providers.
   */
  readonly providerUri?: string;
  /**
   * Whether `conversationId` names a service-side anchor that stays stable across responses, as
   * opposed to a per-response chain that must advance to each round's reported id.
   *
   * Two places consult this: the function-calling loop between tool rounds, and the agent's
   * session propagation when a run reports conversation ids. In both, an id the provider declares
   * stable is never displaced by the id a response reports, so a service-held conversation cannot
   * be unhooked by a response-chain fallback mid-run. Absent means no id is stable — every
   * reported id advances the chain, which is also correct for providers whose stable ids are
   * simply re-reported unchanged each round.
   */
  readonly stableConversationId?: (conversationId: string) => boolean;
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

/**
 * An optional capability of a {@link ChatClient}: a view of itself bound to one run's session.
 *
 * A chat client is shared by every session that uses the agent, and `getResponse` is handed
 * messages and options — never the session. That is right for a provider that only translates a
 * request, and not enough for one whose service mints an identifier the *session* has to keep and
 * echo on every later request. There is nowhere in a plain client to put such a value: on the
 * client it would leak between sessions, and the caller cannot supply it because the service only
 * issues it once a run is already under way.
 *
 * A client that implements this is asked, once per run, for a client bound to that run's session.
 * The returned client sits inside the function-calling loop, so it wraps **every** service call of
 * the run — the second and third rounds of a tool loop as much as the first — on awaited and
 * streamed runs alike. `Agent` reads this capability off the client it was constructed with, the
 * same way it collects that client's middleware.
 *
 * Write the bound client as an ordinary wrapper. Nothing else is required of it:
 *
 * ```ts
 * class MyChatClient implements ChatClient<MyOptions>, SessionScopedChatClient<MyOptions> {
 *   forSession(session: AgentSession): ChatClient<MyOptions> {
 *     return {
 *       metadata: this.metadata,
 *       getResponse: (messages, options) => {
 *         const kept = session.state.myServiceTicket;
 *         const stream = this.getResponse(messages, withTicket(options, kept));
 *         // …record a ticket the response carries back onto `session.state`
 *         return stream;
 *       },
 *     };
 *   }
 * }
 * ```
 *
 * ## What the bound client owes
 *
 * - **Keep per-session state on the session**, in {@link AgentSession.state}, not on the client.
 *   Two sessions must never see each other's values, and session state is what survives
 *   serialization.
 * - **Do not mutate the caller's options.** Copy, then add.
 * - Return a client, not a promise: this runs on the hot path of every round.
 *
 * ## Declaring it through a wrapper
 *
 * `Agent` looks for this on the client it was constructed with, so a wrapper stands between them.
 * `withMiddleware` carries it over, as it already carries the hosted-tool capability methods —
 * that is the wrapper meant for wrapping a client on the way in.
 *
 * The other exported client layers (`withChatTelemetry`, `withToolApproval`,
 * `withFunctionInvocation`, `withStructuredOutput`) do not, and are not meant to: `Agent` applies
 * each of them itself, so applying one before constructing an agent doubles a layer rather than
 * adding one. A client wrapped that way loses this capability along with its hosted-tool ones.
 */
export interface SessionScopedChatClient<TOptions extends ChatOptions = ChatOptions> {
  /**
   * Returns a client bound to `session`, called once per run before the first service call.
   *
   * @param session - The run's session. Always resolved — a run without an explicit session still
   * has one.
   */
  forSession(session: AgentSession): ChatClient<TOptions>;
}
