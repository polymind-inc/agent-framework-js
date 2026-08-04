import type { Message, Tool } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import {
  toAnthropicMessages,
  toAnthropicOutputFormat,
  toAnthropicSystem,
  toAnthropicTools,
} from './to-anthropic.js';

// The Messages API conversion absorbs transcript shapes that fall outside the happy path — folded
// argument fragments, results carrying mixed content, blocks with no representation — and each has
// a defined mapping rather than a 400 from the API. These tests pin those mappings down.

/** Converts a single assistant message and returns the blocks of the first API message. */
function blocksOf(contents: Message['contents']): Record<string, unknown>[] {
  const [first] = toAnthropicMessages([{ role: 'assistant', contents }]);
  if (first === undefined || typeof first.content === 'string') throw new Error('expected blocks');
  return first.content;
}

describe('tool_use input parsing', () => {
  function inputOf(args: Record<string, unknown> | string): unknown {
    const [block] = blocksOf([{ type: 'function_call', callId: 'c1', name: 'f', arguments: args }]);
    return block?.input;
  }

  it('parses a JSON object string back to the object the API wants', () => {
    expect(inputOf('{"city":"Osaka"}')).toEqual({ city: 'Osaka' });
  });

  it('passes an already-structured argument object through', () => {
    expect(inputOf({ city: 'Osaka' })).toEqual({ city: 'Osaka' });
  });

  it('maps empty and blank argument strings to an empty object', () => {
    expect(inputOf('')).toEqual({});
    expect(inputOf('   ')).toEqual({});
  });

  it('maps a JSON scalar to an empty object rather than sending a non-object input', () => {
    expect(inputOf('"just a string"')).toEqual({});
  });

  it('maps a half-streamed fragment to an empty object instead of a 400', () => {
    expect(inputOf('{"city":"Os')).toEqual({});
  });
});

describe('tool_result content rendering', () => {
  function resultContentOf(result: unknown): unknown {
    const [block] = blocksOf([{ type: 'function_result', callId: 'c1', result }]);
    return block?.content;
  }

  it('renders an absent result as an empty string', () => {
    expect(resultContentOf(undefined)).toBe('');
    expect(resultContentOf(null)).toBe('');
  });

  it('renders a content list as text and image blocks, dropping the unrepresentable', () => {
    expect(
      resultContentOf([
        { type: 'text', text: 'measured' },
        { type: 'data', uri: 'data:image/png;base64,AAAA', mediaType: 'image/png' },
        { type: 'function_call', callId: 'nested', name: 'n', arguments: '' },
        42,
      ]),
    ).toEqual([
      { type: 'text', text: 'measured' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('renders a list with no representable item as an empty string', () => {
    expect(resultContentOf([42])).toBe('');
  });

  it('renders a plain object result as its JSON', () => {
    expect(resultContentOf({ ok: true })).toBe('{"ok":true}');
  });
});

describe('image conversion limits', () => {
  it('drops a data image whose URI is not base64-encoded', () => {
    // `tool_result` image sources are base64 or URL; a percent-encoded data URI has neither shape.
    expect(
      toAnthropicMessages([
        {
          role: 'user',
          contents: [{ type: 'data', uri: 'data:image/svg+xml,<svg/>', mediaType: 'image/svg+xml' }],
        },
      ]),
    ).toEqual([]);
  });
});

describe('reasoning replay limits', () => {
  it('drops a signature that has no thinking block to attach to', () => {
    expect(
      toAnthropicMessages([
        { role: 'assistant', contents: [{ type: 'text_reasoning', text: '', protectedData: 'sig' }] },
      ]),
    ).toEqual([]);
  });

  it('replays an identified summary without a signature as plain text, not thinking', () => {
    expect(blocksOf([{ type: 'text_reasoning', text: 'the gist', id: 'rs_1' }])).toEqual([
      { type: 'text', text: 'the gist' },
    ]);
  });
});

describe('MCP block conversion', () => {
  it('splits a provider-run MCP exchange into the roles the API requires', () => {
    const messages = toAnthropicMessages([
      {
        role: 'assistant',
        contents: [
          {
            type: 'mcp_server_tool_call',
            callId: 'mc1',
            toolName: 'lookup',
            serverName: 'srv',
            arguments: { q: 1 },
          },
          { type: 'mcp_server_tool_result', callId: 'mc1', output: [{ type: 'text', text: 'found' }] },
        ],
      },
    ]);
    expect(messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'mcp_tool_use', id: 'mc1', name: 'lookup', server_name: 'srv', input: { q: 1 } }],
      },
      {
        role: 'user',
        content: [
          { type: 'mcp_tool_result', tool_use_id: 'mc1', content: [{ type: 'text', text: 'found' }] },
        ],
      },
    ]);
  });

  it('defaults the optional fields of a bare MCP call', () => {
    expect(blocksOf([{ type: 'mcp_server_tool_call' }])).toEqual([
      { type: 'mcp_tool_use', id: '', name: '', server_name: '', input: {} },
    ]);
  });
});

describe('framework-side content', () => {
  it('sends nothing for content kinds that have no Messages API shape', () => {
    expect(
      toAnthropicMessages([
        { role: 'assistant', contents: [{ type: 'usage', usageDetails: { inputTokenCount: 1 } }] },
      ]),
    ).toEqual([]);
  });

  it('maps an unrecognised role to user', () => {
    const messages = toAnthropicMessages([
      { role: 'developer', contents: [{ type: 'text', text: 'hi' }] } as unknown as Message,
    ]);
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });
});

describe('system parameter', () => {
  it('reports nothing when there is neither an instruction nor a system message', () => {
    expect(
      toAnthropicSystem([{ role: 'user', contents: [{ type: 'text', text: 'hi' }] }], undefined),
    ).toBeUndefined();
  });

  it('uses the instructions alone when the transcript has no system message', () => {
    expect(toAnthropicSystem([], 'be brief')).toBe('be brief');
  });

  it('ignores an empty instruction string', () => {
    const messages: Message[] = [{ role: 'system', contents: [{ type: 'text', text: 'sys' }] }];
    expect(toAnthropicSystem(messages, '')).toBe('sys');
  });
});

describe('tool conversion limits', () => {
  it('skips a tool that is neither a function tool nor a hosted tool', () => {
    expect(toAnthropicTools([{ name: 'mystery' } as unknown as Tool])).toEqual({});
  });
});

describe('output format limits', () => {
  it('passes a non-object schema through without forcing additionalProperties onto it', () => {
    // A converter is free to return any JSON Schema value, including an array form; forcing
    // `additionalProperties` onto it would corrupt it.
    const schema = { toJsonSchema: (): unknown[] => [{ type: 'object' }] };
    expect(toAnthropicOutputFormat({ name: 'anything', schema })).toEqual({
      type: 'json_schema',
      schema: [{ type: 'object' }],
    });
  });
});
