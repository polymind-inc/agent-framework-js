import { describe, expect, it } from 'vitest';
import {
  createStreamParseState,
  parseContentBlocks,
  parseMessage,
  parseStreamEvent,
} from './from-anthropic.js';

// The Messages API wire is read defensively: blocks can omit fields, carry scalars where lists
// are expected, or be of kinds this build does not model, and each form has a defined mapping.
// These tests pin the mappings down one degenerate payload at a time.

describe('response-level fallbacks', () => {
  it('parses a non-object response to an empty assistant message', () => {
    const response = parseMessage(42);
    expect(response.messages).toEqual([expect.objectContaining({ role: 'assistant', contents: [] })]);
    expect(response.responseId).toBeUndefined();
  });

  it('ignores non-string ids and models, non-list content and empty usage', () => {
    const response = parseMessage({ id: 42, model: null, content: 'not a list', usage: {} });
    expect(response.responseId).toBeUndefined();
    expect(response.model).toBeUndefined();
    expect(response.messages[0]?.contents).toEqual([]);
    expect(response.usageDetails).toBeUndefined();
  });

  it('passes an unknown stop_reason through unchanged', () => {
    expect(parseMessage({ stop_reason: 'model_context_window_exceeded' }).finishReason).toBe(
      'model_context_window_exceeded',
    );
  });
});

describe('content block fallbacks', () => {
  it('skips entries that are not objects', () => {
    expect(parseContentBlocks([42, null, 'text'])).toEqual([]);
  });

  it('defaults the missing fields of text, thinking and signature blocks', () => {
    const [text, thinking, signature] = parseContentBlocks([
      { type: 'text' },
      { type: 'thinking' },
      { type: 'signature_delta' },
    ]);
    expect(text).toMatchObject({ type: 'text', text: '' });
    expect(thinking).toMatchObject({ type: 'text_reasoning', text: '' });
    expect(thinking).not.toHaveProperty('protectedData');
    expect(signature).toMatchObject({ type: 'text_reasoning', protectedData: '' });
  });

  it('defaults the missing fields of a bare tool_use block outside streaming', () => {
    expect(parseContentBlocks([{ type: 'tool_use' }])).toEqual([
      expect.objectContaining({ type: 'function_call', callId: '', name: '', arguments: {} }),
    ]);
  });

  it('renders a scalar mcp_tool_result content as one text output and a missing one as none', () => {
    const [scalar, missing, noId] = parseContentBlocks([
      { type: 'mcp_tool_result', tool_use_id: 'm1', content: 'found' },
      { type: 'mcp_tool_result', tool_use_id: 'm2' },
      { type: 'mcp_tool_result', content: null },
    ]);
    expect(scalar).toMatchObject({ callId: 'm1', output: [{ type: 'text', text: 'found' }] });
    expect(missing).toMatchObject({ callId: 'm2', output: [] });
    expect(noId).toMatchObject({ callId: '', output: [] });
  });

  it('maps provider-run search and fetch results onto the announcing server_tool_use call', () => {
    const results = [{ type: 'web_search_result', url: 'https://a.example' }];
    const [search, fetch] = parseContentBlocks([
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: results },
      { type: 'web_fetch_tool_result' },
    ]);
    expect(search).toMatchObject({ type: 'function_result', callId: 'srvtoolu_1', result: results });
    expect(fetch).toMatchObject({ type: 'function_result', callId: '' });
  });
});

