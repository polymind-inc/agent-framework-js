/**
 * `@polymind-inc/agent-framework-foundry` — Microsoft Foundry provider for the Agent Framework.
 *
 * The hosting adapter that publishes an agent as a Foundry Hosted Agent lives in the
 * `@polymind-inc/agent-framework-foundry/hosting` subpath.
 */

// `FoundryChatClient` implements `ChatClient<OpenAIChatOptions>`; re-exported so callers can name
// the options type without depending on `@polymind-inc/agent-framework-openai` directly.
export type { OpenAIChatOptions } from '@polymind-inc/agent-framework-openai';
export type { FoundryChatClientConfig } from './chat-client.js';
export { FoundryChatClient } from './chat-client.js';
export { tokenProvider } from './credential.js';
export type { FoundryEndpoint, FoundryTarget } from './target.js';
export {
  FOUNDRY_API_VERSION,
  FOUNDRY_SCOPE,
  isModelDeployment,
  normalizeProjectEndpoint,
  resolveEndpoint,
} from './target.js';
