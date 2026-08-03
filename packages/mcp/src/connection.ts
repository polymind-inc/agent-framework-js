import type { CallToolResult, ListToolsResult, Transport } from '@modelcontextprotocol/client';
import { Client, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import { GEN_AI, MCP, setMcpSpanError, withMcpClientSpan } from '@polymind-inc/agent-framework-core';

/**
 * The version reported as `clientInfo.version` in the MCP `initialize` handshake.
 *
 * Kept in sync with `version` in this package's package.json; a unit test enforces the match.
 */
export const MCP_CLIENT_VERSION = '0.1.0';

/** The identity reported to servers when the consumer supplies no `clientInfo` of its own. */
const DEFAULT_CLIENT_INFO = { name: 'agent-framework-js', version: MCP_CLIENT_VERSION };

/**
 * Whether an error means the cached connection is gone, as opposed to the call being bad.
 *
 * Mirrors the reference implementation's predicate (`_call_tool_with_retries` in Python's
 * `_mcp.py`, which retries on `ClosedResourceError` or a session-terminated `McpError`):
 *
 * - `ConnectionClosed` — the transport died while the call was in flight;
 * - `NotConnected` — the transport had already died and the SDK dropped it;
 * - HTTP 404 — a Streamable HTTP server answers 404 once it has expired the session.
 *
 * A tool-level `isError` result or a genuine protocol error (bad params, unknown method) is
 * deliberately *not* matched: retrying those would repeat a call that was answered.
 */
function isConnectionLoss(error: unknown): boolean {
  if (error instanceof SdkHttpError) {
    return error.status === 404;
  }
  return (
    error instanceof SdkError &&
    (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected)
  );
}

/** The text of a result's `text` blocks, concatenated; used as the span's error description. */
function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  let out = '';
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out += block.text;
    }
  }
  return out;
}

/** Construction options for {@link McpConnection}. */
export interface McpConnectionConfig {
  /**
   * Creates the transport for a connection attempt.
   *
   * Called once per connection — including the reconnect after a lost one — so it should return
   * a fresh transport, or one that supports being started again after its connection died. This
   * is also the seam for per-call concerns such as a `fetch` wrapper that attaches authorization
   * to every request.
   */
  transport: () => Transport;
  /** How this client identifies itself to the server. Defaults to the framework's own identity. */
  clientInfo?: { name: string; version: string };
  /**
   * The server's URL, used only to stamp `server.address` / `server.port` onto every span.
   * Omit it for a transport with no meaningful URL (stdio, in-memory); the spans then carry no
   * address attributes.
   */
  url?: string | URL;
  /**
   * Whether an error from `tools/call` means the connection is gone, so the call should be
   * retried once on a fresh connection.
   *
   * Defaults to detecting a transport that died mid-call, one the SDK had already dropped, and
   * an expired Streamable HTTP session (HTTP 404). A JSON-RPC error *answer* is a verdict on the
   * call, not a lost connection, and is never retried by the default; override this to narrow
   * the retry further — never to retry answered calls.
   */
  shouldReconnect?: (error: unknown) => boolean;
}

/** Per-call options for {@link McpConnection.callTool}. */
export interface McpCallToolOptions {
  /**
   * The caller's cancellation, carried into the SDK's request options so an aborted run stops
   * the *remote* work rather than only abandoning the local promise.
   */
  signal?: AbortSignal;
}

/**
 * A lazily connected MCP session that survives a dropped connection.
 *
 * This is the connection-management layer {@link MCPClient} is built on, exposed for consumers
 * that speak MCP without the framework-tool packaging. Results come back as raw
 * `@modelcontextprotocol/client` types; converting them is the caller's responsibility.
 *
 * - **Lazy** — nothing touches the network until the first `listTools()` or `callTool()`, and
 *   concurrent first callers share a single connection attempt.
 * - **Self-healing** — a `callTool` that fails because the connection is gone is retried once on
 *   a fresh connection ({@link McpConnectionConfig.shouldReconnect}); any other failure, and a
 *   failure of the retry itself, surfaces unchanged.
 * - **Traced** — `initialize`, `tools/list` and `tools/call` are recorded as MCP client spans per
 *   the OTel MCP semantic conventions. A result that reports `isError` marks its span with
 *   `error.type = 'tool_error'` while still being returned, since whether to raise is the
 *   caller's decision.
 *
 * ```ts
 * const connection = new McpConnection({
 *   transport: () => new StreamableHTTPClientTransport(new URL('https://mcp.example.com/mcp')),
 *   url: 'https://mcp.example.com/mcp',
 * });
 * const { tools } = await connection.listTools();
 * const result = await connection.callTool('get_weather', { location: 'Tokyo' });
 * await connection.close();
 * ```
 */
export class McpConnection {
  readonly #transport: () => Transport;
  readonly #clientInfo: { name: string; version: string };
  readonly #url: string | URL | undefined;
  readonly #shouldReconnect: (error: unknown) => boolean;
  #client: Client | undefined;
  #connecting: Promise<Client> | undefined;
  /** Bumped by `close()`, so a connect that was in flight when it ran cannot resurrect the client. */
  #generation = 0;

