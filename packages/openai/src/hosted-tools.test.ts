import type {
  Content,
  FunctionApprovalRequestContent,
  HostedToolCallContent,
  HostedToolResultContent,
  Message,
  TextContent,
} from '@polymind-inc/agent-framework-core';
import {
  supportsCodeInterpreter,
  supportsFileSearch,
  supportsMCP,
  supportsWebSearch,
  textContent,
} from '@polymind-inc/agent-framework-core';
import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { OpenAIChatClient } from './chat-client.js';
import { parseResponse } from './from-openai.js';
import { toResponsesInput, toResponsesTools } from './to-openai.js';

function client(): OpenAIChatClient {
  const fake = { responses: { create: vi.fn() }, baseURL: 'https://api.openai.com/v1' };
  return new OpenAIChatClient({ client: fake as unknown as OpenAI, model: 'gpt-4o' });
}

/** All contents of a parsed response, flattened. */
function contentsOf(response: { messages: Message[] }): Content[] {
  return response.messages.flatMap((msg) => msg.contents);
}

/** Narrows away undefined; a missing value fails the test with a clear error. */
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value');
  return value;
}

describe('hosted tool capability protocol', () => {
  it('advertises every hosted tool the Responses API offers', () => {
    const c = client();
    expect(supportsWebSearch(c)).toBe(true);
    expect(supportsFileSearch(c)).toBe(true);
    expect(supportsCodeInterpreter(c)).toBe(true);
    expect(supportsMCP(c)).toBe(true);
  });

  it('does not claim capabilities for a client that has none', () => {
    const bare = { metadata: { providerName: 'x' }, getResponse: () => undefined as never };
    expect(supportsWebSearch(bare)).toBe(false);
    expect(supportsMCP(bare)).toBe(false);
  });

  it('maps hosted declarations onto the wire verbatim', () => {
    const c = client();
    const tools = [
      c.getWebSearchTool({ searchContextSize: 'high', userLocation: { country: 'JP' } }),
      c.getFileSearchTool({ vectorStoreIds: ['vs_1'], maxNumResults: 5 }),
      c.getCodeInterpreterTool({ fileIds: ['file_1'] }),
      c.getMCPTool({ serverLabel: 'docs', serverUrl: 'https://mcp.example/sse', requireApproval: 'never' }),
    ];

    expect(toResponsesTools(tools)).toEqual([
      {
        type: 'web_search',
        user_location: { type: 'approximate', country: 'JP' },
        search_context_size: 'high',
      },
      { type: 'file_search', vector_store_ids: ['vs_1'], max_num_results: 5 },
      { type: 'code_interpreter', container: { type: 'auto', file_ids: ['file_1'] } },
      {
        type: 'mcp',
        server_label: 'docs',
        server_url: 'https://mcp.example/sse',
        require_approval: 'never',
      },
    ]);
  });

  it('refuses a file search with no vector store, which the API would reject', () => {
    expect(() => client().getFileSearchTool()).toThrow(/at least one vectorStoreId/);
  });

  it('maps the MCP approval object form onto per-side tool_names filters', () => {
    // The API's object form is `{always: {tool_names}, never: {tool_names}}` (SDK
    // `Mcp.McpToolApprovalFilter`); bare arrays are rejected. Labels with spaces are
    // normalised the way Python's `get_mcp_tool` does.
    const tool = client().getMCPTool({
      serverLabel: 'my docs',
      serverUrl: 'https://mcp.example/sse',
      requireApproval: { always: ['dangerous_tool'], never: ['safe_tool'] },
    });

    expect(tool.spec).toEqual({
      type: 'mcp',
      server_label: 'my_docs',
      server_url: 'https://mcp.example/sse',
      require_approval: {
        always: { tool_names: ['dangerous_tool'] },
        never: { tool_names: ['safe_tool'] },
      },
    });
  });

  it('keeps a one-sided MCP approval filter one-sided', () => {
    const tool = client().getMCPTool({
      serverLabel: 'docs',
      serverUrl: 'https://mcp.example/sse',
      requireApproval: { always: ['dangerous_tool'] },
    });
    expect(tool.spec.require_approval).toEqual({
      always: { tool_names: ['dangerous_tool'] },
    });
  });
});

