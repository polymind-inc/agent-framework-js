import type { ChatResponseUpdate, Content, Message, TextContent } from '@polymind-inc/agent-framework-core';
import { deserializeMessage, mergeChatUpdates, serializeMessage } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import type { ParseContext } from './from-openai.js';
import { createStreamParseState, parseResponse, parseStreamEvent } from './from-openai.js';
import { toResponsesInput } from './to-openai.js';

/** All contents of a parsed response, flattened. */
function contentsOf(response: { messages: Message[] }): Content[] {
  return response.messages.flatMap((msg) => msg.contents);
}

/** Narrows away undefined; a missing value fails the test with a clear error. */
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value');
  return value;
}

/** The wire shape of a replayed assistant message, as far as these assertions read it. */
type WireMessage = { content: Array<{ annotations?: unknown }> };

/** Drops the raw provider payloads so streamed and awaited transcripts can be compared directly. */
function reasoningShape(contents: readonly Content[]): unknown[] {
  return contents
    .filter((content) => content.type === 'text_reasoning')
    .map((content) => ({
      id: content.id,
      text: content.text,
      protectedData: content.protectedData,
      reasoningText: content.additionalProperties?.reasoning_text,
    }));
}

function fold(events: readonly unknown[], ctx?: ParseContext): ChatResponseUpdate[] {
  const state = createStreamParseState();
  const updates: ChatResponseUpdate[] = [];
  for (const event of events) {
    const update = parseStreamEvent(event, state, ctx);
    if (update !== undefined) {
      updates.push(update);
    }
  }
  return updates;
}

describe('reasoning text vs reasoning summary', () => {
  // Both arrive under the same reasoning id and only the private text carries the
  // `reasoning_text` marker, so coalescing them into one item would replay the summary as private
  // reasoning text. Python raises AdditionItemMismatch (`_add_text_reasoning_content`).
  const awaitedResponse = {
    id: 'resp_1',
    output: [
      {
        type: 'reasoning',
        id: 'rs_1',
        content: [{ type: 'reasoning_text', text: 'private thought' }],
        summary: [{ type: 'summary_text', text: 'public summary' }],
      },
    ],
  };

  const streamedEvents = [
    { type: 'response.reasoning_text.delta', item_id: 'rs_1', delta: 'private thought' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'public summary' },
    { type: 'response.completed', response: { id: 'resp_1', output: [] } },
  ];

  // Python pairs each private reasoning fragment with the summary that sits at the
  // same index, on *both* paths (`_chat_client.py:2648-2651` awaited, `:3138-3144` streamed).
  // Both paths here must carry that pairing, or a streamed transcript would carry metadata an
  // awaited one does not.
  it('pairs each private reasoning fragment with its summary in an awaited response', () => {
    const response = parseResponse(awaitedResponse);
    const [privateThought] = must(response.messages[0]).contents;
    expect(privateThought?.additionalProperties).toEqual({
      reasoning_text: true,
      summary: { type: 'summary_text', text: 'public summary' },
    });
  });

  it('pairs the summary the same way on the streamed path', () => {
    const updates = fold([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: awaitedResponse.output[0],
      },
    ]);
    expect(updates[0]?.contents[0]?.additionalProperties).toEqual({
      reasoning_text: true,
      summary: { type: 'summary_text', text: 'public summary' },
    });
  });

  it('keeps them as separate items in an awaited response', () => {
    const response = parseResponse(awaitedResponse);
    expect(reasoningShape(must(response.messages[0]).contents)).toEqual([
      { id: 'rs_1', text: 'private thought', protectedData: undefined, reasoningText: true },
      { id: 'rs_1', text: 'public summary', protectedData: undefined, reasoningText: undefined },
    ]);
  });

  it('produces the same transcript when streamed as when awaited', () => {
    const streamed = mergeChatUpdates(fold(streamedEvents));
    const awaited = parseResponse(awaitedResponse);
    expect(reasoningShape(must(streamed.messages[0]).contents)).toEqual(
      reasoningShape(must(awaited.messages[0]).contents),
    );
  });

  it('replays a streamed turn with the summary as summary_text, not as private reasoning text', () => {
    // The concrete harm: a merged item carries `reasoning_text: true`, so `prepareReasoningItems`
    // replays the whole concatenation as the model's private reasoning and the summary slot is
    // left empty.
    const response = mergeChatUpdates(
      fold([
        { type: 'response.reasoning_text.delta', item_id: 'rs_1', delta: 'private thought' },
        { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'public summary' },
        {
          type: 'response.output_item.done',
          item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' },
        },
        { type: 'response.completed', response: { id: 'resp_1', output: [] } },
      ]),
    );
    const items = toResponsesInput(response.messages);
    expect(items).toEqual([
      {
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'enc',
        summary: [{ type: 'summary_text', text: 'public summary' }],
        content: [{ type: 'reasoning_text', text: 'private thought' }],
      },
    ]);
  });
});

