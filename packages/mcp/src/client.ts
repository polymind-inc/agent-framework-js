import type { Transport } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type {
  ApprovalMode,
  Content,
  FunctionTool,
  SkillsSource,
  ToolContext,
} from '@polymind-inc/agent-framework-core';
import {
  ConfigurationError,
  ToolInvocationError,
  textOfContents,
  tool,
} from '@polymind-inc/agent-framework-core';
import { McpConnection } from './connection.js';
import { fromMcpContents, mcpMetaProperties } from './content.js';
import type { McpHeaderProvider } from './headers.js';
import { headerInjectingFetch } from './headers.js';
import type { McpSkillsSourceConfig } from './skills.js';
import { mcpSkillsSource } from './skills.js';

/** How a tool's `approvalMode` is decided when its MCP server declares nothing. */
export type ApprovalPolicy = ApprovalMode | ((toolName: string) => ApprovalMode);

/** Construction options for {@link MCPClient}. */
export interface MCPClientConfig {
  /**
   * The MCP server's Streamable HTTP endpoint.
   *
   * Mutually exclusive with {@link MCPClientConfig.transport} and
   * {@link MCPClientConfig.transportFactory}.
   */
  url?: string | URL;
  /**
   * One transport to use instead of Streamable HTTP — stdio, in-memory, or anything custom.
   *
   * A transport instance cannot be recreated after a lost connection, so automatic reconnect is
   * disabled for this form. Use {@link MCPClientConfig.transportFactory} when the transport is
   * one-shot and the connection should recover automatically.
   */
  transport?: Transport;
  /**
   * Creates a fresh custom transport for each connection attempt.
   *
   * Mutually exclusive with {@link MCPClientConfig.url} and {@link MCPClientConfig.transport}.
   */
  transportFactory?: () => Transport;
  /** How this client identifies itself to the server. */
  clientInfo?: { name: string; version: string };
  /** Restricts which of the server's tools are exposed to the model. */
  allowedTools?: string[];
  /**
   * Whether the tools need human approval before running. Defaults to `'never_require'`.
   *
   * ## Security considerations
   *
   * An MCP server is remote code chosen by URL. Its tool list, descriptions and results all reach
   * the model as untrusted text, and its tools run with whatever the process can reach. Prefer
   * `'always_require'` for a server you do not operate.
   */
  approvalMode?: ApprovalPolicy;
  /**
   * Extra headers for every request, for example an authorization token.
   *
   * A function is called **once per request**, so a credential that expires can be refreshed
   * without writing a transport: return the current value and let whatever produced it do its own
   * caching. A plain record is read once, at construction.
   *
   * Only applies to the `url` form. A `transport` or `transportFactory` you build yourself owns
   * its own headers.
   *
   * ## Security considerations
   *
   * Headers are attached only to requests whose origin matches `url`, so a redirect to another
   * host does not carry them along. Anything here is disclosed to the server at `url` itself.
   */
  headers?: Record<string, string> | McpHeaderProvider;
  /** Replaces the transport's `fetch`, for proxies and tests. */
  fetch?: typeof globalThis.fetch;
}

function approvalModeFor(policy: ApprovalPolicy | undefined, toolName: string): ApprovalMode {
  if (policy === undefined) {
    return 'never_require';
  }
  return typeof policy === 'function' ? policy(toolName) : policy;
}

/** A declared MCP tool, as `tools/list` reports it. */
interface DeclaredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Exposes an MCP server's tools as framework tools.
 *
 * ```ts
 * const mcp = new MCPClient({ url: 'https://mcp.example.com/mcp' });
 * const agent = new Agent({ client, tools: await mcp.getTools() });
 * ```
 *
 * The connection is opened on the first `getTools()` and reused; `close()` releases it. Each
 * `tools/call` is traced as an MCP client span per the OTel MCP semantic conventions. Connection
 * management — lazy connect, one reconnect when the connection turns out dead, the spans — lives
 * in {@link McpConnection}, which is also usable on its own for consumers that want raw MCP
 * results instead of framework tools. Automatic reconnect is available for `url` and
 * `transportFactory`; a single `transport` instance cannot be recreated and is not retried.
 *
 * ## Scope
 *
 * Tools only (`tools/list`, `tools/call`). **Sampling** (`sampling/createMessage`), **elicitation**
 * (`elicitation/create`) and **prompts** (`prompts/list` / `prompts/get`) are not supported, and no
 * capability is advertised for the server-initiated ones, so a well-behaved server never issues
 * them. Sampling would hand untrusted remote code a model call and needs an approval gate the
 * framework has no home for yet (Python guards it with a deny-by-default callback and per-session
 * caps; .NET has none); elicitation is supported by *no* reference implementation; prompts are
 * message templates rather than callables. See the package README for the full table.
 *
 * ## Security considerations
 *
 * - **The server is remote code.** Its tool descriptions are read by the model and its results
 *   enter the context window — both are prompt-injection surfaces. See
 *   {@link MCPClientConfig.approvalMode}.
 * - **`headers` is sent to that server on every request.** Anything in it is disclosed to it.
 * - **Tool names come from the server.** A server can rename its tools between connections, so a
 *   name-based allowlist is checked at enumeration time, not once at startup.
 */
export class MCPClient {
  readonly #config: MCPClientConfig;
  readonly #allowedTools: ReadonlySet<string> | undefined;
  readonly #target: string;
  readonly #connection: McpConnection;

