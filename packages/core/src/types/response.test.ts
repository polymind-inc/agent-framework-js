import { describe, expect, it } from 'vitest';
import { decodeBase64 } from './base64.js';
import { coalesceContents } from './coalesce.js';
import { dataContent, textContent } from './content.js';
import type { AgentResponseUpdate, ChatResponseUpdate } from './response.js';
import {
  agentResponse,
  agentResponseUpdate,
  chatResponse,
  chatResponseToUpdates,
  chatResponseUpdate,
  mergeChatUpdates,
  mergeUpdates,
} from './response.js';
import { addUsage } from './usage.js';

function update(init: Partial<Parameters<typeof agentResponseUpdate>[0]> = {}): AgentResponseUpdate {
  return agentResponseUpdate({ contents: [], ...init });
}

/** Narrows away undefined; a missing value fails the test with a clear error. */
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value');
  return value;
}

describe('mergeUpdates', () => {
  it('concatenates text into a single message', () => {
    const response = mergeUpdates([
      update({ contents: [textContent('Hello')], role: 'assistant' }),
      update({ contents: [textContent(', ')] }),
      update({ contents: [textContent('world')] }),
    ]);

    expect(response.messages).toHaveLength(1);
    expect(response.messages[0]?.contents).toEqual([{ type: 'text', text: 'Hello, world' }]);
    expect(response.text).toBe('Hello, world');
  });

  it('starts a new message only when a non-empty author/id/role differs', () => {
    const response = mergeUpdates([
      update({ contents: [textContent('a')], messageId: 'm1', role: 'assistant' }),
      // No messageId at all: not "non-empty and different", so it stays in the same message.
      update({ contents: [textContent('b')] }),
      update({ contents: [textContent('c')], messageId: 'm2', authorName: 'agent' }),
      // Same id, but the author is now non-empty on both sides and differs.
      update({ contents: [textContent('d')], messageId: 'm2', authorName: 'other' }),
    ]);

    expect(
      response.messages.map((m) => m.contents.map((c) => (c as { text: string }).text).join('')),
    ).toEqual(['ab', 'c', 'd']);
  });

  it('does not split on a differing role when one side is empty', () => {
    const response = mergeUpdates([
      update({ contents: [textContent('a')] }),
      update({ contents: [textContent('b')], role: 'assistant' }),
    ]);
    expect(response.messages).toHaveLength(1);
  });

  it('takes the latest non-empty metadata but keeps the first valid createdAt', () => {
    const response = mergeUpdates([
      update({ responseId: 'r1', createdAt: '2026-01-01T00:00:00.000Z' }),
      update({ responseId: '' }),
      update({ responseId: 'r2', finishReason: 'stop', createdAt: '2026-02-02T00:00:00.000Z' }),
    ]);

    expect(response.responseId).toBe('r2');
    expect(response.finishReason).toBe('stop');
    expect(response.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('always takes the latest continuation token so a finished operation can clear it', () => {
    const response = mergeUpdates([update({ continuationToken: { responseId: 'resp_1' } }), update({})]);
    expect(response.continuationToken).toBeUndefined();
  });

  it('aggregates usage contents into usageDetails instead of the transcript', () => {
    const response = mergeUpdates([
      update({ contents: [{ type: 'usage', usageDetails: { inputTokenCount: 5, outputTokenCount: 2 } }] }),
      update({ contents: [{ type: 'usage', usageDetails: { inputTokenCount: 3, totalTokenCount: 1 } }] }),
    ]);

    expect(response.usageDetails).toEqual({ inputTokenCount: 8, outputTokenCount: 2, totalTokenCount: 1 });
    expect(response.messages[0]?.contents ?? []).toEqual([]);
  });

  it('concatenates streamed function-call argument fragments', () => {
    const response = mergeUpdates([
      update({
        contents: [{ type: 'function_call', callId: 'c1', name: 'get_weather', arguments: '{"loc' }],
      }),
      update({
        contents: [{ type: 'function_call', callId: 'c1', name: 'get_weather', arguments: 'ation":"' }],
      }),
      update({
        contents: [{ type: 'function_call', callId: 'c1', name: 'get_weather', arguments: 'Tokyo"}' }],
      }),
    ]);

    expect(response.messages[0]?.contents).toEqual([
      { type: 'function_call', callId: 'c1', name: 'get_weather', arguments: '{"location":"Tokyo"}' },
    ]);
  });

  it('never drops an argument fragment when an annotated call fragment cannot be merged', () => {
    // Regression: the fold used to replace the previous fragment with coalesceContents(...)[0],
    // silently discarding the second element when annotations blocked the merge.
    const response = mergeUpdates([
      update({
        contents: [
          {
            type: 'function_call',
            callId: 'c1',
            name: 'f',
            arguments: '{"a"',
            annotations: [{ type: 'citation', url: 'https://example.com' }],
          },
        ],
      }),
      update({ contents: [{ type: 'function_call', callId: 'c1', name: 'f', arguments: ':1}' }] }),
    ]);

    const contents = must(response.messages[0]).contents;
    expect(contents).toHaveLength(2);
    expect(contents.map((c) => (c as { arguments: string }).arguments)).toEqual(['{"a"', ':1}']);
  });

  it('keeps calls with different ids apart', () => {
    const response = mergeUpdates([
      update({ contents: [{ type: 'function_call', callId: 'c1', name: 'a', arguments: '{}' }] }),
      update({ contents: [{ type: 'function_call', callId: 'c2', name: 'b', arguments: '{}' }] }),
    ]);
    expect(response.messages[0]?.contents).toHaveLength(2);
  });

  it('returns an empty response for no updates', () => {
    const response = mergeUpdates([]);
    expect(response.messages).toEqual([]);
    expect(response.text).toBe('');
    expect(response.value).toBeUndefined();
  });
});

describe('chatResponseToUpdates', () => {
  it('round-trips through mergeChatUpdates', () => {
    const original = chatResponse<undefined>({
      messages: [
        { role: 'assistant', contents: [textContent('hi')], messageId: 'm1' },
        {
          role: 'tool',
          contents: [{ type: 'function_result', callId: 'c1', result: 'ok' }],
          messageId: 'm2',
        },
      ],
      responseId: 'resp_1',
      model: 'gpt-4o',
      finishReason: 'stop',
      usageDetails: { inputTokenCount: 4, outputTokenCount: 6 },
    });

    const restored = mergeChatUpdates<undefined>(chatResponseToUpdates(original));

    expect(restored.responseId).toBe('resp_1');
    expect(restored.model).toBe('gpt-4o');
    expect(restored.finishReason).toBe('stop');
    expect(restored.usageDetails).toEqual({ inputTokenCount: 4, outputTokenCount: 6 });
    expect(restored.messages.map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(restored.text).toBe('hi');
  });

  it('round-trips response-level additionalProperties without usage or a continuation token', () => {
    // Regression: the metadata-only trailing update was emitted only for usage / continuation
    // token, so additionalProperties were lost (Go ToUpdates also checks hasAdditionalProperties).
    const original = chatResponse<undefined>({
      messages: [{ role: 'assistant', contents: [textContent('hi')], messageId: 'm1' }],
      additionalProperties: { metadata: { tenant: 'contoso' } },
    });

    const restored = mergeChatUpdates<undefined>(chatResponseToUpdates(original));
    expect(restored.additionalProperties).toEqual({ metadata: { tenant: 'contoso' } });
  });

  it('emits a metadata-only update for a response with no messages', () => {
    const updates: ChatResponseUpdate[] = chatResponseToUpdates(
      chatResponse<undefined>({ messages: [], responseId: 'resp_2' }),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.responseId).toBe('resp_2');
  });
});

describe('addUsage', () => {
  it('sums the union of keys and tolerates undefined operands', () => {
    expect(addUsage({ inputTokenCount: 1 }, { inputTokenCount: 2, outputTokenCount: 3 })).toEqual({
      inputTokenCount: 3,
      outputTokenCount: 3,
    });
    expect(addUsage(undefined, { inputTokenCount: 2 })).toEqual({ inputTokenCount: 2 });
    expect(addUsage({ inputTokenCount: 2 }, undefined)).toEqual({ inputTokenCount: 2 });
    expect(addUsage(undefined, undefined)).toEqual({});
  });

  it('keeps provider-specific counters', () => {
    expect(addUsage({ 'openai.reasoning_tokens': 5 }, { 'openai.reasoning_tokens': 2 })).toEqual({
      'openai.reasoning_tokens': 7,
    });
  });
});

describe('coalesceContents', () => {
  it('leaves a lone item untouched, annotations included', () => {
    const annotated = { type: 'text' as const, text: 'x', annotations: [{ type: 'citation' as const }] };
    expect(coalesceContents([annotated])[0]).toBe(annotated);
  });

  it('never merges annotated items into a run', () => {
    const result = coalesceContents([
      textContent('a'),
      { type: 'text', text: 'b', annotations: [{ type: 'citation' }] },
      textContent('c'),
    ]);
    expect(result).toHaveLength(3);
  });

  it('merges reasoning only when ids agree', () => {
    const merged = coalesceContents([
      { type: 'text_reasoning', id: 'r1', text: 'thin' },
      { type: 'text_reasoning', id: 'r1', text: 'king' },
      { type: 'text_reasoning', id: 'r2', text: 'other' },
    ]);
    expect(merged).toEqual([
      { type: 'text_reasoning', id: 'r1', text: 'thinking' },
      { type: 'text_reasoning', id: 'r2', text: 'other' },
    ]);
  });

  it('carries the trailing protected payload onto the merged reasoning item', () => {
    const merged = coalesceContents([
      { type: 'text_reasoning', id: 'r1', text: 'a' },
      { type: 'text_reasoning', id: 'r1', text: 'b', protectedData: 'enc' },
    ]);
    expect(merged).toEqual([{ type: 'text_reasoning', id: 'r1', text: 'ab', protectedData: 'enc' }]);
  });

  it('concatenates adjacent textual data content', () => {
    const merged = coalesceContents([
      { type: 'data', uri: 'data:text/plain;base64,aGVsbG8=', mediaType: 'text/plain' },
      { type: 'data', uri: 'data:text/plain;base64,IHdvcmxk', mediaType: 'text/plain' },
    ]);
    expect(merged).toHaveLength(1);
    expect((merged[0] as { uri: string }).uri).toBe('data:text/plain;base64,aGVsbG8gd29ybGQ=');
  });

  it('concatenates large data payloads without overflowing the argument limit', () => {
    // Regression: the merged bytes were built with a spread push, which throws
    // a RangeError once a decoded payload exceeds the engine's argument-count limit (~100k).
    const big = new Uint8Array(300_000).fill(65);
    const merged = coalesceContents([dataContent(big, 'text/plain'), dataContent(big, 'text/plain')]);
    expect(merged).toHaveLength(1);
    const payload = must((merged[0] as { uri: string }).uri.split(',')[1]);
    expect(decodeBase64(payload)).toHaveLength(600_000);
  });

  it('does not let an id-less fragment bridge two distinct calls', () => {
    // Regression: pairwise merging let [id 'x', id '', id 'y'] fold into a
    // single call, silently appending y's arguments to x.
    const merged = coalesceContents([
      { type: 'function_call', callId: 'x', name: 'f', arguments: '{"a"' },
      { type: 'function_call', callId: '', name: '', arguments: ':1}' },
      { type: 'function_call', callId: 'y', name: 'g', arguments: '{"b":2}' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ callId: 'x', name: 'f', arguments: '{"a":1}' });
    expect(merged[1]).toMatchObject({ callId: 'y', name: 'g', arguments: '{"b":2}' });
  });

  it('never concatenates reasoning text with a reasoning summary', () => {
    // Regression: the two carry the same reasoning id but different meanings, and
    // only the private text carries the `reasoning_text` marker. Python raises AdditionItemMismatch
    // (`_add_text_reasoning_content`) so the fold keeps them as separate items.
    const merged = coalesceContents([
      {
        type: 'text_reasoning',
        id: 'rs_1',
        text: 'private thought',
        additionalProperties: { reasoning_text: true },
      },
      { type: 'text_reasoning', id: 'rs_1', text: 'public summary' },
    ]);
    expect(merged).toEqual([
      {
        type: 'text_reasoning',
        id: 'rs_1',
        text: 'private thought',
        additionalProperties: { reasoning_text: true },
      },
      { type: 'text_reasoning', id: 'rs_1', text: 'public summary' },
    ]);
  });

  it('still concatenates reasoning fragments that agree on the marker', () => {
    expect(
      coalesceContents([
        { type: 'text_reasoning', id: 'rs_1', text: 'thin', additionalProperties: { reasoning_text: true } },
        { type: 'text_reasoning', id: 'rs_1', text: 'king', additionalProperties: { reasoning_text: true } },
      ]),
    ).toEqual([
      {
        type: 'text_reasoning',
        id: 'rs_1',
        text: 'thinking',
        additionalProperties: { reasoning_text: true },
      },
    ]);
    expect(
      coalesceContents([
        { type: 'text_reasoning', id: 'rs_1', text: 'sum' },
        { type: 'text_reasoning', id: 'rs_1', text: 'mary' },
      ]),
    ).toEqual([{ type: 'text_reasoning', id: 'rs_1', text: 'summary' }]);
  });

  it('only rejects the marker mismatch when both texts are non-empty', () => {
    // Python compares the marker only once both sides contribute characters, so an empty
    // marker-carrying fragment (an `output_item.added` placeholder) still folds into the summary.
    expect(
      coalesceContents([
        { type: 'text_reasoning', id: 'rs_1', text: '', additionalProperties: { reasoning_text: true } },
        { type: 'text_reasoning', id: 'rs_1', text: 'public summary' },
      ]),
    ).toEqual([
      {
        type: 'text_reasoning',
        id: 'rs_1',
        text: 'public summary',
        additionalProperties: { reasoning_text: true },
      },
    ]);
    expect(
      coalesceContents([
        {
          type: 'text_reasoning',
          id: 'rs_1',
          text: 'private thought',
          additionalProperties: { reasoning_text: true },
        },
        { type: 'text_reasoning', id: 'rs_1', text: '' },
      ]),
    ).toEqual([
      {
        type: 'text_reasoning',
        id: 'rs_1',
        text: 'private thought',
        additionalProperties: { reasoning_text: true },
      },
    ]);
  });

  it('tests the marker against the accumulated run, not just the predecessor', () => {
    // Python folds into `first_new_content`, so once the run carries the marker an empty
    // marker-less fragment cannot launder the next summary fragment into it.
    const merged = coalesceContents([
      {
        type: 'text_reasoning',
        id: 'rs_1',
        text: 'private thought',
        additionalProperties: { reasoning_text: true },
      },
      { type: 'text_reasoning', id: 'rs_1', text: '' },
      { type: 'text_reasoning', id: 'rs_1', text: 'public summary' },
    ]);
    expect(merged).toEqual([
      {
        type: 'text_reasoning',
        id: 'rs_1',
        text: 'private thought',
        additionalProperties: { reasoning_text: true },
      },
      { type: 'text_reasoning', id: 'rs_1', text: 'public summary' },
    ]);
  });

  it('does not let an id-less reasoning fragment bridge two distinct reasoning items', () => {
    // Python compares the accumulated id (`self.id or other.id`) with the candidate, so 'rs_2'
    // conflicts with the run started by 'rs_1' even though the fragment in between has no id.
    const merged = coalesceContents([
      { type: 'text_reasoning', id: 'rs_1', text: 'a' },
      { type: 'text_reasoning', text: 'b' },
      { type: 'text_reasoning', id: 'rs_2', text: 'c' },
    ]);
    expect(merged).toEqual([
      { type: 'text_reasoning', id: 'rs_1', text: 'ab' },
      { type: 'text_reasoning', id: 'rs_2', text: 'c' },
    ]);
  });
});

describe('chatResponseUpdate', () => {
  it('exposes a live, non-enumerable text getter', () => {
    const u = chatResponseUpdate({ contents: [textContent('a')] });
    expect(u.text).toBe('a');
    u.contents.push(textContent('b'));
    expect(u.text).toBe('ab');
    expect(JSON.parse(JSON.stringify(u))).not.toHaveProperty('text');
  });
});

describe('agentResponse.userInputRequests', () => {
  it('surfaces approval requests and OAuth consent requests, like Python user_input_requests', () => {
    const response = agentResponse({
      messages: [
        {
          role: 'assistant',
          contents: [
            textContent('hold on'),
            {
              type: 'function_approval_request',
              id: 'ficc_c1',
              userInputRequest: true,
              functionCall: { type: 'function_call', callId: 'c1', name: 'wipe', arguments: '{}' },
            },
            { type: 'oauth_consent_request', consentLink: 'https://consent', userInputRequest: true },
          ],
        },
      ],
    });
    expect(response.userInputRequests.map((request) => request.type)).toEqual([
      'function_approval_request',
      'oauth_consent_request',
    ]);
  });
});