// Python surfaces log probabilities as response metadata rather than as transcript
// content (`_get_metadata_from_response`, `_chat_client.py:3414-3420`), merged into
// `additional_properties` on both the awaited response (`:2813`) and every streamed update
// (`:3388`).
describe('logprobs', () => {
  const LOGPROBS = [{ token: 'hi', logprob: -0.25, top_logprobs: [] }];

  it('reports the log probabilities of an awaited response as additionalProperties', () => {
    const response = parseResponse({
      id: 'resp_1',
      metadata: { tenant: 'acme' },
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'hi', logprobs: LOGPROBS }],
        },
      ],
    });
    expect(response.additionalProperties).toEqual({ tenant: 'acme', logprobs: LOGPROBS });
  });

  it('reports the log probabilities of a streamed delta on its update', () => {
    const [update] = fold([{ type: 'response.output_text.delta', delta: 'hi', logprobs: LOGPROBS }]);
    expect(update?.additionalProperties).toEqual({ logprobs: LOGPROBS });
  });

  it('reads them off the part on content_part.added, as Python does', () => {
    const [update] = fold([
      {
        type: 'response.content_part.added',
        part: { type: 'output_text', text: '', logprobs: LOGPROBS },
      },
    ]);
    expect(update?.additionalProperties).toEqual({ logprobs: LOGPROBS });
  });

  it('adds nothing when the request never asked for them', () => {
    const [update] = fold([{ type: 'response.output_text.delta', delta: 'hi', logprobs: [] }]);
    expect(update?.additionalProperties).toBeUndefined();
    expect(parseResponse({ id: 'resp_1', output: [] }).additionalProperties).toBeUndefined();
  });
});

// A failed response reports why: the API's `response.error` becomes an `error` content on the
// parsed response, so the failure diagnostic reaches the caller instead of being dropped. This
// mirrors .NET (MEAI `OpenAIResponsesChatClient`) and Go `responsesFailureContent`, which also
// substitute a generic message/code when the wire carries none.
describe('failed responses surface their error', () => {
  it('adds an error content to an awaited failed response', () => {
    const response = parseResponse({
      id: 'resp_1',
      status: 'failed',
      error: { code: 'server_error', message: 'The model blew up.' },
      output: [],
    });
    expect(contentsOf(response)).toContainEqual(
      expect.objectContaining({ type: 'error', message: 'The model blew up.', errorCode: 'server_error' }),
    );
  });

  it('falls back to a generic message and code when the failure carries none', () => {
    const response = parseResponse({ id: 'resp_1', status: 'failed', error: { message: '  ' }, output: [] });
    expect(contentsOf(response)).toContainEqual(
      expect.objectContaining({ type: 'error', message: 'The agent run failed.', errorCode: 'failed' }),
    );
  });

  it('surfaces a reported error even without the failed status', () => {
    const response = parseResponse({
      id: 'resp_1',
      status: 'completed',
      error: { code: 'rate_limit_exceeded', message: 'Rate limited.' },
      output: [],
    });
    expect(contentsOf(response)).toContainEqual(
      expect.objectContaining({ type: 'error', message: 'Rate limited.', errorCode: 'rate_limit_exceeded' }),
    );
  });

  it('adds the error to the response.failed stream event', () => {
    const updates = fold([
      {
        type: 'response.failed',
        response: {
          id: 'resp_1',
          status: 'failed',
          error: { code: 'server_error', message: 'The model blew up.' },
          output: [],
        },
      },
    ]);
    expect(updates.flatMap((update) => update.contents)).toContainEqual(
      expect.objectContaining({ type: 'error', message: 'The model blew up.', errorCode: 'server_error' }),
    );
  });

  it('adds nothing to a successful response', () => {
    const awaited = parseResponse({ id: 'resp_1', status: 'completed', output: [] });
    expect(contentsOf(awaited).some((content) => content.type === 'error')).toBe(false);
    const updates = fold([
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [] } },
    ]);
    expect(updates.flatMap((update) => update.contents).some((content) => content.type === 'error')).toBe(false);
  });
});

