import type { Message, Tool } from '@polymind-inc/agent-framework-core';
import { ChatClientError } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import {
  toResponsesInput,
  toResponsesTextFormat,
  toResponsesToolChoice,
  toResponsesTools,
} from './to-openai.js';

// The request-side conversion has to render transcript shapes the happy path never produces —
// results without values, MCP outputs in every payload form, annotations rebuilt after
// persistence — and each has a defined wire form. These tests pin them down.

describe('function result rendering', () => {
  function outputOf(result: unknown): unknown {
    const items = toResponsesInput([
      { role: 'tool', contents: [{ type: 'function_result', callId: 'c1', result }] },
    ]);
    return items[0]?.output;
  }

  it('renders an absent result as an empty string', () => {
    expect(outputOf(undefined)).toBe('');
    expect(outputOf(null)).toBe('');
  });

  it('renders a structured result as its JSON', () => {
    expect(outputOf({ ok: true })).toBe('{"ok":true}');
  });

  it('renders a result as its string form when JSON.stringify throws', () => {
    // A caller-built transcript can carry a result the tool loop never normalized. `JSON.stringify`
    // throws on a cycle and on a BigInt; failing the whole request over one such result is worse
    // than the degraded string rendering (Python's `Content.from_function_result` falls back to
    // `str(result)` the same way).
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(outputOf(circular)).toBe('[object Object]');
    expect(outputOf(10n)).toBe('10');
  });

  it('uses a stable placeholder when neither JSON nor string conversion is possible', () => {
    const unrenderable = Object.create(null) as Record<string, unknown>;
    unrenderable.self = unrenderable;

    expect(outputOf(unrenderable)).toBe('[unserializable]');
  });

  it('renders a result as its string form when JSON.stringify returns undefined', () => {
    // `JSON.stringify` returns `undefined` for a symbol or a function; passing that through put a
    // non-string into the wire's string field.
    expect(outputOf(Symbol('opaque'))).toBe('Symbol(opaque)');
  });

  it('falls back to the string result when rich items carry nothing sendable', () => {
    // The rich-output gate needs a data/uri item, but conversion can still drop it (here: an
    // unsupported audio codec); the string result is what remains.
    const items = toResponsesInput([
      {
        role: 'tool',
        contents: [
          {
            type: 'function_result',
            callId: 'c1',
            result: 'plain answer',
            items: [{ type: 'uri', uri: 'https://a.example/x.ogg', mediaType: 'audio/ogg' }],
          },
        ],
      },
    ]);
    expect(items[0]?.output).toBe('plain answer');
  });

  it('keeps the string form when the rich items are text only', () => {
    const items = toResponsesInput([
      {
        role: 'tool',
        contents: [
          {
            type: 'function_result',
            callId: 'c1',
            result: 'summary',
            items: [{ type: 'text', text: 'summary' }],
          },
        ],
      },
    ]);
    expect(items[0]?.output).toBe('summary');
  });
});

describe('MCP call replay', () => {
  function mcpItems(output: unknown): Record<string, unknown>[] {
    return toResponsesInput([
      {
        role: 'assistant',
        contents: [
          { type: 'mcp_server_tool_call', callId: 'mcp_1', toolName: 't', serverName: 's', arguments: '{}' },
          { type: 'mcp_server_tool_result', callId: 'mcp_1', output },
        ],
      },
    ]);
  }

  it('folds a missing result payload onto the call as an empty string', () => {
    expect(mcpItems(undefined)).toEqual([expect.objectContaining({ type: 'mcp_call', output: '' })]);
  });

  it('concatenates text-bearing entries and JSON-encodes the rest', () => {
    const output = [{ type: 'text', text: 'a' }, 'b', { k: 1 }];
    expect(mcpItems(output)[0]?.output).toBe('ab{"k":1}');
  });

  it('JSON-encodes a structured result payload', () => {
    expect(mcpItems({ k: 1 })[0]?.output).toBe('{"k":1}');
  });

  it('renders a result payload JSON.stringify cannot represent as an empty string', () => {
    // JSON.stringify returns undefined for a symbol; the wire field is a string, so the
    // unrepresentable payload degrades to empty rather than leaking undefined into the item.
    expect(mcpItems(Symbol('opaque'))[0]?.output).toBe('');
  });

  it('drops a call without an id and its fallbacks default the rest', () => {
    const items = toResponsesInput([
      {
        role: 'assistant',
        contents: [{ type: 'mcp_server_tool_call' }, { type: 'mcp_server_tool_call', callId: 'mcp_2' }],
      },
    ]);
    expect(items).toEqual([{ type: 'mcp_call', id: 'mcp_2', server_label: '', name: '', arguments: '' }]);
  });

  it('drops an orphan MCP result rather than sending the shape the API rejects', () => {
    const items = toResponsesInput([
      { role: 'assistant', contents: [{ type: 'mcp_server_tool_result', callId: 'mcp_gone', output: 'x' }] },
    ]);
    expect(items).toEqual([]);
  });
});

