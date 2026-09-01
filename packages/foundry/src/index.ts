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
export {
  FOUNDRY_HOSTED_SESSION_STATE_KEY,
  pinnedHostedSessionId,
  withHostedSessionId,
} from './hosted-session.js';
// The memory-store client itself (memory/client.ts) is the provider's transport, not a public
// surface; only the error it raises and the store definition a caller has to supply are exported.
export type { MemoryOperation, MemoryStoreDefinition, MemoryStoreObject } from './memory/client.js';
export { FoundryMemoryError } from './memory/client.js';
export type {
  FoundryMemoryFailure,
  FoundryMemoryProviderConfig,
  FoundryMemoryScope,
} from './memory/provider.js';
export { FoundryMemoryProvider } from './memory/provider.js';
export type { FoundryProjectOptions } from './project.js';
export { FoundryProject } from './project.js';
export type { FoundryEndpoint, FoundryTarget } from './target.js';
export {
  FOUNDRY_API_VERSION,
  FOUNDRY_SCOPE,
  isModelTarget,
  normalizeProjectEndpoint,
  resolveEndpoint,
} from './target.js';
