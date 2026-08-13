/**
 * Integration tests against a real MCP server.
 *
 * Skipped unless `MCP_SERVER_URL` is set, so `pnpm -r test` stays offline by default. The public
 * Microsoft Learn MCP server needs no credentials and is a good default:
 *
 * ```
 * MCP_SERVER_URL=https://learn.microsoft.com/api/mcp pnpm --filter @polymind-inc/agent-framework-mcp test
 * ```
 *
 * - `MCP_SERVER_URL` — the server's Streamable HTTP endpoint
 * - `MCP_AUTH_TOKEN` — optional bearer token for a server that needs one
 * - `MCP_TOOL_NAME` / `MCP_TOOL_ARGS` — optional; call one specific tool with a JSON argument
 *   object instead of letting the test pick the first one it can call with no arguments
 */
import { SpanKind, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { McpClient } from './client.js';

const url = process.env.MCP_SERVER_URL;
const authToken = process.env.MCP_AUTH_TOKEN;
const toolName = process.env.MCP_TOOL_NAME ?? 'microsoft_docs_search';
const toolArgs = process.env.MCP_TOOL_ARGS ?? '{"query":"Azure AI Foundry agent"}';
const TIMEOUT = 60_000;

/** Narrows away undefined; a missing value fails the test with a clear error. */
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value');
  return value;
}

function connect(): McpClient {
  return new McpClient({
    url: must(url),
    ...(authToken === undefined ? {} : { headers: { authorization: `Bearer ${authToken}` } }),
  });
}

describe.runIf(url !== undefined && url !== '')('MCP client (integration)', () => {
  it('enumerates a real server’s tools as framework tools', { timeout: TIMEOUT }, async () => {
    const mcp = connect();
    try {
      expect(mcp.connected).toBe(false);
      const tools = await mcp.getTools();
      expect(mcp.connected).toBe(true);

      expect(tools.length).toBeGreaterThan(0);
      for (const declared of tools) {
        expect(declared.kind).toBe('function');
        expect(declared.name).not.toBe('');
        // The server's own JSON Schema is the contract; the framework does not re-derive it.
        expect(declared.jsonSchema).toBeDefined();
        // A server may omit a tool's description, which stays empty (Python parity) — so only
        // the shape is asserted here.
        expect(typeof declared.description).toBe('string');
      }
      console.log('[mcp] tools:', tools.map((entry) => entry.name).join(', '));
    } finally {
      await mcp.close();
    }
  });

  it('calls a real tool and converts its content', { timeout: TIMEOUT }, async () => {
    const mcp = connect();
    try {
      const tools = await mcp.getTools();
      const target = tools.find((entry) => entry.name === toolName) ?? tools[0];
      expect(target).toBeDefined();

      const result = await target?.execute?.(JSON.parse(toolArgs), { callId: 'call_1' });

      // MCP content becomes framework content, so a tool result drops straight into a transcript.
      expect(Array.isArray(result)).toBe(true);
      const contents = result as Array<{ type: string }>;
      expect(contents.length).toBeGreaterThan(0);
      for (const content of contents) {
        expect(typeof content.type).toBe('string');
      }
      console.log(`[mcp] ${target?.name} returned ${contents.length} content item(s):`, [
        ...new Set(contents.map((content) => content.type)),
      ]);
    } finally {
      await mcp.close();
    }
  });

  it('fails clearly when the endpoint is not an MCP server', { timeout: TIMEOUT }, async () => {
    // A reachable host that speaks HTTP but not MCP — a copied-and-pasted URL, a proxy in front of
    // the wrong route. The connection must fail rather than hang, and it must fail on the first
    // `getTools()` rather than at construction, since the client is deliberately lazy.
    const origin = new URL(must(url)).origin;
    const mcp = new McpClient({ url: origin });

    expect(mcp.connected).toBe(false);
    await expect(mcp.getTools()).rejects.toBeInstanceOf(Error);
    expect(mcp.connected).toBe(false);

    // A failed attempt is not cached as a rejection: the next call tries again.
    await expect(mcp.getTools()).rejects.toBeInstanceOf(Error);
    await mcp.close();
  });

  it('traces the call as an MCP client span', { timeout: TIMEOUT }, async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    const mcp = connect();
    try {
      const tools = await mcp.getTools();
      const target = tools.find((entry) => entry.name === toolName) ?? tools[0];
      await target?.execute?.(JSON.parse(toolArgs), { callId: 'call_1' });

      const spans = exporter.getFinishedSpans();
      const names = spans.map((span) => span.name);
      expect(names).toContain('initialize');
      expect(names).toContain('tools/list');
      const call = spans.find((span) => span.name.startsWith('tools/call'));
      expect(call?.kind).toBe(SpanKind.CLIENT);
      expect(call?.attributes['mcp.method.name']).toBe('tools/call');
      expect(call?.attributes['gen_ai.tool.type']).toBe('mcp');
      expect(call?.attributes['server.address']).toBe(new URL(must(url)).hostname);
    } finally {
      await mcp.close();
      await provider.shutdown();
      trace.disable();
    }
  });
});
