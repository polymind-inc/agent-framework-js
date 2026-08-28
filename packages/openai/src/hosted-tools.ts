import type {
  CodeInterpreterToolOptions,
  FileSearchToolOptions,
  HostedTool,
  McpToolOptions,
  WebSearchToolOptions,
} from '@polymind-inc/agent-framework-core';
import { ConfigurationError, hostedTool, withoutUndefined } from '@polymind-inc/agent-framework-core';
import { normalizeServerLabel } from '@polymind-inc/agent-framework-core/internal';

/** Declares the provider-hosted web search tool. */
export function webSearchTool(options: WebSearchToolOptions = {}): HostedTool {
  return hostedTool(
    'web_search',
    withoutUndefined({
      type: 'web_search',
      user_location:
        options.userLocation === undefined
          ? undefined
          : withoutUndefined({ type: 'approximate', ...options.userLocation }),
      search_context_size: options.searchContextSize,
      ...options.additionalProperties,
    }),
  );
}

/**
 * Declares the provider-hosted file search tool.
 *
 * @throws {ConfigurationError} When no vector store is given; the API rejects the declaration.
 */
export function fileSearchTool(options: FileSearchToolOptions = {}): HostedTool {
  if (options.vectorStoreIds === undefined || options.vectorStoreIds.length === 0) {
    throw new ConfigurationError('fileSearchTool requires at least one vectorStoreId.');
  }
  return hostedTool(
    'file_search',
    withoutUndefined({
      type: 'file_search',
      vector_store_ids: options.vectorStoreIds,
      max_num_results: options.maxNumResults,
      filters: options.filters,
      ...options.additionalProperties,
    }),
  );
}

/** Declares the provider-hosted code interpreter. */
export function codeInterpreterTool(options: CodeInterpreterToolOptions = {}): HostedTool {
  const container =
    options.containerId !== undefined
      ? options.containerId
      : withoutUndefined({ type: 'auto', file_ids: options.fileIds });
  return hostedTool(
    'code_interpreter',
    withoutUndefined({ type: 'code_interpreter', container, ...options.additionalProperties }),
  );
}

/**
 * Declares a remote MCP server the provider connects to directly.
 *
 * ## Security considerations
 *
 * `requireApproval: 'never'` lets the provider run the server's tools with no human in the loop,
 * and the server is chosen by URL — a compromised or hostile one runs with whatever the tools can
 * reach. `headers` is sent to that server on every call, so anything in it is disclosed to it.
 */
export function mcpTool(options: McpToolOptions): HostedTool {
  const serverLabel = normalizeServerLabel(options.serverLabel);
  // The object form of `require_approval` is a per-side tool filter: each side is an object with
  // a `tool_names` list, not a bare array (openai SDK `Mcp.McpToolApprovalFilter`, Python
  // `get_mcp_tool`).
  const requireApproval =
    typeof options.requireApproval === 'object'
      ? withoutUndefined({
          always:
            options.requireApproval.always === undefined
              ? undefined
              : { tool_names: options.requireApproval.always },
          never:
            options.requireApproval.never === undefined
              ? undefined
              : { tool_names: options.requireApproval.never },
        })
      : options.requireApproval;
  return hostedTool(
    serverLabel,
    withoutUndefined({
      type: 'mcp',
      server_label: serverLabel,
      server_url: options.serverUrl,
      allowed_tools: options.allowedTools,
      require_approval: requireApproval,
      headers: options.headers,
      ...options.additionalProperties,
    }),
  );
}
