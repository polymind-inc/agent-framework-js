/**
 * OpenTelemetry GenAI semantic-convention attribute and operation names.
 *
 * The values are matched against Python's `OtelAttr` so traces from the TypeScript, Python, .NET
 * and Go implementations are queryable with the same dashboards.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
 */
export const GEN_AI = {
  operation: 'gen_ai.operation.name',
  providerName: 'gen_ai.provider.name',
  errorType: 'error.type',

  // Request
  requestModel: 'gen_ai.request.model',
  temperature: 'gen_ai.request.temperature',
  topP: 'gen_ai.request.top_p',
  maxTokens: 'gen_ai.request.max_tokens',
  seed: 'gen_ai.request.seed',
  frequencyPenalty: 'gen_ai.request.frequency_penalty',
  presencePenalty: 'gen_ai.request.presence_penalty',
  stopSequences: 'gen_ai.request.stop_sequences',
  outputType: 'gen_ai.output.type',
  conversationId: 'gen_ai.conversation.id',

  // Response
  responseId: 'gen_ai.response.id',
  responseModel: 'gen_ai.response.model',
  /**
   * Why the model stopped, as a **native string array** — the type the semantic conventions
   * define for this key.
   *
   * **Cross-implementation difference.** The four implementations do not agree on this attribute,
   * and no two of them are queryable the same way, so no representation could have been adopted
   * that matched more than one of them:
   *
   * | Implementation | A tool-calling response reports |
   * | --- | --- |
   * | this one | `["tool_call"]` (array of strings) |
   * | Python | `'["tool_calls"]'` (JSON text) |
   * | .NET | `'["toolcalls"]'` (JSON text, punctuation removed) |
   * | Go | attribute not emitted |
   *
   * A dashboard reading this attribute from a TypeScript trace filters on the array directly; the
   * same query against a Python or .NET trace needs a JSON parse first, and the value it finds
   * inside is spelled differently again.
   *
   * The values are the convention's, not the provider's: `tool_calls` is normalized to
   * `tool_call` (see {@link otelFinishReason}). The unnormalized provider spelling is still
   * reported in the `finish_reason` of the `gen_ai.choice` message event, which the convention
   * defines separately.
   */
  finishReasons: 'gen_ai.response.finish_reasons',

  // Usage
  /** Metric dimension: `'input'` or `'output'`. */
  tokenType: 'gen_ai.token.type',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  cacheCreationInputTokens: 'gen_ai.usage.cache_creation.input_tokens',
  cacheReadInputTokens: 'gen_ai.usage.cache_read.input_tokens',
  reasoningOutputTokens: 'gen_ai.usage.reasoning.output_tokens',

  // Agent
  agentId: 'gen_ai.agent.id',
  agentName: 'gen_ai.agent.name',
  agentDescription: 'gen_ai.agent.description',

  // Tool
  toolName: 'gen_ai.tool.name',
  toolCallId: 'gen_ai.tool.call.id',
  toolType: 'gen_ai.tool.type',
  toolDescription: 'gen_ai.tool.description',
  toolArguments: 'gen_ai.tool.call.arguments',
  toolResult: 'gen_ai.tool.call.result',

  // Message content — only recorded when sensitive data is explicitly enabled.
  /**
   * The prompt, as `[{ "role": …, "parts": [{ "type": … }] }]` — a **compact** rendering of the
   * convention's message shape.
   *
   * **What a part carries.** A `text` part carries its `content`. Every other part is its `type`
   * and nothing else, named with the convention's vocabulary (`reasoning`, `blob`, `uri`,
   * `tool_call`, `tool_call_response`) so the same query works against a Python or .NET trace.
   *
   * **What a part deliberately drops**, which Python and .NET both include:
   *
   * | Part | Omitted here |
   * | --- | --- |
   * | `tool_call` | `id`, `name`, `arguments` |
   * | `tool_call_response` | `id`, `response` |
   * | `blob` | the base64 bytes, `mime_type`, `modality` |
   * | `uri` | `uri`, `mime_type`, `modality` |
   * | `reasoning` | `content` |
   *
   * A dashboard therefore sees the **shape** of an exchange — how many turns, in what roles, of
   * what kinds — and reads the payloads from the transcript instead.
   *
   * **Why.** Two reasons, both about what a span attribute is for. Size: a span attribute is a
   * single string on a record that ships on every call, and one image attachment rendered as a
   * blob part grows one message list from a few hundred bytes to tens of kilobytes — past the
   * point where an exporter or backend truncates the attribute, which costs the *whole* message
   * list, not just the blob. Exposure: tool arguments and tool results are the parts most likely
   * to hold credentials, access tokens and consent links, and they would land in a trace backend
   * whose retention and access rules are not the transcript's.
   *
   * Message content of any kind is recorded only when `configureObservability` or
   * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` turns it on; with capture off, neither
   * this key nor {@link GEN_AI.outputMessages} appears on any span.
   */
  inputMessages: 'gen_ai.input.messages',
  /**
   * The completion, in the same compact form as {@link GEN_AI.inputMessages}.
   *
   * On the `chat` span the last message additionally carries `finish_reason`, normalized the way
   * {@link GEN_AI.finishReasons} is (`tool_calls` becomes `tool_call`). The `invoke_agent` span
   * leaves it off, as the reference implementations do.
   */
  outputMessages: 'gen_ai.output.messages',
  systemInstructions: 'gen_ai.system_instructions',

  /** Names the per-message event, alongside the role-specific event names below. */
  eventName: 'event.name',
  /**
   * The provider name as the v1.36.0 message events carry it. The events predate
   * `gen_ai.provider.name` and kept the older key, so all four implementations stamp them with
   * this one.
   */
  system: 'gen_ai.system',
} as const;

