/**
 * `@polymind-inc/agent-framework-core` — runtime-agnostic core of the Agent Framework for TypeScript.
 *
 * The only runtime dependency is `@opentelemetry/api`; with no SDK registered it is a no-op.
 * ESM only.
 */

export type {
  AgentConfig,
  AgentLike,
  AgentRunOptions,
  AgentRunStream,
  StructuredValue,
} from './agent/agent.js';
export { Agent } from './agent/agent.js';
export type { AgentAsToolOptions, ToolableAgent } from './agent/as-tool.js';
export { agentAsTool } from './agent/as-tool.js';
// agent
export type { SerializedAgentSession } from './agent/session.js';
export { AgentSession } from './agent/session.js';
// chat client
export type {
  ChatClient,
  ChatClientMetadata,
  ChatOptions,
  ChatResponseStream,
  JsonSchemaResponseFormat,
  ResponseFormat,
  ToolChoice,
} from './client/chat-client.js';
export type { ClientErrorNormalizer, ClientErrorNormalizerOptions } from './client/client-errors.js';
export { createClientErrorNormalizer, guardClientStream } from './client/client-errors.js';
export { FunctionInvocationLimitError } from './client/function-execution.js';
export type { FunctionInvocationConfig } from './client/function-invocation.js';
export { withFunctionInvocation } from './client/function-invocation.js';
export { arrayToStream, setIfDefined, topLevelMediaType, withoutUndefined } from './client/provider-utils.js';
export type { ResolvedResponseFormat } from './client/structured-output.js';
export {
  applyStructuredOutput,
  resolveResponseFormat,
  withStructuredOutput,
} from './client/structured-output.js';
export { withChatTelemetry } from './client/telemetry.js';
export type { ApprovalStateStore, ToolApprovalConfig } from './client/tool-approval.js';
export { APPROVAL_STATE_KEY, sessionApprovalStore, withToolApproval } from './client/tool-approval.js';
// context providers
export type {
  ContextProvider,
  HistoryProvider,
  HistoryStoreOptions,
  ProviderAfterRunContext,
  ProviderAgentInfo,
  ProviderRunContext,
} from './context/context-provider.js';
export { isHistoryProvider, selectContextMessages } from './context/context-provider.js';
export type { InMemoryHistoryProviderConfig } from './context/in-memory-history-provider.js';
export { InMemoryHistoryProvider } from './context/in-memory-history-provider.js';
// errors
export {
  AgentFrameworkError,
  ChatClientError,
  ConfigurationError,
  ContentFilterError,
  MiddlewareTerminated,
  NotImplementedError,
  SchemaResolutionError,
  StreamConsumedError,
  ToolInvocationError,
  UserInputRequiredError,
} from './errors.js';
// middleware
export type {
  AgentMiddleware,
  AgentMiddlewareContext,
  CategorizedMiddleware,
  FunctionMiddleware,
  FunctionMiddlewareContext,
  Middleware,
  MiddlewareHandler,
  MiddlewareKind,
} from './middleware/middleware.js';
export {
  agentMiddleware,
  categorizeMiddleware,
  functionMiddleware,
  withMiddleware,
} from './middleware/middleware.js';
export type { ToolApprovalRule, ToolApprovalRuleContext } from './middleware/tool-approval-middleware.js';
export { toolApprovalMiddleware } from './middleware/tool-approval-middleware.js';
// observability
export { GEN_AI, GEN_AI_MESSAGE_EVENT, GEN_AI_OPERATION, MCP } from './observability/attributes.js';
export {
  GEN_AI_METRICS,
  OPERATION_DURATION_BUCKET_BOUNDARIES,
  TOKEN_USAGE_BUCKET_BOUNDARIES,
} from './observability/metrics.js';
export type { ObservabilitySettings } from './observability/settings.js';
export { captureMessageContent, configureObservability, getTracer } from './observability/settings.js';
export type { AgentRunSpan, AgentRunSpanInfo } from './observability/tracing.js';
export { setMcpSpanError, startAgentRunSpan, withMcpClientSpan } from './observability/tracing.js';
// skills
export type {
  ParsedSkillMarkdown,
  SkillFrontmatter,
  SkillFrontmatterConfig,
} from './skills/frontmatter.js';
export { parseSkillMarkdown, skillFrontmatter } from './skills/frontmatter.js';
export type {
  SkillApprovalModes,
  SkillsProviderConfig,
} from './skills/provider.js';
export { SKILL_TOOL_NAMES, skillsProvider } from './skills/provider.js';
export type {
  InlineSkillConfig,
  MarkdownSkillConfig,
  Skill,
  SkillAccessOptions,
  SkillInvocationContext,
  SkillResource,
  SkillResourceConfig,
  SkillScript,
  SkillScriptArguments,
  SkillScriptConfig,
} from './skills/skill.js';
export { inlineSkill, markdownSkill, skillResource, skillScript } from './skills/skill.js';
export type {
  CacheSkillsOptions,
  DeduplicateSkillsOptions,
  SkillLoadFailure,
  SkillsSource,
  SkillsSourceContext,
} from './skills/source.js';
export {
  aggregateSkills,
  cacheSkills,
  deduplicateSkills,
  filterSkills,
  inMemorySkillsSource,
} from './skills/source.js';
// streaming
export { abortErrorFrom, isAbortError } from './streaming/abort.js';
export type {
  ResponseStream,
  ResponseStreamInit,
  StreamResultContext,
  StreamStartContext,
} from './streaming/response-stream.js';
export { createResponseStream } from './streaming/response-stream.js';
export {
  approvalReason,
  approvalRequestId,
  approvalResponse,
  isApprovalRequest,
  isApprovalResponse,
  isHostedApproval,
} from './tools/approval.js';
export type {
  CodeInterpreterToolOptions,
  FileSearchToolOptions,
  HostedTool,
  MCPToolOptions,
  SupportsCodeInterpreterTool,
  SupportsFileSearchTool,
  SupportsMCPTool,
  SupportsWebSearchTool,
  WebSearchToolOptions,
} from './tools/hosted.js';
export {
  hostedTool,
  supportsCodeInterpreter,
  supportsFileSearch,
  supportsMCP,
  supportsWebSearch,
} from './tools/hosted.js';
export type { JsonSchema, SchemaInput } from './tools/json-schema.js';
export { resolveJsonSchema } from './tools/json-schema.js';
// tools
export type {
  InferInput,
  InferOutput,
  StandardSchemaIssue,
  StandardSchemaPathSegment,
  StandardSchemaProps,
  StandardSchemaResult,
  StandardSchemaTypes,
  StandardSchemaV1,
} from './tools/standard-schema.js';
export { formatSchemaIssues, isStandardSchema } from './tools/standard-schema.js';
export type {
  AnyFunctionTool,
  ApprovalMode,
  FunctionTool,
  FunctionToolConfig,
  Tool,
  ToolContext,
  ToolInputOf,
} from './tools/tool.js';
export {
  invocationCountOf,
  isFunctionTool,
  normalizeToolResult,
  resetInvocationCount,
  tool,
} from './tools/tool.js';
// base64
export { decodeBase64, encodeBase64 } from './types/base64.js';
// coalescing
export { coalesceContents } from './types/coalesce.js';
// content
export type {
  Annotation,
  Content,
  ContentBase,
  ContentType,
  DataContent,
  ErrorContent,
  FunctionApprovalRequestContent,
  FunctionApprovalResponseContent,
  FunctionCallContent,
  FunctionResultContent,
  HostedFileContent,
  HostedToolCallContent,
  HostedToolResultContent,
  HostedVectorStoreContent,
  OAuthConsentRequestContent,
  TextContent,
  TextReasoningContent,
  TextSpanRegion,
  UnknownContent,
  UriContent,
  UsageContent,
  UserInputRequestContent,
} from './types/content.js';
export { dataContent, textContent, textOfContents, unknownContent, uriContent } from './types/content.js';
// messages
export type {
  AgentRunInput,
  Message,
  MessageFilter,
  MessageSource,
  MessageSourceType,
  Role,
} from './types/message.js';
export {
  allOf,
  anyOf,
  externalOnly,
  getMessageSource,
  MESSAGE_SOURCE_KEY,
  message,
  none,
  normalizeInput,
  notSourceIds,
  notSourceTypes,
  passThrough,
  sourceIds,
  sourceTypes,
  textOf,
  textOfMessages,
  withMessageSource,
} from './types/message.js';
// responses
export type {
  AgentResponse,
  AgentResponseInit,
  AgentResponseUpdate,
  AgentResponseUpdateInit,
  ChatResponse,
  ChatResponseInit,
  ChatResponseUpdate,
  ChatResponseUpdateInit,
  ContinuationToken,
  FinishReason,
  ResponseBase,
  ResponseUpdateBase,
} from './types/response.js';
export {
  agentResponse,
  agentResponseToUpdates,
  agentResponseUpdate,
  chatResponse,
  chatResponseToUpdates,
  chatResponseUpdate,
  chatToAgentUpdate,
  mergeChatUpdates,
  mergeUpdates,
} from './types/response.js';
// serialization
export type { SerializedContent, SerializedMessage } from './types/serialization.js';
export {
  deserializeContent,
  deserializeMessage,
  deserializeMessages,
  serializeContent,
  serializeMessage,
  serializeMessages,
} from './types/serialization.js';
// usage
export type { UsageDetails } from './types/usage.js';
export { addUsage } from './types/usage.js';
