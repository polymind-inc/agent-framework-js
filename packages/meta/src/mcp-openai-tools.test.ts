/**
 * Cross-package check: what `McpClient` exposes is what the OpenAI request conversion accepts.
 *
 * The MCP and OpenAI packages never depend on each other, so this lives in the umbrella package,
 * the one that depends on both. `packages/mcp` covers separately that a real `tools/list` over the
 * MCP SDK yields exactly the declaration asserted here; this test carries that declaration the
 * rest of the way, into the Responses request body a provider would receive.
 */
import { textContent } from '@polymind-inc/agent-framework-core';
import { McpClient, McpConnection } from '@polymind-inc/agent-framework-mcp';
import { OpenAIChatClient } from '@polymind-inc/agent-framework-openai';
import { describe, expect, it, vi } from 'vitest';

/** A Responses tool declaration, as far as these assertions read it. */
interface ToolDeclaration {
  type?: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

type ListToolsResult = Awaited<ReturnType<McpConnection['listTools']>>;

describe('MCP tools through the OpenAI request conversion', () => {
  it('declares a zero-argument MCP tool in the shape the Responses API accepts', async () => {
    // What a zero-argument tool looks like as MCP declares it: `properties` omitted, and a name
    // no provider accepts as a function name. Either one passed through is a 400.
    const listTools = vi.spyOn(McpConnection.prototype, 'listTools').mockResolvedValue({
      tools: [{ name: 'search docs!', description: 'Search the docs', inputSchema: { type: 'object' } }],
    } as unknown as ListToolsResult);
    const mcp = new McpClient({ url: 'https://mcp.example.com/mcp' });
    try {
      const tools = await mcp.getTools();
      const client = new OpenAIChatClient({ apiKey: 'test-key', model: 'gpt-4o' });

      const request = client.buildRequest([{ role: 'user', contents: [textContent('hi')] }], { tools });

      const declared = (request.tools as ToolDeclaration[]).find((entry) => entry.type === 'function');
      expect(declared?.name).toBe('search-docs-');
      // `{ "type": "object" }` on its own is what the API rejects; the empty map is what makes the
      // zero-argument declaration legal.
      expect(declared?.parameters).toEqual({
        type: 'object',
        properties: {},
        additionalProperties: false,
      });
    } finally {
      await mcp.close();
      listTools.mockRestore();
    }
  });
});