// Python maps `response.image_generation_call.partial_image` to the same
// call/result pair the finished item produces, with the preview marked so a consumer can tell the
// two apart (`_chat_client.py:3196-3222`). The event only exists when the caller asked for it via
// `partial_images` on the image generation tool.
describe('streamed partial images', () => {
  // A PNG header, so the media type is detected rather than defaulted.
  const PNG = 'iVBORw0KGgoAAAANSUhEUg==';

  it('surfaces a partial image as a marked image generation result', () => {
    const [update] = fold([
      {
        type: 'response.image_generation_call.partial_image',
        item_id: 'ig_1',
        partial_image_b64: PNG,
        partial_image_index: 0,
      },
    ]);
    expect(update?.contents).toEqual([
      { type: 'image_generation_tool_call', imageId: 'ig_1', rawRepresentation: expect.anything() },
      {
        type: 'image_generation_tool_result',
        imageId: 'ig_1',
        outputs: [
          {
            type: 'data',
            uri: `data:image/png;base64,${PNG}`,
            mediaType: 'image/png',
            additionalProperties: { partial_image_index: 0, is_partial_image: true },
            rawRepresentation: expect.anything(),
          },
        ],
        rawRepresentation: expect.anything(),
      },
    ]);
  });

  it('leaves the finished item unmarked so a preview is distinguishable from the result', () => {
    const [update] = fold([
      {
        type: 'response.output_item.done',
        item: { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: PNG },
      },
    ]);
    const result = update?.contents[1];
    expect(result?.type).toBe('image_generation_tool_result');
    expect((result as { outputs?: Content[] }).outputs?.[0]?.additionalProperties).toBeUndefined();
  });
});

// Python seeds every streamed update with the configured model and lets the
// terminal event overwrite it with the one the response reports (`_chat_client.py:3331`, `:3032`).
describe('model on streamed updates', () => {
  it('carries the configured model on non-terminal updates', () => {
    const updates = fold(
      [
        { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
        { type: 'response.output_text.delta', delta: 'hi' },
      ],
      { model: 'gpt-5' },
    );
    expect(updates.map((update) => update.model)).toEqual(['gpt-5', 'gpt-5']);
  });

  it('still lets the terminal event report the snapshot that actually ran', () => {
    const updates = fold(
      [
        { type: 'response.output_text.delta', delta: 'hi' },
        {
          type: 'response.completed',
          response: { id: 'resp_1', status: 'completed', model: 'gpt-5-2026-01-01', output: [] },
        },
      ],
      { model: 'gpt-5' },
    );
    expect(updates.at(-1)?.model).toBe('gpt-5-2026-01-01');
    expect(mergeChatUpdates(updates).model).toBe('gpt-5-2026-01-01');
  });

  it('reports no model when the endpoint is the one naming it', () => {
    const updates = fold([{ type: 'response.output_text.delta', delta: 'hi' }]);
    expect(updates[0]?.model).toBeUndefined();
  });
});

// An unmodelled item must keep its provider fields on the content item itself, not only in
// `rawRepresentation`: `serializeMessage` drops `rawRepresentation`, so otherwise the provider id
// and every provider-specific field would be gone from a persisted session.
// The assertions therefore run on the *serialized* shape, which is what a persisted session holds.
describe('unmodelled output items round-trip through serialization', () => {
  /** A future item type exercising a provider id, a nested object, an array and an explicit null. */
  const futureItem = {
    type: 'future_tool_call',
    id: 'ftc_abc123',
    status: 'completed',
    server: { label: 'docs', config: { retries: 2, nested: { deep: true } } },
    queries: ['alpha', 'beta', { refined: 'gamma' }],
    error: null,
  };

  it('keeps every unmodelled field of an awaited output item', () => {
    const response = parseResponse({ id: 'resp_1', status: 'completed', output: [futureItem] });

    expect(serializeMessage(must(response.messages[0])).contents).toEqual([futureItem]);
  });

  it('keeps every unmodelled field of a streamed output item', () => {
    const updates = fold([
      { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
      { type: 'response.output_item.done', output_index: 0, item: futureItem },
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [] } },
    ]);

    const merged = mergeChatUpdates(updates);
    expect(serializeMessage(must(merged.messages[0])).contents).toEqual([futureItem]);
  });

  it('restores the same content after a full JSON session round trip', () => {
    const response = parseResponse({ id: 'resp_1', status: 'completed', output: [futureItem] });
    const persisted = JSON.parse(JSON.stringify(serializeMessage(must(response.messages[0]))));

    const restored = deserializeMessage(persisted);
    expect(restored.contents[0]).toMatchObject({
      type: 'unknown',
      unknownType: 'future_tool_call',
      id: 'ftc_abc123',
      server: { label: 'docs', config: { retries: 2, nested: { deep: true } } },
      queries: ['alpha', 'beta', { refined: 'gamma' }],
      error: null,
    });
    expect(serializeMessage(restored).contents).toEqual([futureItem]);
  });

  it("uses core's empty-string sentinel when the item has no string type", () => {
    // `deserializeContent` writes `''` for a wire object whose `type` was not a string, so a value
    // that came off the wire and one restored from a snapshot have to agree. Stringifying the
    // non-string type instead invented a wire type (`7`) that no round trip could reproduce.
    const response = parseResponse({ output: [{ type: 7, payload: 1 }] });

    expect(response.messages[0]?.contents[0]).toMatchObject({
      type: 'unknown',
      unknownType: '',
      payload: 1,
    });
  });
});

