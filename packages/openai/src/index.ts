/**
 * `@polymind-inc/agent-framework-openai` — OpenAI and Azure OpenAI provider for the Agent Framework.
 *
 * Implements the Responses API, including the provider-hosted tools.
 */

export type {
  EndpointNamedModel,
  NamedModel,
  OpenAIChatClientConfig,
  OpenAIChatClientOptions,
} from './chat-client.js';
export { OpenAIChatClient } from './chat-client.js';
export { codeInterpreterTool, fileSearchTool, mcpTool, webSearchTool } from './hosted-tools.js';
export type { OpenAIChatOptions, OpenAIReasoningOptions } from './options.js';
// The to-openai.ts / from-openai.ts wire converters are internal (the Python reference
// implementation, microsoft/agent-framework, keeps the equivalents private too); request
// inspection goes through OpenAIChatClient.buildRequest.
