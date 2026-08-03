import type { HostedTool, MCPToolOptions, WebSearchToolOptions } from '@polymind-inc/agent-framework-core';
import { ConfigurationError, hostedTool, withoutUndefined } from '@polymind-inc/agent-framework-core';

/**
 * Declares the provider-hosted web search tool.
 *
 * The base declaration matches Python's `AnthropicClient.get_web_search_tool`:
 * `{type: 'web_search_20250305', name: 'web_search'}`. `searchContextSize` has no Messages API
 * equivalent and is dropped, as Python drops it. Anthropic-specific settings — `max_uses`,
 * `allowed_domains`, or a different versioned `type` — go through
 * {@link WebSearchToolOptions.additionalProperties}.
 */
export function webSearchTool(options: WebSearchToolOptions = {}): HostedTool {
  return hostedTool(
    'web_search',
    withoutUndefined({
      type: 'web_search_20250305',
      name: 'web_search',
      user_location:
        options.userLocation === undefined
          ? undefined
          : withoutUndefined({ type: 'approximate', ...options.userLocation }),
      ...options.additionalProperties,
    }),
  );
}

/**
 * The marker that routes a hosted tool into the request's `mcp_servers` field.
 *
 * Messages API keeps remote MCP servers out of `tools`, so the declaration cannot simply be
 * forwarded; the marker is stripped when the request is built.
 */
export const MCP_SERVER_SPEC_TYPE = 'anthropic.mcp_server';

/**
 * Declares a remote MCP server for Anthropic to connect to directly.
 *
 * Messages API takes an `authorization_token` rather than arbitrary headers, so only the
 * `authorization` entry of {@link MCPToolOptions.headers} is used; `requireApproval` has no
 * Messages API equivalent and is ignored.
 *
 * ## Security considerations
 *
 * The server is chosen by URL and its tools run without a human in the loop — a hostile or
 * compromised server runs with whatever those tools can reach. The authorization token is
 * disclosed to that server on every call.
 */
export function mcpTool(options: MCPToolOptions): HostedTool {
  if (options.serverLabel.trim() === '') {
    throw new ConfigurationError('mcpTool requires a non-empty serverLabel.');
  }
  // The API rejects an `mcp_servers[].name` containing spaces; Python's `get_mcp_tool` applies the
  // same substitution (`_chat_client.py`: `"server_label": name.replace(" ", "_")`), as does the
  // openai package. Only spaces are replaced — matching the reference implementation exactly rather
  // than sanitising every character the API might dislike.
  const serverLabel = options.serverLabel.replaceAll(' ', '_');
  const authorization = options.headers?.authorization;
  return hostedTool(
    serverLabel,
    withoutUndefined({
      type: MCP_SERVER_SPEC_TYPE,
      name: serverLabel,
      url: options.serverUrl,
      tool_configuration:
        options.allowedTools === undefined ? undefined : { allowed_tools: options.allowedTools },
      authorization_token: typeof authorization === 'string' ? authorization : undefined,
      ...options.additionalProperties,
    }),
  );
}