describe('streamed hosted output and annotations', () => {
  it('attaches annotations streamed after the text they cite', () => {
    const state = createStreamParseState();
    const update = parseStreamEvent(
      {
        type: 'response.output_text.annotation.added',
        annotation: {
          type: 'url_citation',
          title: 'Docs',
          url: 'https://example/doc',
          start_index: 0,
          end_index: 4,
        },
      },
      state,
    );

    expect(update?.contents[0]).toMatchObject({
      type: 'text',
      text: '',
      annotations: [
        {
          type: 'citation',
          title: 'Docs',
          url: 'https://example/doc',
          annotatedRegions: [{ type: 'text_span', startIndex: 0, endIndex: 4 }],
        },
      ],
    });
  });

  it('reconstructs a hosted tool call from the finished output item', () => {
    const state = createStreamParseState();
    const update = parseStreamEvent(
      {
        type: 'response.output_item.done',
        item: {
          type: 'mcp_call',
          id: 'mcp_1',
          server_label: 'docs',
          name: 'search',
          arguments: '{}',
          output: 'ok',
        },
      },
      state,
    );

    expect(update?.contents.map((c) => c.type)).toEqual(['mcp_server_tool_call', 'mcp_server_tool_result']);
  });

  it('produces the same annotations streamed as awaited', () => {
    const awaited = parseResponse({
      id: 'resp_1',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Hello',
              annotations: [{ type: 'url_citation', url: 'https://example/doc', title: 'Docs' }],
            },
          ],
        },
      ],
    });

    const state = createStreamParseState();
    const streamed = [
      parseStreamEvent({ type: 'response.output_text.delta', delta: 'Hello' }, state),
      parseStreamEvent(
        {
          type: 'response.output_text.annotation.added',
          annotation: { type: 'url_citation', url: 'https://example/doc', title: 'Docs' },
        },
        state,
      ),
    ];

    const streamedAnnotations = streamed
      .flatMap((u) => u?.contents ?? [])
      .flatMap((c) => c.annotations ?? []);
    const awaitedAnnotations = contentsOf(awaited).flatMap((c) => c.annotations ?? []);

    expect(streamedAnnotations.map((a) => [a.title, a.url])).toEqual(
      awaitedAnnotations.map((a) => [a.title, a.url]),
    );
  });

  it('replays the citations of an assistant message instead of blanking them', () => {
    // Sending `annotations: []` for text that had citations drops them from the conversation the
    // model reads back, so a later turn cannot cite what it already cited.
    const messages: Message[] = [
      {
        role: 'assistant',
        contents: [
          {
            type: 'text',
            text: 'Agents are documented here.',
            annotations: [
              {
                type: 'citation',
                title: 'Docs',
                url: 'https://example/doc',
                annotatedRegions: [{ type: 'text_span', startIndex: 0, endIndex: 6 }],
              },
            ],
          },
        ],
      },
    ];

    const [message] = toResponsesInput(messages) as [WireMessage];
    expect(message.content[0]?.annotations).toEqual([
      {
        type: 'url_citation',
        url: 'https://example/doc',
        title: 'Docs',
        start_index: 0,
        end_index: 6,
      },
    ]);
  });

  it('folds a streamed annotation into the text it cites, matching the awaited shape', () => {
    // A streamed run and an awaited run must produce the same transcript. The
    // annotation arrives as its own event, so it has to end up merged into the text run rather
    // than left beside it as an empty content the caller has to know about.
    const awaited = parseResponse({
      id: 'resp_1',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Hello',
              annotations: [{ type: 'url_citation', url: 'https://example/doc', title: 'Docs' }],
            },
          ],
        },
      ],
    });

    const state = createStreamParseState();
    const updates = [
      parseStreamEvent({ type: 'response.output_text.delta', delta: 'Hel' }, state),
      parseStreamEvent({ type: 'response.output_text.delta', delta: 'lo' }, state),
      parseStreamEvent(
        {
          type: 'response.output_text.annotation.added',
          annotation: { type: 'url_citation', url: 'https://example/doc', title: 'Docs' },
        },
        state,
      ),
    ].filter((update) => update !== undefined);

    const streamed = contentsOf(mergeChatUpdates(updates));
    expect(streamed).toHaveLength(1);
    expect(streamed[0]).toMatchObject({ type: 'text', text: 'Hello' });
    expect(streamed[0]?.annotations).toHaveLength(1);
    expect(streamed.map((c) => [c.type, (c as { text?: string }).text])).toEqual(
      contentsOf(awaited).map((c) => [c.type, (c as { text?: string }).text]),
    );
  });

  it('emits the initial text of a streamed content part', () => {
    const state = createStreamParseState();
    const update = parseStreamEvent(
      { type: 'response.content_part.added', part: { type: 'output_text', text: '', annotations: [] } },
      state,
    );
    expect(update?.contents).toEqual([expect.objectContaining({ type: 'text', text: '' })]);
  });

  it('leaves a reasoning marker in a streamed transcript even without visible text', () => {
    // The awaited parse always emits a marker for a reasoning item; the streamed transcript has
    // to match so co-occurrence checks (reasoning next to tool calls) behave identically.
    const state = createStreamParseState();
    const update = parseStreamEvent(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', summary: [], content: [] },
      },
      state,
    );
    expect(update?.contents).toEqual([
      expect.objectContaining({ type: 'text_reasoning', id: 'rs_1', text: '' }),
    ]);
  });
});

