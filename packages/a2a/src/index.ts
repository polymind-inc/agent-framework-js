/**
 * `@polymind-inc/agent-framework-a2a` — use a remote Agent2Agent (A2A) agent as an agent.
 *
 * Built on the official `@a2a-js/sdk` client. ESM only.
 */

export type { A2AAgentConfig, A2AAgentFromUrlOptions, A2ARunOptions } from './agent.js';
export { A2AAgent } from './agent.js';
export type { A2AContinuationToken } from './continuation.js';
export { A2AAgentError } from './errors.js';
export type { A2ASessionState } from './session.js';
