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

/** A resource a {@link TestMcpServer} answers `resources/read` with. */
export interface TestResource {
  uri: string;
  mimeType?: string;
  /** Text content, or a base64 blob. Exactly one of the two. */
  text?: string;
  blob?: string;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * A minimal in-process MCP server, as a {@link Transport}.
 *
 * Enough of the protocol to exercise the client: `initialize`, `tools/list`, `tools/call` and
 * `resources/read`. A real server package would pull an extra dependency into the test graph for
 * no extra coverage of *this* package — what is under test is the framework's side of the
 * conversation.
 */
export class TestMcpServer implements Transport {
  readonly calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  /** Every `resources/read` URI requested, in order. */
  readonly reads: string[] = [];
  /** The `initialize` params of the most recent connection, capabilities included. */
  initializeParams: Record<string, unknown> | undefined;
  /** How many times the transport has been (re)started — one per connection. */
  starts = 0;
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  closed = false;

  readonly #tools: TestTool[];
  readonly #resources: TestResource[];
  readonly #protocolVersion: string;
  readonly #dieOnCalls: ReadonlySet<number>;
  #toolCallCount = 0;

  constructor(
    tools: TestTool[],
    options?: {
      protocolVersion?: string;
      dieOnCalls?: readonly number[];
      resources?: readonly TestResource[];
    },
  ) {
    this.#tools = tools;
    this.#resources = [...(options?.resources ?? [])];
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
          // Declared only when the server actually serves resources, so a client that checks
          // capabilities before asking sees what a real server would show it.
          capabilities: { tools: {}, ...(this.#resources.length === 0 ? {} : { resources: {} }) },
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
      case 'resources/read': {
        const uri = String(request.params?.uri);
        this.reads.push(uri);
        const found = this.#resources.find((entry) => entry.uri === uri);
        if (found === undefined) {
          // What a compliant server answers for a URI it does not serve: Invalid Params with the
          // requested URI echoed in `data`, which is how the SDK reconstructs its typed error.
          return {
            jsonrpc: '2.0',
            id: request.id as string | number,
            error: { code: -32602, message: `Resource not found: ${uri}`, data: { uri } },
          };
        }
        const { uri: _uri, ...contents } = found;
        return respond({ contents: [{ uri, ...contents }] });
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