describe('annotation round trips', () => {
  it('keeps container file citations replayable across a serialization boundary', () => {
    const parsed = parseResponse({
      id: 'resp_1',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'chart',
              annotations: [
                {
                  type: 'container_file_citation',
                  container_id: 'cntr_1',
                  file_id: 'cfile_1',
                  filename: 'chart.png',
                  start_index: 0,
                  end_index: 5,
                },
              ],
            },
          ],
        },
      ],
    });
    const [text] = contentsOf(parsed) as [TextContent];
    expect(text.annotations?.[0]).toMatchObject({
      type: 'citation',
      fileId: 'cfile_1',
      url: 'chart.png',
      additionalProperties: { container_id: 'cntr_1' },
    });

    // A session round trip drops rawRepresentation; the rebuild must keep the citation form
    // instead of degrading it to a plain file_citation.
    delete must(text.annotations?.[0]).rawRepresentation;
    const [message] = toResponsesInput([{ role: 'assistant', contents: [text] }]) as [WireMessage];
    expect(message.content[0]?.annotations).toEqual([
      {
        type: 'container_file_citation',
        container_id: 'cntr_1',
        file_id: 'cfile_1',
        filename: 'chart.png',
        start_index: 0,
        end_index: 5,
      },
    ]);
  });

  it('keeps the index of a file citation for replay', () => {
    const parsed = parseResponse({
      id: 'resp_1',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'doc',
              annotations: [{ type: 'file_citation', file_id: 'f_1', filename: 'a.pdf', index: 2 }],
            },
          ],
        },
      ],
    });
    const [text] = contentsOf(parsed) as [TextContent];
    expect(text.annotations?.[0]?.additionalProperties).toEqual({ index: 2 });

    delete must(text.annotations?.[0]).rawRepresentation;
    const [message] = toResponsesInput([{ role: 'assistant', contents: [text] }]) as [WireMessage];
    expect(message.content[0]?.annotations).toEqual([
      { type: 'file_citation', file_id: 'f_1', filename: 'a.pdf', index: 2 },
    ]);
  });

  it('fans a multi-region citation out into one wire annotation per region', () => {
    const [message] = toResponsesInput([
      {
        role: 'assistant',
        contents: [
          {
            type: 'text',
            text: 'ab',
            annotations: [
              {
                type: 'citation',
                url: 'https://example/doc',
                title: 'Docs',
                annotatedRegions: [
                  { type: 'text_span', startIndex: 0, endIndex: 1 },
                  { type: 'text_span', startIndex: 1, endIndex: 2 },
                ],
              },
            ],
          },
        ],
      },
    ]) as [WireMessage];

    expect(message.content[0]?.annotations).toEqual([
      { type: 'url_citation', url: 'https://example/doc', title: 'Docs', start_index: 0, end_index: 1 },
      { type: 'url_citation', url: 'https://example/doc', title: 'Docs', start_index: 1, end_index: 2 },
    ]);
  });
});
