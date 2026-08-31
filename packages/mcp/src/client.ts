import type { Transport } from '@modelcontextprotocol/client';
import type {
  ApprovalMode,
  Content,
  FunctionTool,
  SkillsSource,
  ToolContext,
} from '@polymind-inc/agent-framework-core';
import {
  AgentFrameworkError,
  ConfigurationError,
  ToolInvocationError,
  textOfContents,
  tool,
} from '@polymind-inc/agent-framework-core';
import { errorMessageOf } from '@polymind-inc/agent-framework-core/internal';
import { McpConnection } from './connection.js';
import { fromMcpContents, mcpMetaProperties } from './content.js';
import type { McpHeaderProvider } from './headers.js';
import type { McpSkillsSourceConfig } from './skills.js';
import { mcpSkillsSource } from './skills.js';

/** How a tool's `approvalMode` is decided when its MCP server declares nothing. */
export type ApprovalPolicy = ApprovalMode | ((toolName: string) => ApprovalMode);

/** Construction options for {@link McpClient}. */
export interface McpClientConfig {
  /**
   * The MCP server's Streamable HTTP endpoint.
   *
   * Mutually exclusive with {@link McpClientConfig.transport} and
   * {@link McpClientConfig.transportFactory}.
   */
  url?: string | URL;
  /**
   * One transport to use instead of Streamable HTTP — stdio, in-memory, or anything custom.
   *
   * A transport instance cannot be recreated after a lost connection, so automatic reconnect is
   * disabled for this form. Use {@link McpClientConfig.transportFactory} when the transport is
   * one-shot and the connection should recover automatically.
   */
  transport?: Transport;
  /**
   * Creates a fresh custom transport for each connection attempt.
   *
   * Mutually exclusive with {@link McpClientConfig.url} and {@link McpClientConfig.transport}.
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
   * caching. A plain record is applied as it stands on every request.
   *
   * Only applies to the `url` form. A `transport` or `transportFactory` you build yourself owns
   * its own headers.
   *
   * A header the transport itself sets — the content type, the session id, an `authorization`
   * from the SDK's auth support — is not overridden; a configured header fills gaps.
   *
   * ## Security considerations
   *
   * Headers are attached only to requests whose origin matches `url`, and a redirect is refused
   * rather than followed — following one would have to decide which origins may see the
   * credential. A server that redirects is a configuration problem: set `url` to the endpoint it
   * redirects to. Anything here is disclosed to the server at `url` itself.
   */
  headers?: Record<string, string> | McpHeaderProvider;
  /** Replaces the transport's `fetch`, for proxies and tests. */
  fetch?: typeof globalThis.fetch;
  /**
   * Namespaces the tool names this client exposes to the model, as `<prefix>_<name>`.
   *
   * Two servers that both advertise `search` collide the moment their tools reach one agent, and
   * nothing in MCP tells them apart — a client cannot know what another client called its tools.
   * A prefix is how the caller separates them: `toolNamePrefix: 'github'` and
   * `toolNamePrefix: 'jira'` expose `github_search` and `jira_search`, each still calling its own
   * server's `search`.
   *
   * The prefix goes through the same normalization as a tool name, then loses any trailing `_`,
   * `.` or `-`; a prefix that normalizes away to nothing is ignored. Leading separators are
   * trimmed off the tool name where the two are joined, and a name that trims away entirely leaves
   * the prefix standing alone.
   *
   * Only the exposed name changes. `tools/call`, {@link McpClientConfig.allowedTools},
   * {@link McpClientConfig.approvalMode} and error messages all keep using the server's own name.
   */
  toolNamePrefix?: string;
}

/** Characters a provider accepts in a function name; everything else normalizes to `-`. */
const DISALLOWED_NAME_CHARACTERS = /[^A-Za-z0-9_.-]/g;
/** The separators trimmed off each side of the `<prefix>_<name>` join. */
const LEADING_SEPARATORS = /^[_.-]+/;
const TRAILING_SEPARATORS = /[_.-]+$/;

