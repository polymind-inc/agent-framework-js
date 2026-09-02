/**
 * Internal contract between the framework's own packages — not part of the documented surface.
 *
 * What an MCP tool result means — how its blocks convert, how a failure's text is assembled — is
 * one rule with one implementation, and every package that reads such a result (the Foundry
 * toolbox speaks MCP over its own connection) imports it from here instead of keeping a copy.
 * Everything exported here may change or disappear in any release; import from
 * `@polymind-inc/agent-framework-mcp` instead for the supported surface.
 */

export type { CallToolResultShape } from './content.js';
export { callToolFailure, contentsOfCallToolResult } from './content.js';
export { claimLocalName, localToolName, normalizeInputSchema } from './declarations.js';
