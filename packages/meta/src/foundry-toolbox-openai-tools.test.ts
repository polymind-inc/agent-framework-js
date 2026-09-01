/**
 * Cross-package check: what `FoundryToolbox` exposes is what the OpenAI request conversion accepts.
 *
 * The foundry and openai packages never validate each other's shapes, so this lives in the
 * umbrella package, the one that depends on both. The toolbox shares the MCP package's
 * declaration rules; this test carries a declaration the rest of the way, into the Responses
 * request body a provider would receive — the same journey `mcp-openai-tools.test.ts` covers for
 * `McpClient`, pinned separately so the two loaders cannot drift apart.
 */
import { textContent } from '@polymind-inc/agent-framework-core';
import { FoundryProject } from '@polymind-inc/agent-framework-foundry';
import { FoundryToolbox } from '@polymind-inc/agent-framework-foundry/hosting';
import { McpConnection } from '@polymind-inc/agent-framework-mcp';
import { OpenAIChatClient } from '@polymind-inc/agent-framework-openai';
import { describe, expect, it, vi } from 'vitest';

/** A Responses tool declaration, as far as these assertions read it. */
interface ToolDeclaration {
  type?: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

type ListToolsResult = Awaited<ReturnType<McpConnection['listTools']>>;

// Structurally a TokenCredential; the meta package does not depend on @azure/identity itself.
const credential = {
  async getToken(): Promise<{ token: string; expiresOnTimestamp: number }> {
    return { token: 'test-token', expiresOnTimestamp: Date.now() + 3_600_000 };
  },
};

describe('Foundry toolbox tools through the OpenAI request conversion', () => {
  it('declares a zero-argument toolbox tool in the shape the Responses API accepts', async () => {
    // What a zero-argument tool looks like as MCP declares it: `properties` omitted, and a name
    // no provider accepts as a function name. Either one passed through is a 400.
    const listTools = vi.spyOn(McpConnection.prototype, 'listTools').mockResolvedValue({
      tools: [{ name: 'search docs!', description: 'Search the docs', inputSchema: { type: 'object' } }],
    } as unknown as ListToolsResult);
    // Constructed inside the try: a construction failure must still restore the prototype spy.
    let toolbox: FoundryToolbox | undefined;
    try {
      toolbox = new FoundryToolbox({
        name: 'my-toolbox',
        project: new FoundryProject(
          'https://my-resource.services.ai.azure.com/api/projects/my-project',
          credential,
        ),
      });
      const tools = await toolbox.getTools();
      const client = new OpenAIChatClient({ apiKey: 'test-key', model: 'gpt-4o' });

      const request = client.buildRequest([{ role: 'user', contents: [textContent('hi')] }], { tools });

      const declared = (request.tools as ToolDeclaration[]).find((entry) => entry.type === 'function');
      expect(declared?.name).toBe('search-docs-');
      expect(declared?.parameters).toEqual({
        type: 'object',
        properties: {},
        additionalProperties: false,
      });
    } finally {
      await toolbox?.close();
      listTools.mockRestore();
    }
  });
});