/**
 * Rewrites a server-chosen name into the identifier pattern providers accept.
 *
 * MCP puts no restriction on a tool name, while OpenAI and the other providers only accept
 * `[A-Za-z0-9_.-]` in a function name — so a server offering `search docs!` would otherwise turn
 * into a request the provider rejects. The rule is the reference implementations': Python's
 * `_normalize_mcp_name` and Go's `normalizeMCPName` both replace every other character with `-`,
 * so the same remote tool surfaces under the same name across the SDKs.
 */
function normalizeToolName(name: string): string {
  return name.replace(DISALLOWED_NAME_CHARACTERS, '-');
}

/** The name a tool is exposed to the model under, given the configured prefix. */
function localToolName(remoteName: string, toolNamePrefix: string | undefined): string {
  const normalized = normalizeToolName(remoteName);
  if (toolNamePrefix === undefined) {
    return normalized;
  }
  const prefix = normalizeToolName(toolNamePrefix).replace(TRAILING_SEPARATORS, '');
  if (prefix === '') {
    return normalized;
  }
  const trimmed = normalized.replace(LEADING_SEPARATORS, '');
  return trimmed === '' ? prefix : `${prefix}_${trimmed}`;
}

/**
 * Copies a declared input schema into one every provider accepts.
 *
 * A tool that takes no arguments is commonly declared as a bare `{ "type": "object" }`, which
 * OpenAI answers with a 400 because the object form requires `properties`. Adding the empty map is
 * what Python's MCP loader does, and it says exactly what the server meant. A schema that is
 * absent altogether is treated as that same zero-argument declaration; Python leaves it as an
 * empty schema, which says nothing about the arguments at all. Any other schema is passed through.
 *
 * The copy is shallow — only the top-level `properties` key is ever written — so the schema the
 * server owns is left as it was; nothing nested is modified.
 */
function normalizeInputSchema(schema: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (schema === undefined || schema === null) {
    return { type: 'object', properties: {} };
  }
  const normalized = { ...schema };
  if (normalized.type === 'object' && !Object.hasOwn(normalized, 'properties')) {
    normalized.properties = {};
  }
  return normalized;
}

function approvalModeFor(policy: ApprovalPolicy | undefined, toolName: string): ApprovalMode {
  if (policy === undefined) {
    return 'never_require';
  }
  return typeof policy === 'function' ? policy(toolName) : policy;
}

/**
 * A declared MCP tool, as `tools/list` reports it.
 *
 * `inputSchema` is required by the protocol and by the SDK's own response validation, so the
 * absent and null forms only arise for a non-conforming server reached some other way; they are
 * accepted here rather than turned into a crash, as Python's loader does.
 */
interface DeclaredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown> | null;
}

/**
 * Exposes an MCP server's tools as framework tools.
 *
 * ```ts
 * const mcp = new McpClient({ url: 'https://mcp.example.com/mcp' });
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
 * ## Names and schemas
 *
 * MCP lets a server name a tool anything and declare a zero-argument tool as a bare
 * `{ "type": "object" }`; providers accept neither. So the exposed name replaces every character
 * outside `[A-Za-z0-9_.-]` with `-`, an object schema gains `properties: {}` when it has none, and
 * a copy of the schema is what carries the change. The server's own name is what still goes out on
 * `tools/call`, and what {@link McpClientConfig.allowedTools},
 * {@link McpClientConfig.approvalMode} and error messages speak in.
 * {@link McpClientConfig.toolNamePrefix} adds a namespace when several servers advertise the same
 * tool; without it, one client never guesses at another's names.
 *
 * ## Security considerations
 *
 * - **The server is remote code.** Its tool descriptions are read by the model and its results
 *   enter the context window — both are prompt-injection surfaces. See
 *   {@link McpClientConfig.approvalMode}.
 * - **`headers` is sent to that server on every request.** Anything in it is disclosed to it.
 * - **Tool names come from the server.** A server can rename its tools between connections, so a
 *   name-based allowlist is checked at enumeration time, not once at startup.
 */
export class McpClient {
  readonly #config: McpClientConfig;
  readonly #allowedTools: ReadonlySet<string> | undefined;
  readonly #target: string;
  readonly #connection: McpConnection;

