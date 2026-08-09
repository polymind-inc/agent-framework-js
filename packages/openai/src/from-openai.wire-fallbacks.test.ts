import type { ChatResponseUpdate, Content, Message } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import {
  createStreamParseState,
  parseFinishReason,
  parseResponse,
  parseStreamEvent,
  parseUsage,
} from './from-openai.js';

// The Responses API wire is read defensively: the service can send items with fields missing,
// empty, or shaped differently from what the SDK types declare, and each of those degenerate
// forms has a defined mapping (matching `_parse_response_from_openai` and
// `_parse_chunk_from_openai` in Python's `_chat_client.py`). These tests pin the fallbacks down
// with payloads that omit exactly the field whose absence the mapping has to absorb.

/** All contents of a parsed response, flattened. */
function contentsOf(response: { messages: Message[] }): Content[] {
  return response.messages.flatMap((msg) => msg.contents);
}

/** Parses a single stream event against fresh stream state. */
function parseOne(event: unknown): ChatResponseUpdate | undefined {
  return parseStreamEvent(event, createStreamParseState());
}

describe('parseUsage fallbacks', () => {
  it('returns undefined for a missing usage object', () => {
    expect(parseUsage(undefined)).toBeUndefined();
    expect(parseUsage(null)).toBeUndefined();
  });

  it('returns undefined when the usage object carries no numeric field', () => {
    expect(parseUsage({})).toBeUndefined();
    // Non-numeric values are not usage numbers; each guarded read must skip them.
    expect(parseUsage({ input_tokens: 'many', output_tokens: null, total_tokens: {} })).toBeUndefined();
  });

  it('maps cache and reasoning token details onto both framework and provider keys', () => {
    expect(
      parseUsage({
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 2 },
      }),
    ).toEqual({
      inputTokenCount: 10,
      outputTokenCount: 5,
      totalTokenCount: 15,
      cacheReadInputTokenCount: 4,
      'openai.cached_input_tokens': 4,
      cacheCreationInputTokenCount: 3,
      'openai.cache_write_tokens': 3,
      reasoningOutputTokenCount: 2,
      'openai.reasoning_tokens': 2,
    });
  });
});

describe('parseFinishReason', () => {
  // Python `_get_finish_reason_from_openai_response` (`_chat_client.py:2513-2520`): the
  // incomplete reason wins over the status, a completed response reports `tool_calls` only when
  // its output contains a function call, and anything still in flight reports nothing.
  it('maps an incomplete content_filter response', () => {
    expect(parseFinishReason({ incomplete_details: { reason: 'content_filter' } })).toBe('content_filter');
  });

  it('maps an incomplete max_output_tokens response to length', () => {
    expect(parseFinishReason({ incomplete_details: { reason: 'max_output_tokens' } })).toBe('length');
  });

  it('reports nothing while the response is still in flight', () => {
    expect(parseFinishReason({ status: 'in_progress' })).toBeUndefined();
    expect(parseFinishReason(undefined)).toBeUndefined();
  });

  it('reports stop for a completed response without output', () => {
    expect(parseFinishReason({ status: 'completed' })).toBe('stop');
  });

  it('reports tool_calls when the completed output contains a function call', () => {
    expect(parseFinishReason({ status: 'completed', output: [{ type: 'function_call' }] })).toBe(
      'tool_calls',
    );
  });
});

describe('conversation id', () => {
  // Python `_get_conversation_id` (`_chat_client.py:924-936`): `store=False` suppresses the id
  // entirely, a non-empty conversation id wins over the response id, and an empty one falls
  // through to the response id.
  it('suppresses the conversation id when the request opted out of storage', () => {
    const response = parseResponse({ id: 'resp_1', conversation: { id: 'conv_1' } }, { store: false });
    expect(response.conversationId).toBeUndefined();
  });

  it('prefers a non-empty conversation id over the response id', () => {
    const response = parseResponse({ id: 'resp_1', conversation: { id: 'conv_1' } });
    expect(response.conversationId).toBe('conv_1');
  });

  it('falls back to the response id when the conversation id is empty', () => {
    const response = parseResponse({ id: 'resp_1', conversation: { id: '' } });
    expect(response.conversationId).toBe('resp_1');
  });
});

