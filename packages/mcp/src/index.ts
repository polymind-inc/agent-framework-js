/**
 * `@polymind-inc/agent-framework-mcp` — Model Context Protocol client integration.
 *
 * Turns an MCP server's tools into framework tools, so an agent can call them like any other.
 * Built on `@modelcontextprotocol/client` v2 (protocol revision 2026-07-28).
 */

export type { ApprovalPolicy, MCPClientConfig } from './client.js';
export { MCPClient } from './client.js';
export type { McpCallToolOptions, McpConnectionConfig } from './connection.js';
export { McpConnection } from './connection.js';
export type { McpResourceReader, McpSkillsSourceConfig } from './skills.js';
export { mcpSkillsSource } from './skills.js';
// content.ts (MCP block → Content conversion) is internal — Python keeps the equivalent
// (_parse_tool_result_from_mcp) private too.
