import { supportsMcp, supportsWebSearch, textContent } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import { AnthropicChatClient } from './chat-client.js';
import { mcpTool, webSearchTool } from './hosted-tools.js';

function client(): AnthropicChatClient {
  const fake = { beta: { messages: { create: () => Promise.resolve({}) } } };
  return new AnthropicChatClient({ model: 'claude-sonnet-4-5', client: fake as never });
}

describe('web search tool declaration', () => {
  it('declares the versioned type and name, matching Python get_web_search_tool', () => {
    expect(webSearchTool().spec).toEqual({ type: 'web_search_20250305', name: 'web_search' });
  });

  it('maps userLocation onto user_location with the approximate type filled in', () => {
    expect(webSearchTool({ userLocation: { country: 'JP', city: 'Tokyo' } }).spec).toEqual({
      type: 'web_search_20250305',
      name: 'web_search',
      user_location: { type: 'approximate', country: 'JP', city: 'Tokyo' },
    });
  });

  it('drops searchContextSize, which has no Messages API equivalent', () => {
    expect(webSearchTool({ searchContextSize: 'high' }).spec).toEqual({
      type: 'web_search_20250305',
      name: 'web_search',
    });
  });

  it('reaches max_uses, allowed_domains and a type override through additionalProperties', () => {
    expect(
      webSearchTool({
        additionalProperties: {
          type: 'web_search_20260101',
          max_uses: 3,
          allowed_domains: ['example.com'],
        },
      }).spec,
    ).toEqual({
      type: 'web_search_20260101',
      name: 'web_search',
      max_uses: 3,
      allowed_domains: ['example.com'],
    });
  });
});

describe('hosted tool capability protocol', () => {
  it('advertises web search and MCP', () => {
    const c = client();
    expect(supportsWebSearch(c)).toBe(true);
    expect(supportsMcp(c)).toBe(true);
  });

  it('delegates getWebSearchTool to the factory', () => {
    const declared = client().getWebSearchTool({ userLocation: { country: 'JP' } });
    expect(declared).toEqual(webSearchTool({ userLocation: { country: 'JP' } }));
  });
});

describe('MCP tool declaration', () => {
  it('reads Authorization case-insensitively', () => {
    expect(
      mcpTool({
        serverLabel: 'docs',
        serverUrl: 'https://mcp.example',
        headers: { Authorization: 'Bearer secret' },
      }).spec,
    ).toMatchObject({ authorization_token: 'Bearer secret' });
  });
});

describe('web search tool on the wire', () => {
  it('carries the declaration into the request tools array', () => {
    const c = client();
    const request = c.buildRequest([{ role: 'user', contents: [textContent('hi')] }], {
      tools: [c.getWebSearchTool()],
    });
    expect(request.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }]);
    expect(request).not.toHaveProperty('mcp_servers');
  });
});