describe('media type detection of generated images', () => {
  // The detection table is a port of Python `detect_media_type_from_base64` (`_types.py`): only
  // the magic bytes decide, and an unrecognised signature falls back to png on this call path.
  const pad = (bytes: number[], length = 16): number[] => [
    ...bytes,
    ...Array(Math.max(0, length - bytes.length)).fill(0),
  ];
  const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));

  const cases: Array<{ name: string; bytes: number[]; expected: string }> = [
    { name: 'png', bytes: pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), expected: 'image/png' },
    { name: 'jpeg', bytes: pad([0xff, 0xd8, 0xff]), expected: 'image/jpeg' },
    { name: 'gif87a', bytes: pad(ascii('GIF87a')), expected: 'image/gif' },
    { name: 'gif89a', bytes: pad(ascii('GIF89a')), expected: 'image/gif' },
    { name: 'webp', bytes: pad([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')]), expected: 'image/webp' },
    { name: 'bmp', bytes: pad(ascii('BM')), expected: 'image/bmp' },
    { name: 'svg tag', bytes: pad(ascii('<svg xmlns=')), expected: 'image/svg+xml' },
    { name: 'xml prolog', bytes: pad(ascii('<?xml versi')), expected: 'image/svg+xml' },
    { name: 'pdf', bytes: pad(ascii('%PDF-1.7')), expected: 'application/pdf' },
    { name: 'wav', bytes: pad([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]), expected: 'audio/wav' },
    { name: 'mp3 id3', bytes: pad(ascii('ID3')), expected: 'audio/mpeg' },
    { name: 'mp3 frame fb', bytes: pad([0xff, 0xfb]), expected: 'audio/mpeg' },
    { name: 'mp3 frame f3', bytes: pad([0xff, 0xf3]), expected: 'audio/mpeg' },
    { name: 'ogg', bytes: pad(ascii('OggS')), expected: 'audio/ogg' },
    { name: 'flac', bytes: pad(ascii('fLaC')), expected: 'audio/flac' },
    { name: 'unrecognised signature', bytes: pad(ascii('ZZZZZZ')), expected: 'image/png' },
  ];

  it.each(cases)('detects $name', ({ bytes, expected }) => {
    const result = Buffer.from(bytes).toString('base64');
    const contents = contentsOf(
      parseResponse({ output: [{ type: 'image_generation_call', id: 'ig_1', result }] }),
    );
    const output = contents.find((content) => content.type === 'image_generation_tool_result');
    if (output?.type !== 'image_generation_tool_result') throw new Error('expected an image result');
    expect(output.outputs?.[0]).toMatchObject({
      mediaType: expected,
      uri: `data:${expected};base64,${result}`,
    });
  });

  it('emits no image output when the item carries no result', () => {
    const contents = contentsOf(parseResponse({ output: [{ type: 'image_generation_call' }] }));
    expect(contents).toEqual([
      expect.objectContaining({ type: 'image_generation_tool_call', imageId: '' }),
      expect.objectContaining({ type: 'image_generation_tool_result', imageId: '', outputs: [] }),
    ]);
  });
});

describe('awaited message parts', () => {
  it('maps a refusal part to text, as Python does', () => {
    // Python `_parse_response_from_openai` (`_chat_client.py:2636-2639`).
    const contents = contentsOf(
      parseResponse({
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'cannot help' }] }],
      }),
    );
    expect(contents).toEqual([expect.objectContaining({ type: 'text', text: 'cannot help' })]);
  });

  it('skips message parts of an unknown type', () => {
    const contents = contentsOf(
      parseResponse({ output: [{ type: 'message', content: [{ type: 'mystery_part' }] }] }),
    );
    expect(contents).toEqual([]);
  });

  it('maps a message without content to no contents at all', () => {
    expect(contentsOf(parseResponse({ output: [{ type: 'message' }] }))).toEqual([]);
  });

  it('maps a missing output list to an empty assistant message', () => {
    const response = parseResponse(undefined);
    expect(response.messages).toEqual([expect.objectContaining({ role: 'assistant', contents: [] })]);
  });
});

