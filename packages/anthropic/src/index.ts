/**
 * `@polymind-inc/agent-framework-anthropic` — Anthropic provider for the Agent Framework.
 *
 * Implements the Messages API, including extended thinking and remote MCP servers.
 */

export type { AnthropicChatClientConfig } from './chat-client.js';
export { AnthropicChatClient, DEFAULT_BETA_FLAGS, DEFAULT_MAX_TOKENS } from './chat-client.js';
export { mcpTool, webSearchTool } from './hosted-tools.js';
export type { AnthropicChatOptions, AnthropicThinkingOptions } from './options.js';
// The to-anthropic.ts / from-anthropic.ts wire converters are internal (Python keeps the
// equivalents private too); request inspection goes through AnthropicChatClient.buildRequest.
