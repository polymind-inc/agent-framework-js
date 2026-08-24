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
  inputMessages: 'gen_ai.input.messages',
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

/** Maps a framework `finishReason` to the semantic-convention value (Python `FINISH_REASON_MAP`). */
export function otelFinishReason(finishReason: string): string {
  return finishReason === 'tool_calls' ? 'tool_call' : finishReason;
}