  constructor(config: McpClientConfig) {
    const sources = [config.url, config.transport, config.transportFactory].filter(
      (value) => value !== undefined,
    );
    if (sources.length !== 1) {
      throw new ConfigurationError(
        'McpClient needs exactly one of `url`, `transport`, or `transportFactory`.',
      );
    }
    if (config.url === undefined && (config.headers !== undefined || config.fetch !== undefined)) {
      throw new ConfigurationError(
        'A custom transport owns its own fetch; configure `headers` and `fetch` on it instead.',
      );
    }
    this.#config = config;
    this.#allowedTools = config.allowedTools === undefined ? undefined : new Set(config.allowedTools);
    this.#target = config.url === undefined ? 'mcp' : String(config.url);
    const suppliedTransport = config.transport;
    const transportFactory =
      config.transportFactory ??
      (suppliedTransport === undefined ? undefined : (): Transport => suppliedTransport);
    this.#connection = new McpConnection({
      // The `url` form is the connection's own: it builds the transport and carries the headers.
      ...(transportFactory === undefined ? {} : { transport: transportFactory }),
      ...(config.clientInfo === undefined ? {} : { clientInfo: config.clientInfo }),
      ...(config.url === undefined ? {} : { url: config.url }),
      ...(config.url === undefined || config.headers === undefined ? {} : { headers: config.headers }),
      ...(config.url === undefined || config.fetch === undefined ? {} : { fetch: config.fetch }),
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
   * Lists the server's tools as framework tools.
   *
   * Called on demand rather than at startup, so a server that is briefly unreachable fails the one
   * run that needed it instead of the whole process.
   *
   * Each tool is exposed under a provider-safe name (see {@link McpClientConfig.toolNamePrefix}).
   *
   * @throws {AgentFrameworkError} When two of the server's tools would be exposed under the same
   *   name. Silently keeping one of them would make the other unreachable, and which one survived
   *   would depend on the order the server happened to list them in.
   */
  async getTools(): Promise<Array<FunctionTool<Record<string, unknown>, unknown>>> {
    const { tools } = await this.#connection.listTools();
    const declared = tools as unknown as DeclaredTool[];

    const remoteByLocalName = new Map<string, string>();
    const exposed: Array<FunctionTool<Record<string, unknown>, unknown>> = [];
    for (const entry of declared) {
      if (!(this.#allowedTools?.has(entry.name) ?? true)) {
        continue;
      }
      const localName = localToolName(entry.name, this.#config.toolNamePrefix);
      const claimedBy = remoteByLocalName.get(localName);
      if (claimedBy !== undefined) {
        if (claimedBy !== entry.name) {
          throw new AgentFrameworkError(
            `MCP server ${this.#target} advertises two tools whose exposed name is the same ` +
              `"${localName}": "${claimedBy}" and "${entry.name}". Both cannot be offered to the ` +
              'model, so neither is: restrict `allowedTools` to one of them, or have the server ' +
              'rename one.',
          );
        }
        // The same tool listed twice names the same target, so the first entry stands. Offering it
        // twice would be the duplicate-name rejection this normalization exists to avoid.
        continue;
      }
      remoteByLocalName.set(localName, entry.name);
      exposed.push(this.#toFunctionTool(entry, localName));
    }
    return exposed;
  }

  /**
   * Discovers the server's Agent Skills, for `skillsProvider`.
   *
   * Skills and tools are independent: a server may publish either, both or neither, and this
   * shares the same connection as {@link McpClient.getTools} rather than opening a second one.
   *
   * ```ts
   * const agent = new Agent({ client, contextProviders: [skillsProvider(mcp.skillsSource())] });
   * ```
   */
  skillsSource(config?: McpSkillsSourceConfig): SkillsSource {
    return mcpSkillsSource(this.#connection, config);
  }

  #toFunctionTool(declared: DeclaredTool, localName: string): FunctionTool<Record<string, unknown>, unknown> {
    return tool({
      // The provider-facing name. Everything else below — the call, the approval decision, the
      // error text — stays on the server's own name, which is what identifies the tool remotely.
      name: localName,
      // Python parity (`_mcp.py`: `tool.description or ""`): a missing description stays empty
      // rather than the name doubling as prose.
      description: declared.description ?? '',
      // The server's JSON Schema is the contract; the framework does not re-derive it, it only
      // fills in what a provider requires but the server left implicit.
      parameters: normalizeInputSchema(declared.inputSchema),
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
            `MCP call to ${this.#target} failed: ${errorMessageOf(error)}`,
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
