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

  it('maps an empty argument string to an empty object', () => {
    expect(inputOf('')).toEqual({});
  });

  it('preserves a JSON scalar, array or null under `raw`', () => {
    expect(inputOf('"just a string"')).toEqual({ raw: 'just a string' });
    expect(inputOf('42')).toEqual({ raw: 42 });
    expect(inputOf('true')).toEqual({ raw: true });
    expect(inputOf('null')).toEqual({ raw: null });
    expect(inputOf('[1,2]')).toEqual({ raw: [1, 2] });
  });

  it('preserves text JSON cannot parse under `raw`, unchanged', () => {
    // A half-streamed fragment and a blank string are both corrupted calls, and both keep their
    // original text: trimming or erasing them would make the corruption unreadable.
    expect(inputOf('{"city":"Os')).toEqual({ raw: '{"city":"Os' });
    expect(inputOf('   ')).toEqual({ raw: '   ' });
  });

  it('never sends a non-object input, whatever the transcript holds', () => {
    // `arguments` is typed `Record<string, unknown> | string`, but a session restored from JSON is
    // not validated: an array or a number satisfies that type at compile time only. The Messages
    // API rejects a non-object `tool_use.input` with 400 `Input should be an object`.
    for (const value of [[1, 2], 42, true] as unknown[]) {
      const input = inputOf(value as Record<string, unknown>);
      expect(Array.isArray(input)).toBe(false);
      expect(typeof input).toBe('object');
      expect(input).toEqual({ raw: value });
    }
  });

  it('leaves the source content untouched', () => {
    const content = { type: 'function_call', callId: 'c1', name: 'f', arguments: '[1,2]' } as const;
    blocksOf([{ ...content }]);
    expect(content.arguments).toBe('[1,2]');
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

  it('degrades a result JSON cannot encode to its string form instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(resultContentOf(circular)).toBe('[object Object]');
    expect(resultContentOf(Symbol('opaque'))).toBe('Symbol(opaque)');
  });

  it('uses a stable placeholder when neither JSON nor string conversion is possible', () => {
    const unrenderable = Object.create(null) as Record<string, unknown>;
    unrenderable.self = unrenderable;

    expect(resultContentOf(unrenderable)).toBe('[unserializable]');
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