describe('annotation forms', () => {
  function annotationsOf(annotations: unknown[]): Content['annotations'] {
    const contents = contentsOf(
      parseResponse({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'cited', annotations }] }],
      }),
    );
    return contents[0]?.annotations;
  }

  it('keeps the index of a file_path annotation and drops a missing file id', () => {
    expect(annotationsOf([{ type: 'file_path', index: 3 }])).toEqual([
      {
        type: 'citation',
        rawRepresentation: { type: 'file_path', index: 3 },
        additionalProperties: { index: 3 },
      },
    ]);
  });

  it('maps a file_path annotation with a file id', () => {
    const [annotation] = annotationsOf([{ type: 'file_path', file_id: 'file_1' }]) ?? [];
    expect(annotation).toMatchObject({
      type: 'citation',
      fileId: 'file_1',
      additionalProperties: { index: null },
    });
  });

  it('maps a bare file_citation without filename or file id', () => {
    expect(annotationsOf([{ type: 'file_citation' }])).toEqual([
      {
        type: 'citation',
        rawRepresentation: { type: 'file_citation' },
        additionalProperties: { index: null },
      },
    ]);
  });

  it('maps a bare url_citation without title, url or span', () => {
    expect(annotationsOf([{ type: 'url_citation' }])).toEqual([
      { type: 'citation', rawRepresentation: { type: 'url_citation' } },
    ]);
  });

  it('maps a bare container_file_citation without file id, filename or span', () => {
    expect(annotationsOf([{ type: 'container_file_citation' }])).toEqual([
      {
        type: 'citation',
        rawRepresentation: { type: 'container_file_citation' },
        additionalProperties: { container_id: null },
      },
    ]);
  });

  it('drops annotation forms the framework does not know', () => {
    // Python debug-logs and drops them (`_parse_response_from_openai`); when every annotation is
    // dropped the content carries none at all.
    expect(annotationsOf([{ type: 'mystery_citation' }])).toBeUndefined();
  });
});

