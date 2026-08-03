import type { ChatClient } from '../client/chat-client.js';
import type { Tool } from './tool.js';

/**
 * A tool the provider executes on its own side.
 *
 * Unlike a {@link FunctionTool}, the framework never invokes it: the declaration is forwarded to
 * the provider, which runs the tool and reports the call and its result as hosted content. `spec`
 * is the provider's own declaration object and is sent verbatim.
 */
export interface HostedTool extends Tool {
  readonly kind: 'hosted';
  readonly spec: Record<string, unknown>;
}

/** Builds a {@link HostedTool} from a provider declaration. */
export function hostedTool(name: string, spec: Record<string, unknown>): HostedTool {
  return { kind: 'hosted', name, spec };
}

/** Options for a provider-hosted web search tool. */
export interface WebSearchToolOptions {
  /** Approximate user location, used to bias results. */
  userLocation?: {
    type?: 'approximate';
    country?: string;
    city?: string;
    region?: string;
    timezone?: string;
  };
  /** How much page context to pull into the model. */
  searchContextSize?: 'low' | 'medium' | 'high';
  /** Provider-specific fields, merged into the declaration. */
  additionalProperties?: Record<string, unknown>;
}

/** Options for a provider-hosted file search tool. */
export interface FileSearchToolOptions {
  /** Vector stores to search. At least one is required by most providers. */
  vectorStoreIds?: string[];
  maxNumResults?: number;
  /** Provider-specific metadata filter, passed through verbatim. */
  filters?: Record<string, unknown>;
  additionalProperties?: Record<string, unknown>;
}

/** Options for a provider-hosted code interpreter. */
export interface CodeInterpreterToolOptions {
  /** Files the sandbox starts with. */
  fileIds?: string[];
  /** Reuse an existing container instead of creating one. */
  containerId?: string;
  additionalProperties?: Record<string, unknown>;
}

/** Options for a provider-hosted (remote) MCP server. */
export interface MCPToolOptions {
  /** The label the provider reports on `mcp_call` items. */
  serverLabel: string;
  serverUrl?: string;
  /** Restricts which of the server's tools the model may call. */
  allowedTools?: string[];
  /**
   * Which calls need human approval. `'never'` lets the provider run every tool unattended.
   * Defaults to the provider's own default, which is normally to require approval.
   */
  requireApproval?: 'always' | 'never' | { always?: string[]; never?: string[] };
  headers?: Record<string, string>;
  additionalProperties?: Record<string, unknown>;
}

/** A client that can ask its provider to run a web search. */
export interface SupportsWebSearchTool {
  getWebSearchTool(options?: WebSearchToolOptions): HostedTool;
}

/** A client that can ask its provider to search files or vector stores. */
export interface SupportsFileSearchTool {
  getFileSearchTool(options?: FileSearchToolOptions): HostedTool;
}

/** A client that can ask its provider to run code in a sandbox. */
export interface SupportsCodeInterpreterTool {
  getCodeInterpreterTool(options?: CodeInterpreterToolOptions): HostedTool;
}

/** A client that can attach a remote MCP server the provider talks to directly. */
export interface SupportsMCPTool {
  getMCPTool(options: MCPToolOptions): HostedTool;
}

function hasMethod(value: object, name: string): boolean {
  return typeof (value as Record<string, unknown>)[name] === 'function';
}

/** Narrows a client that offers a provider-hosted web search tool. */
export function supportsWebSearch(client: ChatClient): client is ChatClient & SupportsWebSearchTool {
  return hasMethod(client, 'getWebSearchTool');
}

/** Narrows a client that offers a provider-hosted file search tool. */
export function supportsFileSearch(client: ChatClient): client is ChatClient & SupportsFileSearchTool {
  return hasMethod(client, 'getFileSearchTool');
}

/** Narrows a client that offers a provider-hosted code interpreter. */
export function supportsCodeInterpreter(
  client: ChatClient,
): client is ChatClient & SupportsCodeInterpreterTool {
  return hasMethod(client, 'getCodeInterpreterTool');
}

/** Narrows a client that can attach a remote MCP server. */
export function supportsMCP(client: ChatClient): client is ChatClient & SupportsMCPTool {
  return hasMethod(client, 'getMCPTool');
}
