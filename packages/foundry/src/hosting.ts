/**
 * `@polymind-inc/agent-framework-foundry/hosting` — publishes an `Agent` as a Microsoft Foundry Hosted Agent.
 *
 * The protocol itself lives in `@polymind-inc/agent-framework-agentserver`; this is the adapter between it and
 * the Agent Framework: input and output conversion, the session store, approval persistence, and
 * the toolbox.
 *
 * ```ts
 * import { Agent } from '@polymind-inc/agent-framework-core';
 * import { FoundryChatClient } from '@polymind-inc/agent-framework-foundry';
 * import { ResponsesHostServer } from '@polymind-inc/agent-framework-foundry/hosting';
 * import { serve } from '@polymind-inc/agent-framework-agentserver/node';
 *
 * const agent = new Agent({
 *   client: new FoundryChatClient({
 *     projectEndpoint: process.env.FOUNDRY_PROJECT_ENDPOINT!,
 *     target: { modelDeployment: process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME! },
 *   }),
 *   instructions: 'You are a helpful assistant.',
 *   // The hosting infrastructure owns the transcript, so the provider must not store it too.
 *   defaultOptions: { store: false },
 * });
 *
 * await serve(new ResponsesHostServer({ agent }));
 * ```
 */

export type { ToolboxConsentRequest } from './hosting/consent.js';
export {
  CONSENT_REQUIRED_JSON_RPC_CODE,
  consentRequestsOf,
  ToolboxConsentRequiredError,
} from './hosting/consent.js';
// The converters (converters.ts) are the handler's internal wire↔framework translation layer
// and are not exported.
export { AGENT_FRAMEWORK_SERVER_LABEL } from './hosting/converters.js';

// consentRequestsFromMessage is intentionally NOT exported: shape is not provenance, and applying
// it to tool/model-authored text would reopen the string-channel consent spoof that the
// out-of-band consent channel was introduced to close.

export type { ApprovalStorage } from './hosting/approval-storage.js';
export { FileApprovalStorage, InMemoryApprovalStorage } from './hosting/approval-storage.js';
export { reportConsent as reportToolboxConsent } from './hosting/consent-channel.js';
export type { FoundryResponseStoreConfig } from './hosting/response-store.js';
export { FoundryResponseStore } from './hosting/response-store.js';
export type { AgentSessionStore } from './hosting/session-store.js';
export { FileSystemAgentSessionStore, InMemoryAgentSessionStore } from './hosting/session-store.js';

// OutputBuilder is the handler's internal event machinery; its one public knob
// (onUnsupportedContent) is exposed on FoundryHandlerConfig.

export type { FoundryHandlerConfig } from './hosting/handler.js';
export { createFoundryHandler, defaultApprovalStorage, defaultSessionStore } from './hosting/handler.js';
export type { HostedAgentContext } from './hosting/hosted-context.js';
// The builder (hostedAgentContextOf) and the iteration wrapper stay internal: the handler is the
// only writer, which is what keeps the ambient read-only for everything below it.
export { getHostedAgentContext } from './hosting/hosted-context.js';

export type { InvocationsHostServerConfig } from './hosting/invocations.js';
export { InvocationsHostServer } from './hosting/invocations.js';
export type { ResponsesHostServerConfig } from './hosting/server.js';
export { defaultStore, ResponsesHostServer } from './hosting/server.js';

export type { FoundryToolboxConfig } from './hosting/toolbox.js';
export { FoundryToolbox } from './hosting/toolbox.js';
