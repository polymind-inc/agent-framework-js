import type { Transport } from '@modelcontextprotocol/client';

/** A tool a {@link TestMcpServer} answers `tools/list` with. */
export interface TestTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** What `tools/call` returns. Throw to answer with a JSON-RPC error. */
  call: (args: Record<string, unknown>) => {
    content: unknown[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    /** The result-level metadata envelope every MCP result may carry. */
    _meta?: Record<string, unknown>;
  };
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * A minimal in-process MCP server, as a {@link Transport}.
 *
 * Enough of the protocol to exercise the client: `initialize`, `tools/list` and `tools/call`. A
 * real server package would pull an extra dependency into the test graph for no extra coverage of
 * *this* package — what is under test is the framework's side of the conversation.
 */
export class TestMcpServer implements Transport {
  readonly calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  /** The `initialize` params of the most recent connection, capabilities included. */
  initializeParams: Record<string, unknown> | undefined;
  /** How many times the transport has been (re)started — one per connection. */
  starts = 0;
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  closed = false;

  readonly #tools: TestTool[];
  readonly #protocolVersion: string;
  readonly #dieOnCalls: ReadonlySet<number>;
  #toolCallCount = 0;

  constructor(tools: TestTool[], options?: { protocolVersion?: string; dieOnCalls?: readonly number[] }) {
    this.#tools = tools;
    this.#protocolVersion = options?.protocolVersion ?? '2025-06-18';
    this.#dieOnCalls = new Set(options?.dieOnCalls ?? []);
  }

  async start(): Promise<void> {
    // Nothing to open: the "server" is this object. Reconnectable on purpose, so the client's
    // dead-connection recovery can be exercised against the same instance.
    this.closed = false;
    this.starts++;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
  }

  async send(message: unknown): Promise<void> {
    const request = message as JsonRpcMessage;
    if (request.id === undefined) {
      // A notification (`notifications/initialized`); nothing to answer.
      return;
    }
    if (request.method === 'tools/call' && this.#dieOnCalls.has(++this.#toolCallCount)) {
      // The scripted death: the request is never answered, the connection just drops — exactly
      // what a killed server process looks like from the client's side.
      queueMicrotask(() => {
        this.closed = true;
        this.onclose?.();
      });
      return;
    }
    const reply = this.#handle(request);
    // Queued rather than delivered inline, so the client's pending-request bookkeeping is in place
    // before the answer arrives — exactly how a real transport behaves.
    queueMicrotask(() => this.onmessage?.(reply));
  }

  #handle(request: JsonRpcMessage): JsonRpcMessage {
    const respond = (result: unknown): JsonRpcMessage => ({
      jsonrpc: '2.0',
      id: request.id as string | number,
      result,
    });
    switch (request.method) {
      case 'initialize':
        this.initializeParams = request.params ?? {};
        return respond({
          protocolVersion: this.#protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'test-mcp-server', version: '1.0.0' },
        });
      case 'tools/list':
        return respond({
          tools: this.#tools.map((entry) => ({
            name: entry.name,
            ...(entry.description === undefined ? {} : { description: entry.description }),
            inputSchema: entry.inputSchema ?? { type: 'object' },
          })),
        });
      case 'tools/call': {
        const params = request.params ?? {};
        const name = String(params.name);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        this.calls.push({ name, arguments: args });
        const target = this.#tools.find((entry) => entry.name === name);
        if (target === undefined) {
          return {
            jsonrpc: '2.0',
            id: request.id as string | number,
            error: { code: -32602, message: `Unknown tool: ${name}` },
          };
        }
        try {
          return respond(target.call(args));
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id: request.id as string | number,
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          };
        }
      }
      case 'ping':
        return respond({});
      default:
        return {
          jsonrpc: '2.0',
          id: request.id as string | number,
          error: { code: -32601, message: `Method not found: ${String(request.method)}` },
        };
    }
  }
}