describe('annotation reconstruction after persistence', () => {
  function wireAnnotations(annotations: NonNullable<Message['contents'][number]['annotations']>): unknown {
    const items = toResponsesInput([
      { role: 'assistant', contents: [{ type: 'text', text: 'cited', annotations }] },
    ]);
    const message = items[0] as { content: Array<{ annotations: unknown }> };
    return message.content[0]?.annotations;
  }

  it('rebuilds a file-id-only citation as file_path, keeping a stored index', () => {
    expect(
      wireAnnotations([{ type: 'citation', fileId: 'file_1', additionalProperties: { index: 3 } }]),
    ).toEqual([{ type: 'file_path', file_id: 'file_1', index: 3 }]);
  });

  it('omits the index of a file_path citation that never had one', () => {
    expect(wireAnnotations([{ type: 'citation', fileId: 'file_1' }])).toEqual([
      { type: 'file_path', file_id: 'file_1' },
    ]);
  });

  it('defaults a url citation title to an empty string', () => {
    expect(
      wireAnnotations([
        {
          type: 'citation',
          url: 'https://a.example',
          annotatedRegions: [{ type: 'text_span', startIndex: 0, endIndex: 5 }],
        },
      ]),
    ).toEqual([{ type: 'url_citation', url: 'https://a.example', title: '', start_index: 0, end_index: 5 }]);
  });

  it('drops annotation kinds that have no wire reconstruction', () => {
    expect(wireAnnotations([{ type: 'mystery' }])).toEqual([]);
  });
});

describe('media input forms', () => {
  function partsOf(contents: Message['contents']): unknown[] {
    const items = toResponsesInput([{ role: 'user', contents }]);
    return items.length === 0 ? [] : (items[0] as { content: unknown[] }).content;
  }

  it('sends wav and mp3 audio as input_audio and drops other codecs', () => {
    expect(
      partsOf([
        { type: 'data', uri: 'data:audio/wav;base64,AA', mediaType: 'audio/wav' },
        { type: 'data', uri: 'data:audio/mp3;base64,BB', mediaType: 'audio/mp3' },
        { type: 'data', uri: 'data:audio/ogg;base64,CC', mediaType: 'audio/ogg' },
      ]),
    ).toEqual([
      { type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,AA', format: 'wav' } },
      { type: 'input_audio', input_audio: { data: 'data:audio/mp3;base64,BB', format: 'mp3' } },
    ]);
  });

  it('sends application data as input_file, carrying a name when there is one', () => {
    expect(
      partsOf([
        {
          type: 'data',
          uri: 'data:application/pdf;base64,AA',
          mediaType: 'application/pdf',
          name: 'doc.pdf',
        },
        { type: 'data', uri: 'data:application/pdf;base64,BB', mediaType: 'application/pdf' },
      ]),
    ).toEqual([
      { type: 'input_file', file_data: 'data:application/pdf;base64,AA', filename: 'doc.pdf' },
      { type: 'input_file', file_data: 'data:application/pdf;base64,BB' },
    ]);
  });

  it('drops media the API has no input form for, and the message when nothing is left', () => {
    expect(partsOf([{ type: 'uri', uri: 'https://a.example/notes.txt', mediaType: 'text/plain' }])).toEqual(
      [],
    );
  });
});

describe('reasoning replay fallbacks', () => {
  it('reads the opaque payload from additionalProperties when protectedData is empty', () => {
    const items = toResponsesInput([
      {
        role: 'assistant',
        contents: [
          {
            type: 'text_reasoning',
            id: 'rs_1',
            text: 'public summary',
            additionalProperties: { encrypted_content: 'enc', status: 'completed' },
          },
        ],
      },
    ]);
    expect(items).toEqual([
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'public summary' }],
        encrypted_content: 'enc',
        status: 'completed',
      },
    ]);
  });

  it('treats a non-string protectedData as absent rather than falling back', () => {
    // A corrupt opaque payload is not replayable; silently substituting the additionalProperties
    // copy would replay under a payload the provider never paired with this fragment.
    const items = toResponsesInput([
      {
        role: 'assistant',
        contents: [
          {
            type: 'text_reasoning',
            id: 'rs_1',
            text: 'summary',
            protectedData: 123 as unknown as string,
            additionalProperties: { encrypted_content: 'enc' },
          },
        ],
      },
    ]);
    expect(items).toEqual([]);
  });

  it('uses a string reasoning_text marker as the private text itself', () => {
    const items = toResponsesInput([
      {
        role: 'assistant',
        contents: [
          {
            type: 'text_reasoning',
            id: 'rs_1',
            text: '',
            protectedData: 'enc',
            additionalProperties: { reasoning_text: 'private thought' },
          },
        ],
      },
    ]);
    expect(items[0]?.content).toEqual([{ type: 'reasoning_text', text: 'private thought' }]);
  });
});