describe('streamed tool-call argument handling', () => {
  it('opens a streamed call with empty string arguments so fragments can concatenate', () => {
    // `content_block_start` carries `input: {}` as a placeholder; keeping the object would make
    // the coalescer swallow every `input_json_delta` fragment that follows.
    const state = createStreamParseState();
    const update = parseStreamEvent(
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'f', input: {} } },
      state,
    );
    expect(update?.contents[0]).toMatchObject({ type: 'function_call', callId: 't1', arguments: '' });
  });

  it('keeps arguments that already arrived whole, even while streaming', () => {
    const state = createStreamParseState();
    const update = parseStreamEvent(
      {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 't1', name: 'f', input: { city: 'Osaka' } },
      },
      state,
    );
    expect(update?.contents[0]).toMatchObject({ arguments: { city: 'Osaka' } });
  });

  it('drops argument fragments of a server-side call instead of feeding them to the tool loop', () => {
    const state = createStreamParseState();
    parseStreamEvent(
      {
        type: 'content_block_start',
        content_block: { type: 'server_tool_use', id: 's1', name: 'web_search' },
      },
      state,
    );
    expect(
      parseStreamEvent(
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"q":' } },
        state,
      ),
    ).toBeUndefined();
  });

  it('drops an argument fragment that no call announced', () => {
    expect(
      parseStreamEvent(
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } },
        createStreamParseState(),
      ),
    ).toBeUndefined();
  });

  it('maps a fragment without a payload to an empty arguments string', () => {
    const state = createStreamParseState();
    parseStreamEvent(
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'f' } },
      state,
    );
    const update = parseStreamEvent(
      { type: 'content_block_delta', delta: { type: 'input_json_delta' } },
      state,
    );
    expect(update?.contents[0]).toMatchObject({ callId: 't1', arguments: '' });
  });

  it('tracks a streamed MCP call the same way, defaulting its fields', () => {
    const state = createStreamParseState();
    const update = parseStreamEvent(
      { type: 'content_block_start', content_block: { type: 'mcp_tool_use' } },
      state,
    );
    expect(update?.contents[0]).toMatchObject({
      type: 'mcp_server_tool_call',
      callId: '',
      toolName: '',
      serverName: '',
      arguments: '',
    });
  });
});

describe('stream event fallbacks', () => {
  it('ignores events that are not objects or carry nothing', () => {
    const state = createStreamParseState();
    expect(parseStreamEvent(42, state)).toBeUndefined();
    expect(parseStreamEvent({ type: 'ping' }, state)).toBeUndefined();
    expect(parseStreamEvent({ type: 'content_block_start' }, state)).toBeUndefined();
    expect(parseStreamEvent({ type: 'content_block_delta' }, state)).toBeUndefined();
  });

  it('parses a message_start without a message as an empty update', () => {
    const update = parseStreamEvent({ type: 'message_start' }, createStreamParseState());
    expect(update?.contents).toEqual([]);
    expect(update?.responseId).toBeUndefined();
  });

  it.each([
    {
      event: { type: 'content_block_start', content_block: { type: 'text', text: 'opened' } },
      expectedText: 'opened',
    },
    {
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'continued' } },
      expectedText: 'continued',
    },
  ])('routes $event.type through its content-block field', ({ event, expectedText }) => {
    const update = parseStreamEvent(event, createStreamParseState());
    expect(update?.contents).toEqual([expect.objectContaining({ type: 'text', text: expectedText })]);
    expect(update?.rawRepresentation).toBe(event);
  });

  it('turns cumulative usage snapshots into increments across the stream', () => {
    const state = createStreamParseState();
    const start = parseStreamEvent(
      { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 3, output_tokens: 1 } } },
      state,
    );
    expect(start?.contents).toEqual([
      expect.objectContaining({
        type: 'usage',
        usageDetails: { inputTokenCount: 3, outputTokenCount: 1 },
      }),
    ]);

    const delta = parseStreamEvent(
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 3, output_tokens: 5 },
      },
      state,
    );
    expect(delta?.contents).toEqual([
      expect.objectContaining({ usageDetails: { inputTokenCount: 0, outputTokenCount: 4 } }),
    ]);
    expect(delta?.finishReason).toBe('stop');
  });

  it('parses a message_delta without delta or usage as an empty update', () => {
    const update = parseStreamEvent({ type: 'message_delta', usage: {} }, createStreamParseState());
    expect(update?.contents).toEqual([]);
    expect(update?.finishReason).toBeUndefined();
  });
});