describe('reasoning item fallbacks', () => {
  it('preserves an encrypted-only reasoning item as a single empty fragment', () => {
    const contents = contentsOf(
      parseResponse({ output: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' }] }),
    );
    expect(contents).toEqual([
      expect.objectContaining({ type: 'text_reasoning', id: 'rs_1', text: '', protectedData: 'enc' }),
    ]);
  });

  it('attaches the opaque payload only to the first fragment', () => {
    const contents = contentsOf(
      parseResponse({
        output: [
          {
            type: 'reasoning',
            id: 'rs_1',
            encrypted_content: 'enc',
            content: [
              { type: 'reasoning_text', text: 'first' },
              { type: 'reasoning_text', text: 'second' },
            ],
          },
        ],
      }),
    );
    expect(contents.map((content) => content.type === 'text_reasoning' && content.protectedData)).toEqual([
      'enc',
      undefined,
    ]);
  });

  it('maps a reasoning fragment without text to an empty string', () => {
    const contents = contentsOf(
      parseResponse({ output: [{ type: 'reasoning', id: 'rs_1', content: [{ type: 'reasoning_text' }] }] }),
    );
    expect(contents[0]).toMatchObject({ type: 'text_reasoning', text: '' });
  });
});

describe('function and hosted tool call fallbacks', () => {
  it('falls back to the item id when a function call has no call_id', () => {
    const contents = contentsOf(parseResponse({ output: [{ type: 'function_call', id: 'fc_1' }] }));
    expect(contents[0]).toMatchObject({ type: 'function_call', callId: 'fc_1', name: '', arguments: '' });
  });

  it('maps a bare file_search_call to empty queries with no status', () => {
    const contents = contentsOf(parseResponse({ output: [{ type: 'file_search_call' }] }));
    expect(contents[0]).toMatchObject({
      type: 'search_tool_call',
      callId: '',
      toolName: 'file_search',
      arguments: { queries: [] },
    });
    expect(contents[0]?.additionalProperties).toBeUndefined();
  });

  it('keeps a wire call_id on a search call the SDK does not declare one for', () => {
    const contents = contentsOf(
      parseResponse({
        output: [{ type: 'web_search_call', call_id: 'ws_1', action: { type: 'search', query: 'q' } }],
      }),
    );
    expect(contents[0]).toMatchObject({
      type: 'search_tool_call',
      callId: 'ws_1',
      toolName: 'web_search',
      arguments: { type: 'search', query: 'q' },
    });
  });

  it('maps a code interpreter item without code to a result only', () => {
    const contents = contentsOf(
      parseResponse({
        output: [
          {
            type: 'code_interpreter_call',
            id: 'ci_1',
            outputs: [{ type: 'logs' }, { type: 'image' }, { type: 'image', url: 'https://img.example/1' }],
          },
        ],
      }),
    );
    // No `code_interpreter_tool_call` without code; a logs output without text becomes an empty
    // string, and an image output without a url has nothing to point at.
    expect(contents).toEqual([
      expect.objectContaining({
        type: 'code_interpreter_tool_result',
        callId: 'ci_1',
        outputs: [
          expect.objectContaining({ type: 'text', text: '' }),
          expect.objectContaining({ type: 'uri', uri: 'https://img.example/1', mediaType: 'image' }),
        ],
      }),
    ]);
  });

  it('renders a non-string logs payload as an empty text output', () => {
    // A corrupt transcript can carry anything in `logs`; `Content.text` is a string contract, so
    // the payload degrades to empty rather than leaking a number into the content model.
    const contents = contentsOf(
      parseResponse({
        output: [{ type: 'code_interpreter_call', id: 'ci_1', outputs: [{ type: 'logs', logs: 42 }] }],
      }),
    );
    expect(contents[0]).toMatchObject({
      type: 'code_interpreter_tool_result',
      outputs: [expect.objectContaining({ type: 'text', text: '' })],
    });
  });

  it('treats a non-array outputs payload as no outputs instead of throwing', () => {
    // A non-array is not even iterable; the conversion must not let a corrupt transcript turn
    // into a thrown TypeError that fails the whole parse.
    const contents = contentsOf(
      parseResponse({
        output: [{ type: 'code_interpreter_call', id: 'ci_1', outputs: { corrupt: true } }],
      }),
    );
    expect(contents[0]).toMatchObject({ type: 'code_interpreter_tool_result', outputs: [] });
  });

  it('falls back to call_id when an mcp_call has an empty id', () => {
    const contents = contentsOf(parseResponse({ output: [{ type: 'mcp_call', id: '', call_id: 'mc_2' }] }));
    expect(contents[0]).toMatchObject({ type: 'mcp_server_tool_call', callId: 'mc_2' });
  });

  it('falls back to call_id when a search call has an empty id', () => {
    const contents = contentsOf(
      parseResponse({ output: [{ type: 'web_search_call', id: '', call_id: 'ws_2' }] }),
    );
    expect(contents[0]).toMatchObject({ type: 'search_tool_call', callId: 'ws_2' });
  });

  it('falls back to the item id when a code interpreter call_id is empty', () => {
    const contents = contentsOf(
      parseResponse({ output: [{ type: 'code_interpreter_call', call_id: '', id: 'ci_9' }] }),
    );
    expect(contents[0]).toMatchObject({ type: 'code_interpreter_tool_result', callId: 'ci_9' });
  });

  it('maps a bare mcp_call without output to a call and no result', () => {
    const contents = contentsOf(parseResponse({ output: [{ type: 'mcp_call' }] }));
    expect(contents).toEqual([
      expect.objectContaining({
        type: 'mcp_server_tool_call',
        callId: '',
        toolName: '',
        serverName: '',
        arguments: '',
      }),
    ]);
  });

  it('treats a null mcp_call output as no result', () => {
    const contents = contentsOf(parseResponse({ output: [{ type: 'mcp_call', id: 'mc_1', output: null }] }));
    expect(contents.map((content) => content.type)).toEqual(['mcp_server_tool_call']);
  });

  it('surfaces an mcp_call output as a text result', () => {
    const contents = contentsOf(
      parseResponse({ output: [{ type: 'mcp_call', call_id: 'mc_1', output: 'result text' }] }),
    );
    expect(contents[1]).toMatchObject({
      type: 'mcp_server_tool_result',
      callId: 'mc_1',
      output: [expect.objectContaining({ type: 'text', text: 'result text' })],
    });
  });

  it('maps a bare mcp_approval_request with every field defaulted', () => {
    const contents = contentsOf(parseResponse({ output: [{ type: 'mcp_approval_request' }] }));
    expect(contents[0]).toMatchObject({
      type: 'function_approval_request',
      id: '',
      userInputRequest: true,
      functionCall: expect.objectContaining({ callId: '', name: '', arguments: '' }),
    });
  });
});

describe('stream event fallbacks', () => {
  it('maps a refusal delta to text', () => {
    // Python `_parse_chunk_from_openai` (`_chat_client.py:2913-2914`).
    const update = parseOne({ type: 'response.refusal.delta', delta: 'cannot help' });
    expect(update?.contents).toEqual([expect.objectContaining({ type: 'text', text: 'cannot help' })]);
  });

  it('maps a refusal delta without a payload to empty text', () => {
    const update = parseOne({ type: 'response.refusal.delta' });
    expect(update?.contents).toEqual([expect.objectContaining({ type: 'text', text: '' })]);
  });

  it('emits the initial refusal text of a streamed content part', () => {
    const update = parseOne({
      type: 'response.content_part.added',
      part: { type: 'refusal', refusal: 'nope' },
    });
    expect(update?.contents).toEqual([expect.objectContaining({ type: 'text', text: 'nope' })]);
  });

  it('skips a streamed content part of an unknown type', () => {
    expect(parseOne({ type: 'response.content_part.added', part: { type: 'mystery_part' } })).toBeUndefined();
  });

  it('maps a text delta without a payload to empty text', () => {
    const update = parseOne({ type: 'response.output_text.delta' });
    expect(update?.contents).toEqual([expect.objectContaining({ type: 'text', text: '' })]);
  });

  it('skips a streamed annotation the framework does not know', () => {
    expect(
      parseOne({ type: 'response.output_text.annotation.added', annotation: { type: 'mystery_citation' } }),
    ).toBeUndefined();
  });

  it('emits a reasoning done event only when no delta preceded it', () => {
    // The done event repeats the full text; after a delta it would fold up as a duplicate.
    const state = createStreamParseState();
    const first = parseStreamEvent(
      { type: 'response.reasoning_text.done', item_id: 'rs_1', text: 'thought' },
      state,
    );
    expect(first?.contents).toEqual([
      expect.objectContaining({
        type: 'text_reasoning',
        id: 'rs_1',
        text: 'thought',
        additionalProperties: { reasoning_text: true },
      }),
    ]);

    parseStreamEvent({ type: 'response.reasoning_text.delta', item_id: 'rs_2', delta: 'thought' }, state);
    expect(
      parseStreamEvent({ type: 'response.reasoning_text.done', item_id: 'rs_2', text: 'thought' }, state),
    ).toBeUndefined();
  });

  it('emits a summary done event without the private-text marker', () => {
    const update = parseOne({
      type: 'response.reasoning_summary_text.done',
      item_id: 'rs_1',
      text: 'summary',
    });
    expect(update?.contents).toEqual([
      expect.objectContaining({ type: 'text_reasoning', id: 'rs_1', text: 'summary' }),
    ]);
    expect(update?.contents[0]?.additionalProperties).toBeUndefined();
  });

  it('emits a reasoning done event without an item id and with no text as an empty fragment', () => {
    const update = parseOne({ type: 'response.reasoning_text.done' });
    expect(update?.contents).toEqual([
      expect.objectContaining({
        type: 'text_reasoning',
        text: '',
        additionalProperties: { reasoning_text: true },
      }),
    ]);
    expect(update?.contents[0]).not.toHaveProperty('id');
  });

  it('falls back to the item id and an empty name when a streamed function call omits them', () => {
    const state = createStreamParseState();
    parseStreamEvent(
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1' } },
      state,
    );
    const update = parseStreamEvent(
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' },
      state,
    );
    expect(update?.contents[0]).toMatchObject({ type: 'function_call', callId: 'fc_1', name: '' });
  });

  it('maps an announced reasoning fragment without text to an empty string', () => {
    const update = parseOne({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', content: [{ type: 'reasoning_text' }] },
    });
    expect(update?.contents).toEqual([expect.objectContaining({ type: 'text_reasoning', text: '' })]);
    expect(update?.contents[0]).not.toHaveProperty('id');
  });

  it('carries the opaque payload on every announced reasoning fragment', () => {
    const update = parseOne({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'enc',
        content: [{ type: 'reasoning_text', text: 'thought' }],
      },
    });
    expect(update?.contents).toEqual([
      expect.objectContaining({ type: 'text_reasoning', id: 'rs_1', text: 'thought', protectedData: 'enc' }),
    ]);
  });

  it('announces a reasoning item without id or payload as a bare marker', () => {
    const update = parseOne({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning' },
    });
    expect(update?.contents).toEqual([expect.objectContaining({ type: 'text_reasoning', text: '' })]);
    expect(update?.contents[0]).not.toHaveProperty('id');
    expect(update?.contents[0]).not.toHaveProperty('protectedData');
  });

  it('preserves a done reasoning payload even when the item has no id', () => {
    const update = parseOne({
      type: 'response.output_item.done',
      item: { type: 'reasoning', encrypted_content: 'enc' },
    });
    expect(update?.contents).toEqual([
      expect.objectContaining({ type: 'text_reasoning', text: '', protectedData: 'enc' }),
    ]);
    expect(update?.contents[0]).not.toHaveProperty('id');
  });

  it('skips an arguments delta whose output_index announced no function call', () => {
    expect(
      parseOne({ type: 'response.function_call_arguments.delta', output_index: 7, delta: '{}' }),
    ).toBeUndefined();
  });

  it('maps an arguments delta without a payload to an empty arguments fragment', () => {
    const state = createStreamParseState();
    parseStreamEvent(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_1', name: 'lookup' },
      },
      state,
    );
    const update = parseStreamEvent(
      { type: 'response.function_call_arguments.delta', output_index: 0 },
      state,
    );
    expect(update?.contents).toEqual([
      expect.objectContaining({ type: 'function_call', callId: 'call_1', name: 'lookup', arguments: '' }),
    ]);
  });

  it('maps a partial image without a payload to an empty png frame', () => {
    const update = parseOne({ type: 'response.image_generation_call.partial_image' });
    expect(update?.contents[1]).toMatchObject({
      type: 'image_generation_tool_result',
      imageId: '',
      outputs: [
        expect.objectContaining({
          uri: 'data:image/png;base64,',
          mediaType: 'image/png',
          additionalProperties: expect.objectContaining({ is_partial_image: true }),
        }),
      ],
    });
  });

  it('skips the done echo of an item type that streamed its own deltas', () => {
    expect(
      parseOne({
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
      }),
    ).toBeUndefined();
  });

  it('skips the done echo of a reasoning item without an opaque payload', () => {
    expect(
      parseOne({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1' } }),
    ).toBeUndefined();
  });

  it('reports no response id or continuation token when response.created carries none', () => {
    const update = parseOne({ type: 'response.created', response: {} });
    expect(update?.responseId).toBeUndefined();
    expect(update?.continuationToken).toBeUndefined();
  });

  it('offers a continuation token as soon as a queued response has an id', () => {
    const update = parseOne({ type: 'response.created', response: { id: 'resp_1', status: 'queued' } });
    expect(update?.continuationToken).toEqual({ responseId: 'resp_1' });
  });

  it('maps a terminal event without id, model or usage to a bare update', () => {
    const update = parseOne({ type: 'response.completed', response: { status: 'completed' } });
    expect(update).toBeDefined();
    expect(update?.responseId).toBeUndefined();
    expect(update?.contents).toEqual([]);
    expect(update?.finishReason).toBe('stop');
  });
});
