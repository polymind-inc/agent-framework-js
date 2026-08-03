import type { CallToolRequestOptions, CallToolResult } from '@modelcontextprotocol/client';
import { Client, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { SpanKind, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { Content } from '@polymind-inc/agent-framework-core';
import {
  Agent,
  ConfigurationError,
  serializeContent,
  ToolInvocationError,
  textContent,
} from '@polymind-inc/agent-framework-core';
import { MockChatClient } from '@polymind-inc/agent-framework-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { MCPClient } from './client.js';
import { fromMcpContent } from './content.js';
import type { TestTool } from './test-server.js';
import { TestMcpServer } from './test-server.js';

function server(): TestMcpServer {
  return new TestMcpServer([
    {
      name: 'echo',
      description: 'Echoes its input',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      call: (args) => ({ content: [{ type: 'text', text: `echo:${String(args.value)}` }] }),
    },
    {
      name: 'explode',
      description: 'Always fails',
      call: () => ({ content: [{ type: 'text', text: 'the tool is broken' }], isError: true }),
    },
    {
      name: 'crash',
      description: 'Fails at the protocol level',
      call: () => {
        throw new Error('server exploded');
      },
    },
  ]);
}

describe('tool enumeration', () => {
  it('stays disconnected until tools are needed', async () => {
    const mcp = new MCPClient({ transport: server() });
    expect(mcp.connected).toBe(false);

    await mcp.getTools();

    expect(mcp.connected).toBe(true);
    await mcp.close();
  });

  it('advertises no sampling or elicitation capability', async () => {
    // This client consumes tools; it does not answer server-initiated requests. Declaring
    // the capability is what invites `sampling/createMessage` and `elicitation/create`, so a
    // well-behaved server never sends either. See the package README for why they are out of scope.
    const transport = server();
    const mcp = new MCPClient({ transport });

    await mcp.getTools();

    const capabilities = (transport.initializeParams?.capabilities ?? {}) as Record<string, unknown>;
    expect(capabilities.sampling).toBeUndefined();
    expect(capabilities.elicitation).toBeUndefined();
    await mcp.close();
  });

  it('exposes the server tools with their own schemas', async () => {
    const mcp = new MCPClient({ transport: server() });

    const tools = await mcp.getTools();

    expect(tools.map((t) => t.name)).toEqual(['echo', 'explode', 'crash']);
    expect(tools[0]?.description).toBe('Echoes its input');
    expect(tools[0]?.jsonSchema).toEqual({
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    });
    await mcp.close();
  });

  it('leaves the description empty when the server declares none', async () => {
    const mcp = new MCPClient({
      transport: new TestMcpServer([{ name: 'bare', call: () => ({ content: [] }) }]),
    });
    const [bare] = await mcp.getTools();
    // Python parity (`_mcp.py`: `tool.description or ""`): the name is not reused as prose.
    expect(bare?.description).toBe('');
    await mcp.close();
  });

  it('honours the allowlist', async () => {
    const mcp = new MCPClient({ transport: server(), allowedTools: ['echo'] });
    const tools = await mcp.getTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    await mcp.close();
  });

  it('applies the approval policy', async () => {
    const mcp = new MCPClient({
      transport: server(),
      approvalMode: (name) => (name === 'echo' ? 'never_require' : 'always_require'),
    });
    const tools = await mcp.getTools();
    expect(tools.map((t) => [t.name, t.approvalMode])).toEqual([
      ['echo', 'never_require'],
      ['explode', 'always_require'],
      ['crash', 'always_require'],
    ]);
    await mcp.close();
  });

  it('refuses a configuration without exactly one connection source', () => {
    expect(() => new MCPClient({})).toThrow(ConfigurationError);
    expect(() => new MCPClient({ url: 'https://example.com/mcp', transport: server() })).toThrow(
      ConfigurationError,
    );
    expect(() => new MCPClient({ transport: server(), transportFactory: server })).toThrow(
      ConfigurationError,
    );
  });
});

describe('tool invocation', () => {
  it('calls the server and returns its content', async () => {
    const transport = server();
    const mcp = new MCPClient({ transport });
    const [echo] = await mcp.getTools();

    const result = await echo?.execute?.({ value: 'hi' }, { callId: 'call_1' });

    expect(result).toEqual([expect.objectContaining({ type: 'text', text: 'echo:hi' })]);
    expect(transport.calls).toEqual([{ name: 'echo', arguments: { value: 'hi' } }]);
    await mcp.close();
  });

  it('turns an isError result into a ToolInvocationError carrying the text', async () => {
    const mcp = new MCPClient({ transport: server() });
    const tools = await mcp.getTools();
    const explode = tools.find((t) => t.name === 'explode');

    await expect(explode?.execute?.({}, { callId: 'call_1' })).rejects.toThrow('the tool is broken');
    await mcp.close();
  });

  it('wraps a protocol-level failure', async () => {
    const mcp = new MCPClient({ transport: server() });
    const tools = await mcp.getTools();
    const crash = tools.find((t) => t.name === 'crash');

    await expect(crash?.execute?.({}, { callId: 'call_1' })).rejects.toThrow(ToolInvocationError);
    await mcp.close();
  });

  it('surfaces structuredContent as a JSON text content', async () => {
    // A server may answer with *only* structuredContent; dropping it would hand the model an
    // empty result. Python appends json.dumps(structuredContent) as a text content.
    const mcp = new MCPClient({
      transport: new TestMcpServer([
        { name: 'structured', call: () => ({ content: [], structuredContent: { answer: 42 } }) },
      ]),
    });
    const [structured] = await mcp.getTools();

    const result = await structured?.execute?.({}, { callId: 'call_1' });

    expect(result).toEqual([{ type: 'text', text: '{"answer":42}' }]);
    await mcp.close();
  });

  it('appends structuredContent after the regular content', async () => {
    const mcp = new MCPClient({
      transport: new TestMcpServer([
        {
          name: 'both',
          call: () => ({
            content: [{ type: 'text', text: 'prose' }],
            structuredContent: { answer: 42 },
          }),
        },
      ]),
    });
    const [both] = await mcp.getTools();

    const result = (await both?.execute?.({}, { callId: 'call_1' })) as Content[];

    expect(result.map((content) => (content as { text?: string }).text)).toEqual(['prose', '{"answer":42}']);
    await mcp.close();
  });

  it('stamps the result _meta onto every content item it produced', async () => {
    // An MCP server can attach a `_meta` envelope to a tool result (Information Flow
    // Control labels, for instance). Python copies it onto each produced Content under
    // `additional_properties["_meta"]` (`_mcp.py` `_parse_tool_result_from_mcp`) so downstream
    // security layers can derive per-item labels; dropping it loses that signal entirely.
    const meta = { ifc: { label: 'confidential' } };
    const mcp = new MCPClient({
      transport: new TestMcpServer([
        {
          name: 'labelled',
          call: () => ({
            content: [
              { type: 'text', text: 'a' },
              { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            ],
            _meta: meta,
          }),
        },
      ]),
    });
    const [labelled] = await mcp.getTools();

    const result = (await labelled?.execute?.({}, { callId: 'call_1' })) as Content[];

    expect(result.map((content) => content.additionalProperties)).toEqual([{ _meta: meta }, { _meta: meta }]);
    await mcp.close();
  });

  it('leaves additionalProperties alone when the result carries no _meta', async () => {
    // Python only passes `additional_properties` when the envelope is non-empty (`if meta`), so an
    // ordinary result must not grow an empty one.
    const mcp = new MCPClient({
      transport: new TestMcpServer([
        { name: 'plain', call: () => ({ content: [{ type: 'text', text: 'a' }], _meta: {} }) },
      ]),
    });
    const [plain] = await mcp.getTools();

    const result = (await plain?.execute?.({}, { callId: 'call_1' })) as Content[];

    expect(result[0]?.additionalProperties).toBeUndefined();
    await mcp.close();
  });

  it('stamps _meta on the "null" fallback but not on structuredContent, as Python does', async () => {
    // Python builds the structuredContent text *without* `**additional_kwargs` and the empty-result
    // "null" text *with* it. Mirror that split rather than tidying it up.
    const meta = { ifc: { label: 'confidential' } };
    const mcp = new MCPClient({
      transport: new TestMcpServer([
        { name: 'structured', call: () => ({ content: [], structuredContent: { a: 1 }, _meta: meta }) },
        { name: 'silent', call: () => ({ content: [], _meta: meta }) },
      ]),
    });
    const tools = await mcp.getTools();

    const structured = (await tools
      .find((t) => t.name === 'structured')
      ?.execute?.({}, { callId: 'call_1' })) as Content[];
    const silent = (await tools
      .find((t) => t.name === 'silent')
      ?.execute?.({}, { callId: 'call_2' })) as Content[];

    expect(structured[0]?.additionalProperties).toBeUndefined();
    expect(silent).toEqual([{ type: 'text', text: 'null', additionalProperties: { _meta: meta } }]);
    await mcp.close();
  });

  it('returns a literal "null" text for an empty result', async () => {
    // Python parity: the model sees an answer instead of an absent one.
    const mcp = new MCPClient({
      transport: new TestMcpServer([{ name: 'silent', call: () => ({ content: [] }) }]),
    });
    const [silent] = await mcp.getTools();

    const result = await silent?.execute?.({}, { callId: 'call_1' });

    expect(result).toEqual([{ type: 'text', text: 'null' }]);
    await mcp.close();
  });
});

describe('connection recovery', () => {
  function echoServer(dieOnCalls: readonly number[]): TestMcpServer {
    return new TestMcpServer(
      [
        {
          name: 'echo',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
          call: (args) => ({ content: [{ type: 'text', text: `echo:${String(args.value)}` }] }),
        },
      ],
      { dieOnCalls },
    );
  }

  it('reconnects and retries once when the connection dies under a call', async () => {
    const transports: TestMcpServer[] = [];
    const mcp = new MCPClient({
      transportFactory: () => {
        const transport = echoServer(transports.length === 0 ? [2] : []);
        transports.push(transport);
        return transport;
      },
    });
    const [echo] = await mcp.getTools();

    expect(await echo?.execute?.({ value: 'one' }, { callId: 'call_1' })).toEqual([
      expect.objectContaining({ text: 'echo:one' }),
    ]);
    // The second call's request is dropped mid-flight. The tool was obtained *before* the death,
    // so this also proves tools resolve the live connection instead of the one they were built on.
    expect(await echo?.execute?.({ value: 'two' }, { callId: 'call_2' })).toEqual([
      expect.objectContaining({ text: 'echo:two' }),
    ]);
    expect(transports).toHaveLength(2);
    expect(transports.map((transport) => transport.starts)).toEqual([1, 1]);
    await mcp.close();
  });

  it('retries at most once, then recovers on the next call', async () => {
    const transports: TestMcpServer[] = [];
    const mcp = new MCPClient({
      transportFactory: () => {
        const transport = echoServer(transports.length < 2 ? [1] : []);
        transports.push(transport);
        return transport;
      },
    });
    const [echo] = await mcp.getTools();

    // First call: dies, reconnects, and the retry dies too — the failure surfaces rather than
    // looping on reconnects.
    await expect(echo?.execute?.({ value: 'one' }, { callId: 'call_1' })).rejects.toThrow(
      ToolInvocationError,
    );
    // Next call: the cached connection is dead, so it reconnects once and succeeds.
    expect(await echo?.execute?.({ value: 'two' }, { callId: 'call_2' })).toEqual([
      expect.objectContaining({ text: 'echo:two' }),
    ]);
    expect(transports).toHaveLength(3);
    expect(transports.map((transport) => transport.starts)).toEqual([1, 1, 1]);
    await mcp.close();
  });

  it('does not restart a supplied one-shot transport after connection loss', async () => {
    const transport = echoServer([1]);
    const mcp = new MCPClient({ transport });
    const [echo] = await mcp.getTools();

    await expect(echo?.execute?.({ value: 'one' }, { callId: 'call_1' })).rejects.toThrow(
      ToolInvocationError,
    );
    expect(transport.starts).toBe(1);
    await mcp.close();
  });

  it('does not treat a protocol error as a dead connection', async () => {
    const transport = server();
    const mcp = new MCPClient({ transport });
    const crash = (await mcp.getTools()).find((t) => t.name === 'crash');

    await expect(crash?.execute?.({}, { callId: 'call_1' })).rejects.toThrow(/server exploded/);
    // One request on the wire: a JSON-RPC error answer is a verdict, not a lost connection.
    expect(transport.calls).toHaveLength(1);
    expect(transport.starts).toBe(1);
    await mcp.close();
  });

  it('does not let a connect that raced close() resurrect the client', async () => {
    const transport = new SlowStartServer([
      { name: 'echo', call: () => ({ content: [{ type: 'text', text: 'hi' }] }) },
    ]);
    const mcp = new MCPClient({ transport });

    const pending = mcp.getTools();
    await transport.reached;
    await mcp.close();
    transport.release();

    await expect(pending).rejects.toThrow(/closed while connecting/);
    expect(mcp.connected).toBe(false);

    // The instance is still usable: a later call opens a fresh connection.
    const tools = await mcp.getTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    await mcp.close();
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

/** A transport that accepts `tools/call` and never answers it, so the call stays in flight. */
class HangingCallServer extends TestMcpServer {
  /** Resolves once a `tools/call` has reached the transport. */
  readonly reached: Promise<void>;
  #reachedResolve!: () => void;

  constructor(tools: TestTool[]) {
    super(tools);
    this.reached = new Promise((resolve) => {
      this.#reachedResolve = resolve;
    });
  }

  override async send(message: unknown): Promise<void> {
    if ((message as { method?: string }).method === 'tools/call') {
      this.#reachedResolve();
      return;
    }
    await super.send(message);
  }
}

describe('cancellation', () => {
  function echoServer(): TestMcpServer {
    return new TestMcpServer([
      {
        name: 'echo',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
        call: (args) => ({ content: [{ type: 'text', text: `echo:${String(args.value)}` }] }),
      },
    ]);
  }

  it('forwards the tool context signal to the MCP request options', async () => {
    // A remote tool keeps working — and keeps causing side effects — until the request is
    // cancelled on the wire. `ToolContext.signal` is the framework's cancellation, so it has to
    // reach `callTool`'s request options; the .NET reference threads its `CancellationToken`
    // into `CallToolAsync` the same way.
    const seen: Array<CallToolRequestOptions | undefined> = [];
    const spy = vi
      .spyOn(Client.prototype, 'callTool')
      .mockImplementation(async (_params, options): Promise<CallToolResult> => {
        seen.push(options);
        return { content: [{ type: 'text', text: 'ok' }] };
      });
    try {
      const mcp = new MCPClient({ transport: echoServer() });
      const [echo] = await mcp.getTools();
      const controller = new AbortController();

      await echo?.execute?.({ value: 'hi' }, { callId: 'call_1', signal: controller.signal });

      expect(seen).toHaveLength(1);
      expect(seen[0]?.signal).toBe(controller.signal);
      await mcp.close();
    } finally {
      spy.mockRestore();
    }
  });

  it('uses the same signal on the reconnect retry', async () => {
    // The reconnect recovery path calls `callTool` a second time on a fresh connection. A retry that
    // dropped the signal would leave the *surviving* call uncancellable.
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
      const mcp = new MCPClient({ transportFactory: echoServer });
      const [echo] = await mcp.getTools();
      const controller = new AbortController();

      await echo?.execute?.({ value: 'hi' }, { callId: 'call_1', signal: controller.signal });

      expect(seen).toHaveLength(2);
      expect(seen[0]?.signal).toBe(controller.signal);
      expect(seen[1]?.signal).toBe(controller.signal);
      await mcp.close();
    } finally {
      spy.mockRestore();
    }
  });

  it('never puts an already-aborted call on the wire', async () => {
    const transport = echoServer();
    const mcp = new MCPClient({ transport });
    const [echo] = await mcp.getTools();
    const controller = new AbortController();
    controller.abort();

    await expect(
      echo?.execute?.({ value: 'hi' }, { callId: 'call_1', signal: controller.signal }),
    ).rejects.toThrow(ToolInvocationError);
    expect(transport.calls).toEqual([]);
    await mcp.close();
  });

  it('rejects a call that is aborted while it is in flight', async () => {
    const transport = new HangingCallServer([
      { name: 'slow', call: () => ({ content: [{ type: 'text', text: 'never' }] }) },
    ]);
    const mcp = new MCPClient({ transport });
    const [slow] = await mcp.getTools();
    const controller = new AbortController();

    const pending = slow?.execute?.({}, { callId: 'call_1', signal: controller.signal });
    await transport.reached;
    controller.abort();

    await expect(pending).rejects.toThrow(ToolInvocationError);
    await mcp.close();
  });
});

describe('content conversion', () => {
  it('maps every MCP content kind', () => {
    expect(fromMcpContent({ type: 'text', text: 'hi' })).toMatchObject({ type: 'text', text: 'hi' });
    expect(fromMcpContent({ type: 'image', data: 'AAAA', mimeType: 'image/png' })).toMatchObject({
      type: 'data',
      uri: 'data:image/png;base64,AAAA',
      mediaType: 'image/png',
    });
    expect(fromMcpContent({ type: 'audio', data: 'BBBB', mimeType: 'audio/wav' })).toMatchObject({
      type: 'data',
      mediaType: 'audio/wav',
    });
    expect(
      fromMcpContent({
        type: 'resource_link',
        uri: 'file:///a.txt',
        name: 'a.txt',
        mimeType: 'text/plain',
      }),
    ).toMatchObject({ type: 'uri', uri: 'file:///a.txt', name: 'a.txt' });
    expect(
      fromMcpContent({ type: 'resource', resource: { uri: 'file:///a.txt', text: 'inline' } }),
    ).toMatchObject({ type: 'text', text: 'inline' });
    expect(
      fromMcpContent({
        type: 'resource',
        resource: { uri: 'file:///a.bin', blob: 'CCCC', mimeType: 'application/octet-stream' },
      }),
    ).toMatchObject({ type: 'data', mediaType: 'application/octet-stream' });
  });

  it('wraps a raw base64 blob resource in a data URI', () => {
    expect(
      fromMcpContent({
        type: 'resource',
        resource: { uri: 'file:///a.bin', blob: 'CCCC', mimeType: 'application/octet-stream' },
      }),
    ).toMatchObject({
      type: 'data',
      uri: 'data:application/octet-stream;base64,CCCC',
      mediaType: 'application/octet-stream',
    });
  });

  it('does not double-wrap a blob resource that already carries a data URI', () => {
    // A misbehaving server may put a full data URI in `blob` even though the MCP schema
    // says base64. Python guards against that (`_mcp.py`: `if not blob.startswith("data:")`),
    // so the blob is passed through instead of being wrapped a second time.
    expect(
      fromMcpContent({
        type: 'resource',
        resource: {
          uri: 'file:///a.png',
          blob: 'data:image/png;base64,AAAA',
          mimeType: 'image/png',
        },
      }),
    ).toMatchObject({
      type: 'data',
      uri: 'data:image/png;base64,AAAA',
      mediaType: 'image/png',
    });
  });

  it('keeps the guard scoped to blob resources, as Python does', () => {
    // Python only guards the `BlobResourceContents` branch: image/audio payloads go through
    // `base64.b64decode` with no `data:` check, so no prefix stripping happens there.
    // Mirror that scope exactly rather than guarding more than the reference implementation.
    expect(
      fromMcpContent({ type: 'image', data: 'data:image/png;base64,AAAA', mimeType: 'image/png' }),
    ).toMatchObject({ type: 'data', uri: 'data:image/png;base64,data:image/png;base64,AAAA' });
    expect(
      fromMcpContent({ type: 'audio', data: 'data:audio/wav;base64,BBBB', mimeType: 'audio/wav' }),
    ).toMatchObject({ type: 'data', uri: 'data:audio/wav;base64,data:audio/wav;base64,BBBB' });
  });

  it('defaults a blob resource with no mimeType to application/octet-stream', () => {
    // `BlobResourceContents.mimeType` is optional. Python substitutes a default
    // (`_mcp.py`: `mime = item.resource.mimeType or "application/octet-stream"`), which is used
    // for both the data URI and the content's media type; without it the URI degenerates to
    // `data:;base64,...`.
    expect(
      fromMcpContent({ type: 'resource', resource: { uri: 'file:///a.bin', blob: 'CCCC' } }),
    ).toMatchObject({
      type: 'data',
      uri: 'data:application/octet-stream;base64,CCCC',
      mediaType: 'application/octet-stream',
    });
  });

  it('keeps the mimeType default scoped to blob resources, as Python does', () => {
    // Python only defaults in the `BlobResourceContents` branch: `ImageContent.mimeType` and
    // `AudioContent.mimeType` are required by the MCP schema and are passed straight to
    // `Content.from_data`, and `ResourceLink.mimeType` is forwarded as `None`. Guarding more than
    // the reference implementation would make this client the more permissive one.
    expect(fromMcpContent({ type: 'image', data: 'AAAA' })).toMatchObject({
      uri: 'data:;base64,AAAA',
      mediaType: '',
    });
    expect(fromMcpContent({ type: 'resource_link', uri: 'file:///a.txt' })).toEqual({
      type: 'uri',
      uri: 'file:///a.txt',
      rawRepresentation: { type: 'resource_link', uri: 'file:///a.txt' },
    });
  });

  it('keeps a block from a newer protocol revision as unknown content', () => {
    const content = fromMcpContent({ type: 'future_block', payload: 1 });
    expect(content).toMatchObject({ type: 'unknown', unknownType: 'future_block', payload: 1 });
  });

  it('produces unknown content that core can serialize back to the wire block', () => {
    // `rawRepresentation` is dropped by session persistence, so the *shape* is
    // what has to round-trip. Nesting the rest under `data` made `serializeContent` emit
    // `{type:'future_block', data:{payload:1}}` — a block the server never sent.
    const wire = { type: 'future_block', payload: 1 };
    const content = fromMcpContent(wire);

    expect(serializeContent(content)).toEqual(wire);
  });

  it('keeps an embedded resource this version cannot read flat, like every other unknown block', () => {
    // An embedded resource with neither `text` nor `blob` — what a newer protocol revision's
    // resource contents look like — must take the same `unknownBlock()` path as every other
    // unmodelled block, not get nested under `data`.
    // `rawRepresentation` is dropped by session persistence, so the serialized
    // *shape* is the only thing that survives, and nesting emits a block the server never sent.
    const wire = {
      type: 'resource',
      resource: {
        uri: 'file:///a.future',
        nested: { depth: { deeper: 'value' } },
        list: [1, 'two', null, { inner: true }],
        empty: null,
        providerId: 'srv_01HXYZ',
      },
      providerId: 'blk_01HABC',
    };

    const content = fromMcpContent(wire);

    expect(content).toMatchObject({ type: 'unknown', unknownType: 'resource' });
    expect(serializeContent(content)).toEqual(wire);
  });

  it('does not invent a wire type for a block whose type was not a string', () => {
    // Matches core's own sentinel for an unreadable type, so the value means the same thing on
    // both sides of a round trip.
    const content = fromMcpContent({ type: 42, payload: 1 } as never);
    expect(content).toMatchObject({ type: 'unknown', unknownType: '' });
  });
});

describe('through the agent', () => {
  it('runs a full tool round against the server', async () => {
    const transport = server();
    const mcp = new MCPClient({ transport });
    const tools = await mcp.getTools();
    const client = new MockChatClient([
      { contents: [{ type: 'function_call', callId: 'call_1', name: 'echo', arguments: { value: 'hi' } }] },
      { contents: [textContent('The echo said echo:hi.')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client, tools });

    const response = await agent.run('echo hi');

    expect(response.text).toBe('The echo said echo:hi.');
    expect(transport.calls).toEqual([{ name: 'echo', arguments: { value: 'hi' } }]);
    const results = response.messages
      .flatMap((msg) => msg.contents)
      .filter(
        (content): content is Extract<Content, { type: 'function_result' }> =>
          content.type === 'function_result',
      );
    expect(results[0]?.result).toEqual([expect.objectContaining({ type: 'text', text: 'echo:hi' })]);
    await mcp.close();
  });

  it('reports a failing MCP tool to the model instead of failing the run', async () => {
    const mcp = new MCPClient({ transport: server() });
    const tools = await mcp.getTools();
    const client = new MockChatClient([
      { contents: [{ type: 'function_call', callId: 'call_1', name: 'explode', arguments: {} }] },
      { contents: [textContent('That tool is broken.')], finishReason: 'stop' },
    ]);
    const agent = new Agent({ client, tools });

    const response = await agent.run('break something');

    expect(response.text).toBe('That tool is broken.');
    const results = response.messages
      .flatMap((msg) => msg.contents)
      .filter((content) => content.type === 'function_result');
    expect(results[0]).toMatchObject({ exception: expect.stringContaining('the tool is broken') });
    await mcp.close();
  });
});

describe('telemetry', () => {
  it('records an MCP client span per call, per the OTel MCP conventions', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    try {
      const mcp = new MCPClient({ transport: server() });
      const [echo] = await mcp.getTools();
      await echo?.execute?.({ value: 'hi' }, { callId: 'call_1' });
      const tools = await mcp.getTools();
      await Promise.resolve(
        tools.find((t) => t.name === 'explode')?.execute?.({}, { callId: 'call_2' }),
      ).catch(() => {});
      await mcp.close();

      const spans = exporter.getFinishedSpans();
      expect(spans.map((s) => s.name)).toEqual([
        'initialize',
        'tools/list',
        'tools/call echo',
        'tools/list',
        'tools/call explode',
      ]);
      const call = spans.find((s) => s.name === 'tools/call echo');
      expect(call?.kind).toBe(SpanKind.CLIENT);
      expect(call?.attributes['mcp.method.name']).toBe('tools/call');
      expect(call?.attributes['gen_ai.tool.name']).toBe('echo');
      expect(call?.attributes['gen_ai.tool.type']).toBe('mcp');
      // A tool that reports isError is a `tool_error`, not an exception.
      const failed = spans.find((s) => s.name === 'tools/call explode');
      expect(failed?.attributes['error.type']).toBe('tool_error');
    } finally {
      await provider.shutdown();
    }
  });
});