  constructor(config: McpConnectionConfig) {
    this.#transport = config.transport;
    this.#clientInfo = config.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.#url = config.url;
    this.#shouldReconnect = config.shouldReconnect ?? isConnectionLoss;
  }

  /** Whether the connection has been opened. Exposed so callers can assert it stays lazy. */
  get connected(): boolean {
    return this.#client !== undefined;
  }

  /** Attributes every span of this connection carries. */
  #spanAttributes(): Record<string, string> {
    if (this.#url === undefined) {
      return {};
    }
    const url = new URL(String(this.#url));
    return {
      [MCP.serverAddress]: url.hostname,
      ...(url.port === '' ? {} : { [MCP.serverPort]: url.port }),
    };
  }

  async #connect(): Promise<Client> {
    if (this.#client !== undefined) {
      return this.#client;
    }
    const generation = this.#generation;
    // Concurrent callers share one attempt, and the in-flight promise is cleared when it settles so
    // a failed connection is retried by the next call rather than cached as a rejection. The clear
    // is guarded so a stale attempt cannot discard a newer one started after `close()`.
    if (this.#connecting === undefined) {
      const attempt: Promise<Client> = (async (): Promise<Client> => {
        const client = new Client(this.#clientInfo);
        const transport = this.#transport();
        await withMcpClientSpan('initialize', undefined, this.#spanAttributes(), async () => {
          await client.connect(transport);
        });
        return client;
      })().finally(() => {
        if (this.#connecting === attempt) {
          this.#connecting = undefined;
        }
      });
      this.#connecting = attempt;
    }
    const client = await this.#connecting;
    if (generation !== this.#generation) {
      // close() ran while this connect was in flight; caching the result would resurrect a
      // connection the caller believes is gone.
      await client.close().catch(() => {});
      throw new Error('McpConnection was closed while connecting.');
    }
    this.#client = client;
    client.onclose = (): void => {
      // The connection ended out of band — server death, network drop. Dropping the cache here
      // means the next call reconnects instead of being handed a client the SDK has already
      // disconnected (whose calls reject with an untyped "Not connected").
      this.#discard(client);
    };
    return client;
  }

  /** Drops a dead client from the cache, unless a concurrent caller already replaced it. */
  #discard(client: Client): void {
    if (this.#client === client) {
      this.#client = undefined;
      void client.close().catch(() => {});
    }
  }

  /**
   * Calls a tool on the live connection, reconnecting once if that connection turns out dead.
   *
   * Callers can resolve through here on every call rather than closing over the client that
   * existed earlier, so a reconnect swaps the connection under tools that were handed out before
   * it died. Matches the reference implementation's single-retry semantics
   * (`_call_tool_with_retries` in Python's `_mcp.py`): one reconnect, then the failure surfaces.
   *
   * The reconnect retry reuses the caller's signal because it is the same logical call; a fresh
   * one would leave the surviving attempt uncancellable. The signal is deliberately *not* passed
   * to the connect itself: the connection is shared by every caller of this instance, so one
   * caller's abort must not tear it down under the others.
   */
  async #callToolWithRetry(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<CallToolResult> {
    const options = signal === undefined ? undefined : { signal };
    const client = await this.#connect();
    try {
      return await client.callTool({ name, arguments: args }, options);
    } catch (error) {
      if (!this.#shouldReconnect(error)) {
        throw error;
      }
      this.#discard(client);
      const fresh = await this.#connect();
      return fresh.callTool({ name, arguments: args }, options);
    }
  }

  /**
   * Lists the server's tools, as `tools/list` reports them.
   *
   * Connects on first use; a failed connection is surfaced to this caller and retried by the
   * next one.
   */
  async listTools(): Promise<ListToolsResult> {
    const client = await this.#connect();
    return withMcpClientSpan('tools/list', undefined, this.#spanAttributes(), async () => client.listTools());
  }

  /**
   * Calls a tool and returns the raw result, `isError` and all.
   *
   * The call is retried once on a fresh connection when the failure means the connection is gone
   * ({@link McpConnectionConfig.shouldReconnect}); an answered call — a tool-level `isError`
   * result, a JSON-RPC error — is never replayed. A result that reports `isError` marks the span
   * with `error.type = 'tool_error'` but is still returned: the call succeeded and the tool
   * declined, and whether that becomes an exception is the caller's decision.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: McpCallToolOptions,
  ): Promise<CallToolResult> {
    return withMcpClientSpan(
      'tools/call',
      name,
      { ...this.#spanAttributes(), [GEN_AI.toolName]: name, [GEN_AI.toolType]: 'mcp' },
      async (span) => {
        const result = await this.#callToolWithRetry(name, args, options?.signal);
        if (result.isError === true) {
          const text = textOfBlocks(result.content);
          setMcpSpanError(span, 'tool_error', text === '' ? undefined : text);
        }
        return result;
      },
    );
  }

  /** Closes the connection. Safe to call when it was never opened. */
  async close(): Promise<void> {
    // The bump makes an in-flight #connect discard its result instead of resurrecting the client;
    // clearing #connecting lets a *later* call start over cleanly.
    this.#generation++;
    const client = this.#client;
    this.#client = undefined;
    this.#connecting = undefined;
    await client?.close();
  }
}
