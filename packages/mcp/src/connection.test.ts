import { readFileSync } from 'node:fs';
import type { CallToolRequestOptions, CallToolResult } from '@modelcontextprotocol/client';
import { Client, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { SpanKind, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ConfigurationError } from '@polymind-inc/agent-framework-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_CLIENT_VERSION, McpConnection } from './connection.js';
import type { TestTool } from './test-server.js';
import { TestMcpServer } from './test-server.js';

function echoTool(): TestTool {
  return {
    name: 'echo',
    description: 'Echoes its input',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    call: (args) => ({ content: [{ type: 'text', text: `echo:${String(args.value)}` }] }),
  };
}

function connectionTo(transport: TestMcpServer): McpConnection {
  return new McpConnection({ transport: () => transport });
}

describe('url-driven construction', () => {
  it('builds its own transport, attaching the configured headers per request', async () => {
    const seen: Array<Record<string, string>> = [];
    let issued = 0;
    const stub = (async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response('nope', { status: 500 });
    }) as unknown as typeof globalThis.fetch;
    const connection = new McpConnection({
      url: 'https://mcp.example.com/mcp',
      headers: () => {
        issued += 1;
        return { authorization: `Bearer token-${issued}` };
      },
      fetch: stub,
    });

    await expect(connection.listTools()).rejects.toThrow();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.authorization).toBe('Bearer token-1');
  });

  it('needs a transport or a url to build one from', () => {
    expect(() => new McpConnection({})).toThrow(ConfigurationError);
  });

  it('refuses headers or fetch alongside a custom transport, which owns both', () => {
    // Silently ignoring them would look like a working credential that never reaches the wire.
    const stub = (async (): Promise<Response> => new Response('{}')) as unknown as typeof globalThis.fetch;
    expect(
      () => new McpConnection({ transport: () => new TestMcpServer([]), headers: { 'x-api-key': 'k' } }),
    ).toThrow(ConfigurationError);
    expect(() => new McpConnection({ transport: () => new TestMcpServer([]), fetch: stub })).toThrow(
      ConfigurationError,
    );
  });
});

describe('handshake identity', () => {
  it('reports the package version, verbatim from package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(MCP_CLIENT_VERSION).toBe(pkg.version);
  });

  it('identifies itself with the framework identity by default', async () => {
    const transport = new TestMcpServer([echoTool()]);
    const connection = connectionTo(transport);

    await connection.listTools();

    expect(transport.initializeParams?.clientInfo).toEqual({
      name: 'agent-framework-js',
      version: MCP_CLIENT_VERSION,
    });
    await connection.close();
  });

  it('lets the consumer replace the identity', async () => {
    const transport = new TestMcpServer([echoTool()]);
    const connection = new McpConnection({
      transport: () => transport,
      clientInfo: { name: 'my-app', version: '9.9.9' },
    });

    await connection.listTools();

    expect(transport.initializeParams?.clientInfo).toEqual({ name: 'my-app', version: '9.9.9' });
    await connection.close();
  });
});

describe('lifecycle', () => {
  it('stays disconnected until something needs the server', async () => {
    const transport = new TestMcpServer([echoTool()]);
    const connection = connectionTo(transport);
    expect(connection.connected).toBe(false);

    await connection.listTools();

    expect(connection.connected).toBe(true);
    await connection.close();
    expect(connection.connected).toBe(false);
  });

  it('is safe to close before it ever connected', async () => {
    const connection = connectionTo(new TestMcpServer([echoTool()]));
    await connection.close();
    expect(connection.connected).toBe(false);
  });

  it('does not let a connect that raced close() resurrect the client', async () => {
    const transport = new SlowStartServer([echoTool()]);
    const connection = connectionTo(transport);

    const pending = connection.listTools();
    await transport.reached;
    await connection.close();
    transport.release();

    await expect(pending).rejects.toThrow(/closed while connecting/);
    expect(connection.connected).toBe(false);

    // The instance is still usable: a later call opens a fresh connection.
    const { tools } = await connection.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    await connection.close();
  });
});

describe('raw results', () => {
  it('returns the tool list as the server declared it', async () => {
    const connection = connectionTo(new TestMcpServer([echoTool()]));

    const { tools } = await connection.listTools();

    expect(tools).toEqual([
      {
        name: 'echo',
        description: 'Echoes its input',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      },
    ]);
    await connection.close();
  });

  it('returns the call result without converting it', async () => {
    const transport = new TestMcpServer([echoTool()]);
    const connection = connectionTo(transport);

    const result = await connection.callTool('echo', { value: 'hi' });

    expect(result).toEqual({ content: [{ type: 'text', text: 'echo:hi' }] });
    expect(transport.calls).toEqual([{ name: 'echo', arguments: { value: 'hi' } }]);
    await connection.close();
  });

  it('returns an isError result instead of raising it', async () => {
    // Whether a declined tool call becomes an exception is the consumer's decision — MCPClient
    // raises, a host relaying raw MCP blocks does not — so the primitive hands the result back.
    const connection = connectionTo(
      new TestMcpServer([
        {
          name: 'explode',
          call: () => ({ content: [{ type: 'text', text: 'the tool is broken' }], isError: true }),
        },
      ]),
    );

    const result = await connection.callTool('explode', {});

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'the tool is broken' }]);
    await connection.close();
  });
});