describe('hosted tool output mapping', () => {
  it('reports a web search as a call and its result', () => {
    const response = parseResponse({
      id: 'resp_1',
      status: 'completed',
      output: [
        { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'ts' } },
      ],
    });

    expect(contentsOf(response)).toEqual([
      expect.objectContaining({
        type: 'search_tool_call',
        callId: 'ws_1',
        toolName: 'web_search',
        arguments: { type: 'search', query: 'ts' },
      }),
      expect.objectContaining({
        type: 'search_tool_result',
        callId: 'ws_1',
        toolName: 'web_search',
        result: { action: { type: 'search', query: 'ts' } },
      }),
    ]);
  });

  it('reports a file search with its queries and results', () => {
    const response = parseResponse({
      id: 'resp_1',
      status: 'completed',
      output: [{ type: 'file_search_call', id: 'fs_1', queries: ['budget'], results: [{ file_id: 'f1' }] }],
    });
    const [call, result] = contentsOf(response) as [HostedToolCallContent, HostedToolResultContent];

    expect(call.toolName).toBe('file_search');
    expect(call.arguments).toEqual({ queries: ['budget'] });
    expect(result.result).toEqual({ results: [{ file_id: 'f1' }] });
  });

  it('splits a code interpreter item into the code it ran and what it produced', () => {
    const response = parseResponse({
      id: 'resp_1',
      status: 'completed',
      output: [
        {
          type: 'code_interpreter_call',
          id: 'ci_1',
          code: 'print(1)',
          outputs: [
            { type: 'logs', logs: '1\n' },
            { type: 'image', url: 'https://example/img.png' },
          ],
        },
      ],
    });
    const [call, result] = contentsOf(response) as [HostedToolCallContent, HostedToolResultContent];

    expect(call.type).toBe('code_interpreter_tool_call');
    expect((must(call.inputs?.[0]) as TextContent).text).toBe('print(1)');
    expect(result.type).toBe('code_interpreter_tool_result');
    expect(result.outputs?.map((o) => o.type)).toEqual(['text', 'uri']);
  });

  it('reports an MCP call with its output', () => {
    const response = parseResponse({
      id: 'resp_1',
      status: 'completed',
      output: [
        {
          type: 'mcp_call',
          id: 'mcp_1',
          server_label: 'docs',
          name: 'search',
          arguments: '{"q":"x"}',
          output: 'found it',
        },
      ],
    });
    const [call, result] = contentsOf(response) as [HostedToolCallContent, HostedToolResultContent];

    expect(call).toMatchObject({
      type: 'mcp_server_tool_call',
      callId: 'mcp_1',
      serverName: 'docs',
      toolName: 'search',
      arguments: '{"q":"x"}',
    });
    expect(result.type).toBe('mcp_server_tool_result');
    // Python parity: the payload lives in `output` as a content list.
    expect((result.output as TextContent[])[0]?.text).toBe('found it');
  });

  it('surfaces a hosted MCP approval as an approval request tagged with its server', () => {
    const response = parseResponse({
      id: 'resp_1',
      status: 'completed',
      output: [
        {
          type: 'mcp_approval_request',
          id: 'mcpr_1',
          server_label: 'docs',
          name: 'delete',
          arguments: '{}',
        },
      ],
    });
    const [approval] = contentsOf(response) as [FunctionApprovalRequestContent];

    expect(approval.type).toBe('function_approval_request');
    expect(approval.id).toBe('mcpr_1');
    expect(approval.functionCall.additionalProperties?.server_label).toBe('docs');
  });

  it('turns a generated image into inline data', () => {
    const response = parseResponse({
      id: 'resp_1',
      status: 'completed',
      output: [{ type: 'image_generation_call', id: 'img_1', result: 'QUJD' }],
    });
    const [, result] = contentsOf(response) as [Content, HostedToolResultContent];

    // Unrecognised bytes fall back to png (Python `detect_media_type_from_base64(...) or "image/png"`).
    expect(result.outputs?.[0]).toMatchObject({ type: 'data', uri: 'data:image/png;base64,QUJD' });
  });

  it('detects the media type of a generated image from its magic bytes', () => {
    // '/9j/…' decodes to ff d8 ff — a JPEG signature; labelling it png would corrupt consumers.
    const response = parseResponse({
      id: 'resp_1',
      status: 'completed',
      output: [{ type: 'image_generation_call', id: 'img_1', result: '/9j/4AAQSkZJRg==' }],
    });
    const [, result] = contentsOf(response) as [Content, HostedToolResultContent];

    expect(result.outputs?.[0]).toMatchObject({
      type: 'data',
      mediaType: 'image/jpeg',
      uri: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    });
  });
});