/**
 * Per-message event names, by role (Python `ROLE_EVENT_MAP`).
 *
 * The convention describes these as log events. The framework emits them as **span events**: the
 * OpenTelemetry logs API lives in a separate package, and `@opentelemetry/api` is the core's only
 * runtime dependency. The names and payload are the same, so a collector can lift them into log
 * records.
 */
export const GEN_AI_MESSAGE_EVENT = {
  system: 'gen_ai.system.message',
  user: 'gen_ai.user.message',
  assistant: 'gen_ai.assistant.message',
  tool: 'gen_ai.tool.message',
  /** The model's answer, whatever role it carries. */
  choice: 'gen_ai.choice',
} as const;

/**
 * OpenTelemetry general server attributes.
 *
 * Not GenAI-specific: the same two keys identify the endpoint behind a model call and behind an
 * MCP connection, so both conventions reuse them and so must every emitter here — a dashboard
 * filtering on `server.address` has to see one vocabulary, whichever span it lands on.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/attributes-registry/server/
 */
export const SERVER = {
  /** The host the request goes to, for example `api.openai.com`. Not a full URL. */
  address: 'server.address',
  /**
   * The endpoint's port — **deliberately never produced for a chat call**.
   *
   * The key stays here and in the metric dimension allowlist as a forward declaration, the way
   * Python lists it among its metric attributes without a generator; the dimension filter skips a
   * key with no value, so no histogram series is split by it.
   *
   * Known non-conformance: the semantic conventions make this key conditionally required once
   * `server.address` is present, and chat spans do report an address. Reporting the port is a
   * separate decision from reporting the address, because it is also a histogram dimension. MCP
   * spans, which follow their own convention, do report it.
   */
  port: 'server.port',
} as const;

/**
 * OpenTelemetry MCP semantic-convention attributes.
 *
 * Values match Python's `OtelAttr.MCP_*`.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/mcp/
 */
export const MCP = {
  methodName: 'mcp.method.name',
  /** Set on the `initialize` span once the MCP client wires it (Python parity; deferred low). */
  protocolVersion: 'mcp.protocol.version',
  // The same two keys as {@link SERVER}, spelled out because `isolatedDeclarations` needs a
  // literal here rather than a reference. Change one side and you must change the other; the
  // observability tests fail if the pairs ever disagree.
  serverAddress: 'server.address',
  serverPort: 'server.port',
  /** The resource a `resources/read` span was for. Python has no equivalent constant yet. */
  resourceUri: 'mcp.resource.uri',
} as const;

/** GenAI operation names, used both as `gen_ai.operation.name` and as the span-name prefix. */
export const GEN_AI_OPERATION = {
  chat: 'chat',
  executeTool: 'execute_tool',
  invokeAgent: 'invoke_agent',
  createAgent: 'create_agent',
} as const;

/**
 * Maps a framework `finishReason` to the semantic-convention value (Python `FINISH_REASON_MAP`).
 *
 * Only `tool_calls` differs; `stop`, `length` and `content_filter` are already the convention's
 * words and pass through, as does any value outside the map. Applied to
 * {@link GEN_AI.finishReasons} and to the `finish_reason` stamped on the last output message —
 * the two places Python maps it — but not to the `gen_ai.choice` event body, which the convention
 * defines with the provider's own spelling.
 */
export function otelFinishReason(finishReason: string): string {
  return finishReason === 'tool_calls' ? 'tool_call' : finishReason;
}

/** What {@link serverAddress} reports when the endpoint cannot be determined. */
export const UNKNOWN_SERVER_ADDRESS = 'unknown';

/**
 * The `server.address` value for a client whose endpoint is `providerUri`.
 *
 * The host, not the URL: the convention defines this key as the server's address, and it is also
 * a metric dimension — a full endpoint URL carries the deployment path, so histogram series would
 * split per deployment instead of per host.
 *
 * An absent or unparseable endpoint reports {@link UNKNOWN_SERVER_ADDRESS} rather than nothing, so
 * every chat call contributes to the same dimension set whether or not its client names a URL.
 */
export function serverAddress(providerUri: string | undefined): string {
  if (providerUri === undefined || providerUri === '') {
    return UNKNOWN_SERVER_ADDRESS;
  }
  let hostname: string;
  try {
    hostname = new URL(providerUri).hostname;
  } catch {
    return UNKNOWN_SERVER_ADDRESS;
  }
  return hostname === '' ? UNKNOWN_SERVER_ADDRESS : hostname;
}