describe('stateless replay validation', () => {
  it('fails fast when a tool call is bound to reasoning that cannot be replayed', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        contents: [
          { type: 'text_reasoning', id: 'rs_1', text: 'thought' },
          { type: 'function_call', callId: 'c1', name: 'f', arguments: '{}' },
        ],
      },
      { role: 'tool', contents: [{ type: 'function_result', callId: 'c1', result: 'ok' }] },
    ];
    expect(() => toResponsesInput(messages)).toThrow(ChatClientError);
    expect(() => toResponsesInput(messages)).toThrow(/rs_1/);
  });

  it('fails fast when a compacted group declares reasoning it no longer carries', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        contents: [{ type: 'function_call', callId: 'c1', name: 'f', arguments: '{}' }],
        additionalProperties: { _group: { id: 'g1', has_reasoning: true } },
      },
      { role: 'tool', contents: [{ type: 'function_result', callId: 'c1', result: 'ok' }] },
    ];
    expect(() => toResponsesInput(messages)).toThrow(/compacted group g1/);
  });

  it('skips the validation entirely under service storage', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        contents: [
          { type: 'text_reasoning', id: 'rs_1', text: 'thought' },
          { type: 'function_call', callId: 'c1', name: 'f', arguments: '{}' },
        ],
      },
      { role: 'tool', contents: [{ type: 'function_result', callId: 'c1', result: 'ok' }] },
    ];
    // The service already holds the reasoning item; only the result goes back.
    expect(toResponsesInput(messages, { serviceStorage: true })).toEqual([
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ]);
  });
});

describe('approval serialization boundaries', () => {
  const localCall = {
    type: 'function_call',
    callId: 'local_1',
    name: 'ask_user',
    arguments: '{}',
  } as const;
  const localApprovalMessages: Message[] = [
    {
      role: 'assistant',
      contents: [{ type: 'function_approval_request', id: 'local_approval_1', functionCall: localCall }],
    },
    {
      role: 'user',
      contents: [
        {
          type: 'function_approval_response',
          id: 'local_approval_1',
          approved: true,
          functionCall: localCall,
        },
      ],
    },
  ];

  it.each([
    ['stateless', false],
    ['storage', true],
  ])('drops local approval controls from the input (%s)', (_mode, serviceStorage) => {
    // A local tool's approval is resolved in-process; the provider never issued a matching
    // MCP approval request, so serializing either half would create an orphaned item.
    expect(toResponsesInput(localApprovalMessages, { serviceStorage })).toEqual([]);
  });

  it('keeps a hosted approval pair on the wire', () => {
    const hostedCall = {
      type: 'function_call',
      callId: 'mcpr_1',
      name: 'sensitive_action',
      arguments: '{}',
      additionalProperties: { server_label: 'hosted_server' },
    } as const;
    const items = toResponsesInput([
      {
        role: 'assistant',
        contents: [{ type: 'function_approval_request', id: 'mcpr_1', functionCall: hostedCall }],
      },
      {
        role: 'user',
        contents: [
          { type: 'function_approval_response', id: 'mcpr_1', approved: true, functionCall: hostedCall },
        ],
      },
    ]);
    expect(items.map((item) => item.type)).toEqual(['mcp_approval_request', 'mcp_approval_response']);
  });
});

describe('tool declarations and choices', () => {
  it('passes a non-function tool without a spec through as itself', () => {
    const opaque = { type: 'web_search' } as unknown as Tool;
    expect(toResponsesTools([opaque])).toEqual([{ type: 'web_search' }]);
  });

  it('maps each tool-choice form onto its wire value', () => {
    expect(toResponsesToolChoice(undefined)).toBeUndefined();
    expect(toResponsesToolChoice('auto')).toBe('auto');
    expect(toResponsesToolChoice({ required: ['a'] })).toEqual({ type: 'function', name: 'a' });
    expect(toResponsesToolChoice({ required: ['a', 'b'] })).toEqual({
      type: 'allowed_tools',
      mode: 'required',
      tools: [
        { type: 'function', name: 'a' },
        { type: 'function', name: 'b' },
      ],
    });
  });

  it('carries a response-format description onto the wire', () => {
    expect(
      toResponsesTextFormat({
        name: 'answer',
        description: 'the shape',
        schema: { type: 'object', properties: { a: { type: 'string' } } },
      }),
    ).toMatchObject({ type: 'json_schema', name: 'answer', description: 'the shape' });
  });
});