describe('connection recovery', () => {
  function echoServer(dieOnCalls: readonly number[]): TestMcpServer {
    return new TestMcpServer([echoTool()], { dieOnCalls });
  }

  it('reconnects and retries once when the connection dies under a call', async () => {
    const transport = echoServer([1]);
    const connection = connectionTo(transport);

    const result = await connection.callTool('echo', { value: 'hi' });

    expect(result.content).toEqual([{ type: 'text', text: 'echo:hi' }]);
    expect(transport.starts).toBe(2);
    await connection.close();
  });

  it('retries at most once, then recovers on the next call', async () => {
    const transport = echoServer([1, 2]);
    const connection = connectionTo(transport);

    // First call: dies, reconnects, and the retry dies too — the failure surfaces rather than
    // looping on reconnects.
    await expect(connection.callTool('echo', { value: 'one' })).rejects.toThrow();
    // Next call: the cached connection is dead, so it reconnects once and succeeds.
    const result = await connection.callTool('echo', { value: 'two' });
    expect(result.content).toEqual([{ type: 'text', text: 'echo:two' }]);
    expect(transport.starts).toBe(3);
    await connection.close();
  });

  it('does not treat a protocol error as a dead connection', async () => {
    const transport = new TestMcpServer([
      {
        name: 'crash',
        call: () => {
          throw new Error('server exploded');
        },
      },
    ]);
    const connection = connectionTo(transport);

    await expect(connection.callTool('crash', {})).rejects.toThrow(/server exploded/);
    // One request on the wire: a JSON-RPC error answer is a verdict, not a lost connection.
    expect(transport.calls).toHaveLength(1);
    expect(transport.starts).toBe(1);
    await connection.close();
  });

  it('lets the consumer veto the reconnect retry', async () => {
    const transport = echoServer([1]);
    const connection = new McpConnection({
      transport: () => transport,
      shouldReconnect: () => false,
    });

    await expect(connection.callTool('echo', { value: 'hi' })).rejects.toThrow();
    // The dropped connection would have been retried by the default predicate.
    expect(transport.starts).toBe(1);
    await connection.close();
  });
});

describe('cancellation', () => {
  it('forwards the signal to the request options, on the first attempt and the retry', async () => {
    const seen: Array<CallToolRequestOptions | undefined> = [];
    const spy = vi
      .spyOn(Client.prototype, 'callTool')
      .mockImplementation(async (_params, options): Promise<CallToolResult> => {
        seen.push(options);
        if (seen.length === 1) {
          throw new SdkError(SdkErrorCode.ConnectionClosed, 'connection closed');
        }
        return { content: [{ type: 'text', text: 'ok' }] };
      });
    try {
      const connection = connectionTo(new TestMcpServer([echoTool()]));
      const controller = new AbortController();

      await connection.callTool('echo', { value: 'hi' }, { signal: controller.signal });

      expect(seen).toHaveLength(2);
      expect(seen[0]?.signal).toBe(controller.signal);
      expect(seen[1]?.signal).toBe(controller.signal);
      await connection.close();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('telemetry', () => {
  // One provider for the whole block: the OTel API accepts a single global registration per
  // process, so a second `setGlobalTracerProvider` would be silently ignored.
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  beforeAll(() => {
    trace.setGlobalTracerProvider(provider);
  });
  beforeEach(() => {
    exporter.reset();
  });
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
  });

  it('records MCP client spans for initialize, tools/list and tools/call', async () => {
    const connection = new McpConnection({
      transport: () => new TestMcpServer([echoTool()]),
      url: 'https://mcp.example.com:8443/mcp',
    });
    await connection.listTools();
    await connection.callTool('echo', { value: 'hi' });
    await connection.close();

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(['initialize', 'tools/list', 'tools/call echo']);
    for (const span of spans) {
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.attributes['server.address']).toBe('mcp.example.com');
      expect(span.attributes['server.port']).toBe('8443');
    }
    const call = spans.find((s) => s.name === 'tools/call echo');
    expect(call?.attributes['mcp.method.name']).toBe('tools/call');
    expect(call?.attributes['gen_ai.tool.name']).toBe('echo');
    expect(call?.attributes['gen_ai.tool.type']).toBe('mcp');
  });

  it('marks an isError result tool_error even though the result is returned', async () => {
    const connection = connectionTo(
      new TestMcpServer([
        {
          name: 'explode',
          call: () => ({ content: [{ type: 'text', text: 'the tool is broken' }], isError: true }),
        },
      ]),
    );
    const result = await connection.callTool('explode', {});
    await connection.close();

    expect(result.isError).toBe(true);
    const span = exporter.getFinishedSpans().find((s) => s.name === 'tools/call explode');
    expect(span?.attributes['error.type']).toBe('tool_error');
    expect(span?.status.message).toBe('the tool is broken');
  });
});

/** A transport whose first `start()` blocks until the test releases it. */
class SlowStartServer extends TestMcpServer {
  release!: () => void;
  /** Resolves once the client's connect has reached the transport. */
  readonly reached: Promise<void>;
  readonly #gate: Promise<void>;
  #reachedResolve!: () => void;
  #first = true;

  constructor(tools: TestTool[]) {
    super(tools);
    this.#gate = new Promise((resolve) => {
      this.release = resolve;
    });
    this.reached = new Promise((resolve) => {
      this.#reachedResolve = resolve;
    });
  }

  override async start(): Promise<void> {
    if (this.#first) {
      this.#first = false;
      this.#reachedResolve();
      await this.#gate;
    }
    await super.start();
  }
}