describe('hosted tool input mapping', () => {
  it('replays an approval round trip as the API models it', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        contents: [
          {
            type: 'function_approval_request',
            id: 'mcpr_1',
            functionCall: {
              type: 'function_call',
              callId: 'mcpr_1',
              name: 'delete',
              arguments: '{}',
              additionalProperties: { server_label: 'docs' },
            },
          },
        ],
      },
      {
        role: 'user',
        contents: [
          {
            type: 'function_approval_response',
            id: 'mcpr_1',
            approved: true,
            // `approvalResponse()` copies the request's call verbatim, so a hosted decision
            // carries the `server_label` that marks it as the provider's to settle.
            functionCall: {
              type: 'function_call',
              callId: 'mcpr_1',
              name: 'delete',
              arguments: '{}',
              additionalProperties: { server_label: 'docs' },
            },
          },
        ],
      },
    ];

    expect(toResponsesInput(messages)).toEqual([
      {
        type: 'mcp_approval_request',
        id: 'mcpr_1',
        name: 'delete',
        arguments: '{}',
        server_label: 'docs',
      },
      { type: 'mcp_approval_response', approval_request_id: 'mcpr_1', approve: true },
    ]);
  });

  it('folds an MCP result onto its call, since the API carries both on one item', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        contents: [
          {
            type: 'mcp_server_tool_call',
            callId: 'mcp_1',
            serverName: 'docs',
            toolName: 'search',
            arguments: '{"q":"x"}',
          },
          { type: 'mcp_server_tool_result', callId: 'mcp_1', output: [textContent('found it')] },
        ],
      },
    ];

    expect(toResponsesInput(messages)).toEqual([
      {
        type: 'mcp_call',
        id: 'mcp_1',
        server_label: 'docs',
        name: 'search',
        arguments: '{"q":"x"}',
        output: 'found it',
      },
    ]);
  });

  it('drops an MCP result with no call, which would be an orphan on the wire', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        contents: [{ type: 'mcp_server_tool_result', callId: 'mcp_missing', output: [textContent('x')] }],
      },
    ];

    expect(toResponsesInput(messages)).toEqual([]);
  });

  it('keeps a hosted file as message content but not as assistant output', () => {
    const asInput = toResponsesInput([
      { role: 'user', contents: [{ type: 'hosted_file', fileId: 'file_1' }] },
    ]);
    const asOutput = toResponsesInput([
      { role: 'assistant', contents: [{ type: 'hosted_file', fileId: 'file_1' }] },
    ]);

    // `input_file` is a message content part, not a top-level input item — the ResponseInputItem
    // union has no `input_file` member, so a bare item is a 400 (Python nests it the same way).
    expect(asInput).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_file', file_id: 'file_1' }] },
    ]);
    // On an assistant turn this is a citation, which has no input representation.
    expect(asOutput).toEqual([]);
  });
});