  constructor(config: MCPClientConfig) {
    const sources = [config.url, config.transport, config.transportFactory].filter(
      (value) => value !== undefined,
    );
    if (sources.length !== 1) {
      throw new ConfigurationError(
        'MCPClient needs exactly one of `url`, `transport`, or `transportFactory`.',
      );
    }
    this.#config = config;
    this.#allowedTools = config.allowedTools === undefined ? undefined : new Set(config.allowedTools);
    this.#target = config.url === undefined ? 'mcp' : String(config.url);
    const suppliedTransport = config.transport;
    const transportFactory =
      config.transportFactory ??
      (suppliedTransport === undefined
        ? (): Transport => this.#httpTransport()
        : (): Transport => suppliedTransport);
    this.#connection = new McpConnection({
      transport: transportFactory,
      ...(config.clientInfo === undefined ? {} : { clientInfo: config.clientInfo }),
      ...(config.url === undefined ? {} : { url: config.url }),
      // A supplied instance may be one-shot (the SDK's HTTP and in-memory transports are), so a
      // connection-loss retry must not call start() on it again. Factory-backed sources can
      // satisfy McpConnection's fresh-transport contract and keep its default retry predicate.
      ...(config.transport === undefined ? {} : { shouldReconnect: (): boolean => false }),
    });
  }

  /** Whether the connection has been opened. Exposed so callers can assert it stays lazy. */
  get connected(): boolean {
    return this.#connection.connected;
  }

  /**
   * Builds the Streamable HTTP transport.
   *
   * The caller's `fetch` is wrapped from the outside, so replacing it cannot drop the headers.
   */
  #httpTransport(): Transport {
    const url = new URL(String(this.#config.url));
    return new StreamableHTTPClientTransport(url, {
      fetch: headerInjectingFetch(url, this.#config.headers, this.#config.fetch ?? globalThis.fetch),
    });
  }

  /**
   * Lists the server's tools as framework tools.
   *
   * Called on demand rather than at startup, so a server that is briefly unreachable fails the one
   * run that needed it instead of the whole process.
   */
  async getTools(): Promise<Array<FunctionTool<Record<string, unknown>, unknown>>> {
    const { tools } = await this.#connection.listTools();
    const declared = tools as unknown as DeclaredTool[];

    return declared
      .filter((entry) => this.#allowedTools?.has(entry.name) ?? true)
      .map((entry) => this.#toFunctionTool(entry));
  }

  /**
   * Discovers the server's Agent Skills, for `skillsProvider`.
   *
   * Skills and tools are independent: a server may publish either, both or neither, and this
   * shares the same connection as {@link MCPClient.getTools} rather than opening a second one.
   *
   * ```ts
   * const agent = new Agent({ client, contextProviders: [skillsProvider(mcp.skillsSource())] });
   * ```
   */
  skillsSource(config?: McpSkillsSourceConfig): SkillsSource {
    return mcpSkillsSource(this.#connection, config);
  }

  #toFunctionTool(declared: DeclaredTool): FunctionTool<Record<string, unknown>, unknown> {
    const target = this.#target;
    return tool({
      name: declared.name,
      // Python parity (`_mcp.py`: `tool.description or ""`): a missing description stays empty
      // rather than the name doubling as prose.
      description: declared.description ?? '',
      // The server's JSON Schema is the contract; the framework does not re-derive it.
      parameters: (declared.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      approvalMode: approvalModeFor(this.#config.approvalMode, declared.name),
      execute: async (input: unknown, ctx: ToolContext): Promise<Content[]> => {
        try {
          // The connection resolves the live client on every call, so a reconnect swaps the
          // connection under tools that were handed out before it died; `ctx.signal` is carried
          // into the request options so an aborted run stops the *remote* work too.
          const result = await this.#connection.callTool(
            declared.name,
            (input ?? {}) as Record<string, unknown>,
            ctx.signal === undefined ? undefined : { signal: ctx.signal },
          );
          const meta = (result as { _meta?: unknown })._meta;
          const contents = fromMcpContents(result.content as unknown[] | undefined, meta);
          if (result.structuredContent !== undefined && result.structuredContent !== null) {
            // A structured-only server would otherwise yield an empty result. The reference
            // implementation surfaces it as a JSON text content (`_parse_tool_result_from_mcp`
            // in Python's `_mcp.py`), placed before the isError check so an error's text
            // includes it too. It is the one item Python builds *without* the `_meta` stamp;
            // the asymmetry is preserved rather than tidied up.
            contents.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
          }
          if (result.isError === true) {
            // MCP reports a tool failure in the payload rather than by rejecting. Returning it
            // as a success would tell the model the call worked and hand it the error text as
            // the answer; throwing routes it through the loop's error handling instead. The
            // connection has already marked the span with `error.type = tool_error`.
            const text = textOfContents(contents);
            throw new ToolInvocationError(
              declared.name,
              text === '' ? `MCP tool "${declared.name}" reported an error.` : text,
            );
          }
          if (contents.length === 0) {
            // Python parity: a successful call with nothing to say becomes a literal "null"
            // text, so the model sees an answer instead of an absent one. This one *does* carry
            // the result's `_meta`, as Python's fallback does.
            contents.push({ type: 'text', text: 'null', ...mcpMetaProperties(meta) });
          }
          return contents;
        } catch (error) {
          if (error instanceof ToolInvocationError) {
            throw error;
          }
          throw new ToolInvocationError(
            declared.name,
            `MCP call to ${target} failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      },
    });
  }

  /** Closes the connection. Safe to call when it was never opened. */
  async close(): Promise<void> {
    await this.#connection.close();
  }
}
