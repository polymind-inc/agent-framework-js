import type { FunctionCallContent, Message } from '@polymind-inc/agent-framework-core';
import {
  Agent,
  approvalResponse,
  ChatClientError,
  ConfigurationError,
  ContentFilterError,
  isApprovalRequest,
  NotImplementedError,
  textContent,
  tool,
} from '@polymind-inc/agent-framework-core';
import { arrayToStream } from '@polymind-inc/agent-framework-core/internal';
import OpenAI, { AzureOpenAI } from 'openai';
import { assert, describe, expect, it, vi } from 'vitest';
import { OpenAIChatClient } from './chat-client.js';

interface FakeOpenAI {
  responses: { create: ReturnType<typeof vi.fn> };
  baseURL: string;
}

/** The wire shape of a Responses input item, as far as these assertions read it. */
interface InputItem {
  type?: string;
  role?: string;
  id?: string;
  status?: string;
  call_id?: string;
  output?: string;
  content?: Array<Record<string, unknown>>;
}

function completedResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1_800_000_000,
    status: 'completed',
    model: 'gpt-4o-2024-11-20',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello!', annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 11,
      output_tokens: 3,
      total_tokens: 14,
      output_tokens_details: { reasoning_tokens: 1 },
    },
    ...overrides,
  };
}

function fakeClient(create: ReturnType<typeof vi.fn>, baseURL = 'https://api.openai.com/v1'): OpenAI {
  const fake: FakeOpenAI = { responses: { create }, baseURL };
  return fake as unknown as OpenAI;
}

/** A minimal non-empty transcript, for tests that only exercise other options. */
const HI: Message[] = [{ role: 'user', contents: [textContent('hi')] }];

describe('OpenAIChatClient request mapping', () => {
  const client = new OpenAIChatClient({ client: fakeClient(vi.fn()), model: 'gpt-4o' });

  it('maps a simple user message', () => {
    const request = client.buildRequest([{ role: 'user', contents: [textContent('hi')] }]);
    expect(request.model).toBe('gpt-4o');
    expect(request.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
  });

  it('renders assistant text as output_text with annotations', () => {
    const request = client.buildRequest([{ role: 'assistant', contents: [textContent('hi')] }]);
    expect((request.input as InputItem[])[0]?.content?.[0]).toEqual({
      type: 'output_text',
      text: 'hi',
      annotations: [],
    });
  });

  it('lifts function calls and results to top-level items', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        contents: [{ type: 'function_call', callId: 'call_1', name: 'get_weather', arguments: '{"a":1}' }],
      },
      { role: 'tool', contents: [{ type: 'function_result', callId: 'call_1', result: 'sunny' }] },
    ];
    expect(client.buildRequest(messages).input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        id: 'fc_call_1',
        name: 'get_weather',
        arguments: '{"a":1}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
    ]);
  });

  it('replays the provider-issued function-call id when present', () => {
    const request = client.buildRequest([
      {
        role: 'assistant',
        contents: [
          {
            type: 'function_call',
            callId: 'call_1',
            name: 'f',
            arguments: '{}',
            additionalProperties: { fc_id: 'fc_live', status: 'completed' },
          },
        ],
      },
      { role: 'tool', contents: [{ type: 'function_result', callId: 'call_1', result: 'ok' }] },
    ]);
    expect((request.input as InputItem[])[0]?.id).toBe('fc_live');
    // The item's status rides along, as Python replays it.
    expect((request.input as InputItem[])[0]?.status).toBe('completed');
  });

  it('does not replay a live fc_id on a message restored from history', () => {
    // A `_attribution` marker means the message came back from a history provider; its stored
    // fc_id belongs to a prior stored response and must not be re-sent as a live id (Python
    // `replays_local_storage`).
    const request = client.buildRequest([
      {
        role: 'assistant',
        additionalProperties: { _attribution: { sourceType: 'ChatHistory' } },
        contents: [
          {
            type: 'function_call',
            callId: 'call_1',
            name: 'f',
            arguments: '{}',
            additionalProperties: { fc_id: 'fc_live' },
          },
        ],
      },
      { role: 'tool', contents: [{ type: 'function_result', callId: 'call_1', result: 'ok' }] },
    ]);
    expect((request.input as InputItem[])[0]?.id).toBe('fc_call_1');
  });

  it('drops an orphan function call rather than sending an input the API rejects', () => {
    // The loop keeps orphan calls in the transcript (matching .NET/Go), so the wire
    // boundary is what protects the replay of that transcript.
    const request = client.buildRequest([
      { role: 'user', contents: [textContent('hi')] },
      {
        role: 'assistant',
        contents: [
          { type: 'function_call', callId: 'answered', name: 'f', arguments: '{}' },
          { type: 'function_call', callId: 'orphan', name: 'f', arguments: '{}' },
          textContent('done'),
        ],
      },
      { role: 'tool', contents: [{ type: 'function_result', callId: 'answered', result: 'ok' }] },
    ]);
    const input = request.input as InputItem[];
    expect(input.filter((item) => item.type === 'function_call').map((item) => item.call_id)).toEqual([
      'answered',
    ]);
    // The assistant's prose survives; only the unanswerable call is filtered.
    expect(input.some((item) => item.type === 'message' && item.role === 'assistant')).toBe(true);
  });

  it('replays reasoning only when it carries an opaque payload, and only once per id', () => {
    const request = client.buildRequest([
      {
        role: 'assistant',
        contents: [
          { type: 'text_reasoning', id: 'rs_1', text: 'summary only' },
          { type: 'text_reasoning', id: 'rs_2', text: 'a', protectedData: 'enc' },
          { type: 'text_reasoning', id: 'rs_2', text: 'b', protectedData: 'enc' },
        ],
      },
    ]);
    // The item is rebuilt whole: one entry per id, carrying every summary fragment (Python
    // `_prepare_reasoning_items_for_openai`).
    expect(request.input).toEqual([
      {
        type: 'reasoning',
        id: 'rs_2',
        summary: [
          { type: 'summary_text', text: 'a' },
          { type: 'summary_text', text: 'b' },
        ],
        encrypted_content: 'enc',
      },
    ]);
  });

  it('reconstructs reasoning text, summaries and status when replaying reasoning', () => {
    const request = client.buildRequest([
      {
        role: 'assistant',
        contents: [
          {
            type: 'text_reasoning',
            id: 'rs_1',
            text: 'thought',
            protectedData: 'enc',
            additionalProperties: { reasoning_text: true, status: 'completed' },
          },
          { type: 'text_reasoning', id: 'rs_1', text: 'summary' },
        ],
      },
    ]);
    expect(request.input).toEqual([
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'summary' }],
        encrypted_content: 'enc',
        status: 'completed',
        content: [{ type: 'reasoning_text', text: 'thought' }],
      },
    ]);
  });

  it('rejects a stateless replay of a tool call whose reasoning payload is missing', () => {
    // Sending the group anyway would fail with an opaque service 400; Python
    // `_validate_reasoning_groups_for_stateless_replay` fails fast instead.
    const messages: Message[] = [
      {
        role: 'assistant',
        contents: [
          { type: 'text_reasoning', id: 'rs_1', text: 'summary only' },
          { type: 'function_call', callId: 'call_1', name: 'f', arguments: '{}' },
        ],
      },
      { role: 'tool', contents: [{ type: 'function_result', callId: 'call_1', result: 'ok' }] },
    ];
    expect(() => client.buildRequest(messages)).toThrow(/encrypted reasoning/);
    // Under service-side storage the server replays its own items, so the same transcript is fine.
    expect(() => client.buildRequest(messages, { conversationId: 'resp_1' })).not.toThrow();
  });

  it('maps tools and tool choice', () => {
    const weather = tool({
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
      execute: async () => 'x',
    });
    const request = client.buildRequest(HI, { tools: [weather], toolChoice: { required: ['get_weather'] } });
    expect(request.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
          // Forced onto every function tool schema, matching Python `_prepare_tools_for_openai`.
          additionalProperties: false,
        },
        strict: false,
      },
    ]);
    expect(request.tool_choice).toEqual({ type: 'function', name: 'get_weather' });
  });

  it('omits tool_choice when there are no tools', () => {
    expect(client.buildRequest(HI, { toolChoice: 'required' }).tool_choice).toBeUndefined();
  });

  it('maps responseFormat to text.format', () => {
    const request = client.buildRequest(HI, {
      responseFormat: {
        name: 'person',
        schema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
        strict: true,
      },
    });
    expect(request.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'person',
        schema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
        strict: true,
      },
    });
  });

  it('closes a strict responseFormat schema the caller left open-ended', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: { type: 'object', properties: { city: { type: 'string' } } },
      },
    };
    const before = structuredClone(schema);

    const request = client.buildRequest(HI, { responseFormat: schema });

    expect(request.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'response',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            address: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
              additionalProperties: false,
            },
          },
          required: ['address', 'name'],
          additionalProperties: false,
        },
        strict: true,
      },
    });
    // Building the request must not write anything back into the caller's schema.
    expect(schema).toEqual(before);
  });

  it('leaves a non-strict responseFormat schema alone', () => {
    // An explicitly open map is a shape strict mode rejects, so this passes only while the
    // transform stays off the `strict: false` path.
    const schema = {
      type: 'object',
      properties: { tags: { type: 'object', additionalProperties: { type: 'string' } } },
    };
    const request = client.buildRequest(HI, {
      responseFormat: { name: 'loose', schema, strict: false },
    });
    expect(request.text).toEqual({
      format: { type: 'json_schema', name: 'loose', schema, strict: false },
    });
  });

  it('refuses a strict responseFormat schema strict mode cannot express', () => {
    expect(() =>
      client.buildRequest(HI, {
        responseFormat: {
          name: 'loose',
          schema: {
            type: 'object',
            properties: { tags: { type: 'object', additionalProperties: { type: 'string' } } },
          },
        },
      }),
    ).toThrow(/strict JSON schema at properties\/tags: additionalProperties must be false/);
  });

  it('names the format from a raw schema title unless the caller names it', () => {
    const schema = { type: 'object', title: 'Person', properties: { name: { type: 'string' } } };
    expect(
      (client.buildRequest(HI, { responseFormat: schema }).text as { format: { name: string } }).format.name,
    ).toBe('Person');
    expect(
      (
        client.buildRequest(HI, { responseFormat: { name: 'explicit', schema } }).text as {
          format: { name: string };
        }
      ).format.name,
    ).toBe('explicit');
  });

  it('routes conversationId to previous_response_id or conversation', () => {
    expect(client.buildRequest(HI, { conversationId: 'resp_9' }).previous_response_id).toBe('resp_9');
    expect(client.buildRequest(HI, { conversationId: 'conv_9' }).conversation).toBe('conv_9');
  });

  it('refuses a request whose input would be empty', () => {
    // Python raises ChatClientInvalidRequestException("Messages are required…"); an empty input
    // list only produces an opaque service 400.
    expect(() => client.buildRequest([])).toThrow(/Messages are required/);
  });

  it('maps audio input to input_audio and drops what the API cannot accept', () => {
    const request = client.buildRequest([
      {
        role: 'user',
        contents: [
          { type: 'data', uri: 'data:audio/wav;base64,AAAA', mediaType: 'audio/wav' },
          { type: 'data', uri: 'data:audio/mp3;base64,AAAA', mediaType: 'audio/mp3' },
          // Unsupported codec and text files have no Responses input form (Python drops both).
          { type: 'data', uri: 'data:audio/ogg;base64,AAAA', mediaType: 'audio/ogg' },
          { type: 'data', uri: 'data:text/plain;base64,AAAA', mediaType: 'text/plain' },
          textContent('see attachments'),
        ],
      },
    ]);
    const [message] = request.input as InputItem[];
    expect(message?.content).toEqual([
      { type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,AAAA', format: 'wav' } },
      { type: 'input_audio', input_audio: { data: 'data:audio/mp3;base64,AAAA', format: 'mp3' } },
      { type: 'input_text', text: 'see attachments' },
    ]);
  });

  it('treats a conversation passed through additionalProperties as service storage', () => {
    const messages: Message[] = [
      ...HI,
      {
        role: 'assistant',
        contents: [{ type: 'function_call', callId: 'call_1', name: 'f', arguments: '{}' }],
      },
      { role: 'tool', contents: [{ type: 'function_result', callId: 'call_1', result: 'ok' }] },
    ];
    const request = client.buildRequest(messages, { additionalProperties: { conversation: 'conv_1' } });
    // The server already holds the call; only the result pairs back, and no encrypted reasoning
    // needs to be requested (Python checks the same `conversation` key).
    expect((request.input as InputItem[]).map((item) => item.type)).toEqual([
      'message',
      'function_call_output',
    ]);
    expect(request.include).toBeUndefined();
    expect(request.conversation).toBe('conv_1');
  });

  it('treats the SDK conversation object form as service storage', () => {
    const messages: Message[] = [
      ...HI,
      {
        role: 'assistant',
        contents: [
          { type: 'function_call', callId: 'call_1', name: 'f', arguments: '{}' },
          { type: 'text_reasoning', id: 'rs_1', text: 'thinking', protectedData: 'enc' },
        ],
      },
      { role: 'tool', contents: [{ type: 'function_result', callId: 'call_1', result: 'ok' }] },
    ];
    const conversation = { id: 'conv_1' };

    const request = client.buildRequest(messages, { additionalProperties: { conversation } });

    expect((request.input as InputItem[]).map((item) => item.type)).toEqual([
      'message',
      'function_call_output',
    ]);
    expect(request.include).toBeUndefined();
    expect(request.conversation).toBe(conversation);
  });

  it('does not re-send items the service already holds when continuing a conversation', () => {
    const messages: Message[] = [
      { role: 'user', contents: [textContent('hi')] },
      {
        role: 'assistant',
        contents: [
          { type: 'function_call', callId: 'call_1', name: 'f', arguments: '{}' },
          { type: 'text_reasoning', id: 'rs_1', text: 'thinking', protectedData: 'enc' },
        ],
      },
      { role: 'tool', contents: [{ type: 'function_result', callId: 'call_1', result: 'ok' }] },
    ];

    // Without storage everything is replayed from our side.
    expect((client.buildRequest(messages).input as InputItem[]).map((item) => item.type)).toEqual([
      'message',
      'function_call',
      'reasoning',
      'function_call_output',
    ]);

    // With storage the server already has the server-identified items; only the result pairs back.
    const stored = client.buildRequest(messages, { conversationId: 'resp_9' }).input as InputItem[];
    expect(stored.map((item) => item.type)).toEqual(['message', 'function_call_output']);
    expect(stored[1]?.call_id).toBe('call_1');
  });

  it('requests encrypted reasoning only when the transcript is replayed from our side', () => {
    expect(client.buildRequest(HI).include).toEqual(['reasoning.encrypted_content']);
    expect(client.buildRequest(HI, { conversationId: 'conv_1' }).include).toBeUndefined();
  });

  // `include` is *computed*, so a raw pass-through that replaced it wholesale would silently disable
  // encrypted-reasoning replay. Python appends to whatever the caller supplied
  // (`_chat_client.py`), so the entry can never be lost.
  it('keeps encrypted reasoning in include even when additionalProperties supplies its own', () => {
    const request = client.buildRequest(HI, {
      additionalProperties: { include: ['message.output_text.logprobs'] },
    });
    expect(request.include).toEqual(['message.output_text.logprobs', 'reasoning.encrypted_content']);
  });

  it('lets additionalProperties replace the typed include list, then still appends', () => {
    const request = client.buildRequest(HI, {
      include: ['file_search_call.results'],
      additionalProperties: { include: ['message.output_text.logprobs'] },
    });
    expect(request.include).toEqual(['message.output_text.logprobs', 'reasoning.encrypted_content']);
  });

  it('does not append encrypted reasoning to a pass-through include under service storage', () => {
    const request = client.buildRequest(HI, {
      conversationId: 'conv_1',
      additionalProperties: { include: ['message.output_text.logprobs'] },
    });
    expect(request.include).toEqual(['message.output_text.logprobs']);
  });

  // Not every deployment behind a Responses endpoint supports encrypted reasoning, and a request
  // that asks for it is rejected outright there. The flag turns off the *implicit* request only.
  describe('with includeReasoningEncryptedContent: false', () => {
    const optedOut = new OpenAIChatClient({
      client: fakeClient(vi.fn()),
      model: 'gpt-4o',
      includeReasoningEncryptedContent: false,
    });

    it('leaves include off the request entirely', () => {
      expect('include' in optedOut.buildRequest(HI)).toBe(false);
    });

    it('keeps an unrelated include list intact', () => {
      expect(optedOut.buildRequest(HI, { include: ['file_search_call.results'] }).include).toEqual([
        'file_search_call.results',
      ]);
    });

    it('honours an explicit caller opt-in, through either include route', () => {
      expect(optedOut.buildRequest(HI, { include: ['reasoning.encrypted_content'] }).include).toEqual([
        'reasoning.encrypted_content',
      ]);
      expect(
        optedOut.buildRequest(HI, {
          additionalProperties: { include: ['reasoning.encrypted_content'] },
        }).include,
      ).toEqual(['reasoning.encrypted_content']);
    });

    // A raw `include` replaces the typed list wholesale, so with nothing adding the entry back an
    // explicit opt-in would be dropped by an unrelated pass-through — silently disabling the
    // replay of a reasoning model's transcript, which is what the opt-in exists for.
    it('keeps an explicit opt-in that additionalProperties replaced', () => {
      const request = optedOut.buildRequest(HI, {
        include: ['reasoning.encrypted_content'],
        additionalProperties: { include: ['file_search_call.results'] },
      });
      expect(request.include).toEqual(['file_search_call.results', 'reasoning.encrypted_content']);
    });

    it('keeps an explicit opt-in under service storage too', () => {
      const request = optedOut.buildRequest(HI, {
        conversationId: 'conv_1',
        include: ['reasoning.encrypted_content'],
        additionalProperties: { include: ['file_search_call.results'] },
      });
      expect(request.include).toEqual(['file_search_call.results', 'reasoning.encrypted_content']);
    });
  });

  it('passes additionalProperties through and lets rawRequestTransform have the last word', () => {
    const request = client.buildRequest(HI, {
      additionalProperties: { safety_identifier: 'abc' },
      rawRequestTransform: (req) => ({ ...req, model: 'overridden' }),
    });
    expect(request.safety_identifier).toBe('abc');
    expect(request.model).toBe('overridden');
  });
});

describe('OpenAIChatClient response mapping', () => {
  it('parses a non-streaming response', async () => {
    const create = vi.fn(async (_request?: Record<string, unknown>) => completedResponse());
    const client = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' });

    const response = await client.getResponse([{ role: 'user', contents: [textContent('hi')] }]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]?.stream).toBe(false);
    expect(response.text).toBe('Hello!');
    expect(response.responseId).toBe('resp_1');
    expect(response.model).toBe('gpt-4o-2024-11-20');
    expect(response.finishReason).toBe('stop');
    expect(response.createdAt).toBe(new Date(1_800_000_000_000).toISOString());
    expect(response.usageDetails).toEqual({
      inputTokenCount: 11,
      outputTokenCount: 3,
      totalTokenCount: 14,
      reasoningOutputTokenCount: 1,
      'openai.reasoning_tokens': 1,
    });
  });

  it('reports tool_calls as the finish reason when the model asked for a tool', async () => {
    const create = vi.fn(async (_request?: Record<string, unknown>) =>
      completedResponse({
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'f',
            arguments: '{}',
            status: 'completed',
          },
        ],
      }),
    );
    const client = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' });
    const response = await client.getResponse(HI);

    expect(response.finishReason).toBe('tool_calls');
    expect(response.messages[0]?.contents[0]).toMatchObject({
      type: 'function_call',
      callId: 'call_1',
      name: 'f',
    });
  });

  it('maps an incomplete response to a length finish reason', async () => {
    const create = vi.fn(async (_request?: Record<string, unknown>) =>
      completedResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    );
    const response = await new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' }).getResponse(
      HI,
    );
    expect(response.finishReason).toBe('length');
  });

  it('preserves unmodelled output items as unknown content', async () => {
    const create = vi.fn(async (_request?: Record<string, unknown>) =>
      completedResponse({ output: [{ type: 'brand_new_item', payload: 1 }] }),
    );
    const response = await new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' }).getResponse(
      HI,
    );
    expect(response.messages[0]?.contents[0]).toMatchObject({
      type: 'unknown',
      unknownType: 'brand_new_item',
    });
  });

  it('streams text deltas and folds usage from the completed event', async () => {
    const create = vi.fn(async (_request?: Record<string, unknown>) =>
      arrayToStream([
        { type: 'response.created', response: { id: 'resp_1' } },
        { type: 'response.output_text.delta', delta: 'Hel' },
        { type: 'response.output_text.delta', delta: 'lo!' },
        { type: 'response.completed', response: completedResponse() },
      ]),
    );
    const client = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' });

    const stream = client.getResponse(HI);
    const chunks: string[] = [];
    for await (const update of stream) {
      chunks.push(update.text);
    }

    expect(create.mock.calls[0]?.[0]?.stream).toBe(true);
    expect(chunks.join('')).toBe('Hello!');
    const final = await stream.finalResponse();
    expect(final.text).toBe('Hello!');
    expect(final.usageDetails?.inputTokenCount).toBe(11);
    expect(final.finishReason).toBe('stop');
  });

  it('assembles streamed function call arguments', async () => {
    const create = vi.fn(async (_request?: Record<string, unknown>) =>
      arrayToStream([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' },
        },
        { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"loc' },
        {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          item_id: 'fc_1',
          delta: 'ation":"Tokyo"}',
        },
        { type: 'response.completed', response: completedResponse({ output: [] }) },
      ]),
    );
    const stream = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' }).getResponse(HI);
    for await (const _ of stream) {
      void _;
    }
    const final = await stream.finalResponse();
    expect(final.messages[0]?.contents[0]).toMatchObject({
      type: 'function_call',
      callId: 'call_1',
      name: 'get_weather',
      arguments: '{"location":"Tokyo"}',
    });
  });

  it('emits reasoning payloads from output_item.done but not duplicate done text', async () => {
    const create = vi.fn(async (_request?: Record<string, unknown>) =>
      arrayToStream([
        { type: 'response.reasoning_text.delta', item_id: 'rs_1', delta: 'think' },
        { type: 'response.reasoning_text.done', item_id: 'rs_1', text: 'think' },
        {
          type: 'response.output_item.done',
          item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' },
        },
        { type: 'response.completed', response: completedResponse({ output: [] }) },
      ]),
    );
    const stream = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' }).getResponse(HI);
    for await (const _ of stream) {
      void _;
    }
    const final = await stream.finalResponse();
    const reasoning = final.messages[0]?.contents.filter((c) => c.type === 'text_reasoning');
    expect(reasoning).toHaveLength(1);
    expect(reasoning?.[0]).toMatchObject({ id: 'rs_1', text: 'think', protectedData: 'enc' });
  });

  it('releases the SSE stream at the terminal event instead of draining to the connection close', async () => {
    // Pins a WORKAROUND for a Foundry service defect: `/openai/v1/responses` holds the SSE
    // socket open for ~5 seconds after `response.completed` and never sends a `[DONE]` sentinel
    // (measured 2026-08-09, tail 5008±4ms across encodings), so an iterator that drains to the
    // connection close pays that tail on every round. Nothing meaningful can follow the terminal
    // event; stop pulling there. This test — and the `#untilTerminalEvent` wrapper it pins —
    // should be deleted once Foundry ends its streams promptly after the terminal event.
    let pulledPastTerminal = false;
    let closed = false;
    async function* heldOpen(): AsyncGenerator<unknown> {
      try {
        yield { type: 'response.created', response: { id: 'resp_1' } };
        yield { type: 'response.output_text.delta', delta: 'Hello!' };
        yield { type: 'response.completed', response: completedResponse() };
        pulledPastTerminal = true;
      } finally {
        closed = true;
      }
    }
    const create = vi.fn(async (_request?: Record<string, unknown>) => heldOpen());
    const stream = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' }).getResponse(HI);

    for await (const _ of stream) {
      void _;
    }

    const final = await stream.finalResponse();
    expect(final.text).toBe('Hello!');
    expect(final.finishReason).toBe('stop');
    // The pull after the terminal event is the one that would sit on the held-open socket.
    expect(pulledPastTerminal).toBe(false);
    expect(closed).toBe(true);
  });

  it('wraps a mid-stream failure in ChatClientError like a request failure', async () => {
    // The connection can drop long after `create` resolved; the error contract has to be the
    // same in both phases (Python wraps the whole iteration).
    async function* failing(): AsyncGenerator<unknown> {
      yield { type: 'response.output_text.delta', delta: 'He' };
      throw new Error('boom');
    }
    const create = vi.fn(async (_request?: Record<string, unknown>) => failing());
    const stream = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' }).getResponse(HI);

    await expect(async () => {
      for await (const _ of stream) {
        void _;
      }
    }).rejects.toThrow(ChatClientError);
  });
});

describe('OpenAIChatClient configuration', () => {
  it('reports the openai provider name by default and azure for Azure endpoints', () => {
    expect(new OpenAIChatClient({ client: fakeClient(vi.fn()), model: 'm' }).metadata.providerName).toBe(
      'openai',
    );
    expect(
      new OpenAIChatClient({
        client: fakeClient(vi.fn(), 'https://my-resource.openai.azure.com/openai/v1'),
        model: 'm',
      }).metadata.providerName,
    ).toBe('azure.ai.openai');
  });

  it('reports the endpoint so telemetry can name the server it called', () => {
    // The endpoint verbatim, not its host: `server.address` is derived from this in one place, in
    // core, so every provider reports that attribute the same way.
    const client = new OpenAIChatClient({
      client: fakeClient(vi.fn(), 'https://my-resource.openai.azure.com/openai/v1'),
      model: 'm',
    });
    expect(client.metadata.providerUri).toBe('https://my-resource.openai.azure.com/openai/v1');
  });

  it('recognizes an AzureOpenAI client by type, including subclasses behind a non-Azure gateway', () => {
    // The baseURL deliberately looks nothing like an Azure host: only the client type gives it away.
    const azureOptions = {
      baseURL: 'https://gateway.example.com/openai/v1',
      apiKey: 'k',
      apiVersion: 'preview',
    };
    expect(
      new OpenAIChatClient({ client: new AzureOpenAI(azureOptions), model: 'm' }).metadata.providerName,
    ).toBe('azure.ai.openai');

    class CustomAzureOpenAI extends AzureOpenAI {}
    expect(
      new OpenAIChatClient({ client: new CustomAzureOpenAI(azureOptions), model: 'm' }).metadata.providerName,
    ).toBe('azure.ai.openai');
  });

  it('declares conv_ conversation ids stable for the tool loop', () => {
    // The function-calling loop consults this predicate instead of knowing the id spelling
    // itself: a `conv_…` conversation object is a stable anchor, a `resp_…` chain advances.
    const stable = new OpenAIChatClient({ client: fakeClient(vi.fn()), model: 'm' }).metadata
      .stableConversationId;
    expect(stable).toBeDefined();
    expect(stable?.('conv_123')).toBe(true);
    expect(stable?.('resp_123')).toBe(false);
  });

  // Not a deferral: Chat Completions is out of scope for good (see `OpenAIChatClientConfigBase.api`).
  it('rejects the chat completions API', () => {
    expect(
      () => new OpenAIChatClient({ client: fakeClient(vi.fn()), model: 'm', api: 'chat_completions' }),
    ).toThrow(NotImplementedError);
  });

  it('requires a model unless the endpoint is declared to name one', () => {
    // Omitting `model` is a compile error for the ordinary config — the `@ts-expect-error` below
    // fails the build if that ever stops being true — and the runtime check backs it up for
    // JavaScript callers and `as` casts.
    // @ts-expect-error `model` is required without the endpointProvidesModel opt-in.
    expect(() => new OpenAIChatClient({ client: fakeClient(vi.fn()) })).toThrow(ConfigurationError);
    expect(() => new OpenAIChatClient({ client: fakeClient(vi.fn()), model: '' })).toThrow(
      ConfigurationError,
    );

    // The opt-in is the only way to get there, and it reports no model rather than a made-up one.
    const server = new OpenAIChatClient({ client: fakeClient(vi.fn()), endpointProvidesModel: true });
    expect(server.metadata.modelId).toBeUndefined();
  });

  it('omits model from the request body when the endpoint names what answers', () => {
    const client = new OpenAIChatClient({ client: fakeClient(vi.fn()), endpointProvidesModel: true });
    const request = client.buildRequest([{ role: 'user', contents: [textContent('hi')] }]);

    expect('model' in request).toBe(false);
  });

  it('starts no request until the stream is consumed', async () => {
    const create = vi.fn(async (_request?: Record<string, unknown>) => completedResponse());
    const client = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' });
    client.getResponse([{ role: 'user', contents: [textContent('hi')] }]);
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(create).not.toHaveBeenCalled();
  });
});

describe('Agent over OpenAIChatClient', () => {
  it('runs a full tool round trip', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        completedResponse({
          output: [
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'get_weather',
              arguments: '{"location":"Tokyo"}',
              status: 'completed',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        completedResponse({
          id: 'resp_2',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Tokyo is sunny.', annotations: [] }],
            },
          ],
        }),
      );

    const weather = tool({
      name: 'get_weather',
      description: 'Get the weather',
      parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
      execute: async ({ location }) => `${location} is sunny`,
    });

    const agent = new Agent({
      client: new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' }),
      instructions: 'Be helpful.',
      tools: [weather],
    });

    const response = await agent.run('weather in Tokyo?');

    expect(create).toHaveBeenCalledTimes(2);
    expect(response.text).toBe('Tokyo is sunny.');

    // The follow-up request replays the call and its result as top-level items.
    const secondInput = create.mock.calls[1]?.[0].input as InputItem[];
    expect(secondInput.map((item) => item.type)).toEqual([
      'message',
      'function_call',
      'function_call_output',
    ]);
    expect(secondInput[2]?.output).toBe('Tokyo is sunny');
    expect(create.mock.calls[1]?.[0].instructions).toBe('Be helpful.');
  });

  it('chains the response id and stops re-sending stored items across a tool round', async () => {
    // With service-side storage the server already holds every item of the previous response.
    // Re-sending them inline is the "Duplicate item found with id …" 400 (Python #3295), and
    // pointing at a stale `previous_response_id` loses the round that just happened.
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        completedResponse({
          id: 'resp_1',
          output: [
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'get_weather',
              arguments: '{"location":"Tokyo"}',
              status: 'completed',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        completedResponse({
          id: 'resp_2',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Tokyo is sunny.', annotations: [] }],
            },
          ],
        }),
      );

    const weather = tool({
      name: 'get_weather',
      description: 'Get the weather',
      parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
      execute: async ({ location }) => `${location} is sunny`,
    });
    const agent = new Agent({
      client: new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' }),
      tools: [weather],
    });
    const session = agent.createSession({ serviceSessionId: 'resp_0' });

    const response = await agent.run('weather in Tokyo?', { session });

    expect(response.text).toBe('Tokyo is sunny.');
    expect(create.mock.calls[0]?.[0].previous_response_id).toBe('resp_0');
    // Round two continues from the response round one produced, not from where the run started.
    expect(create.mock.calls[1]?.[0].previous_response_id).toBe('resp_1');

    // Only the tool result is sent inline; the call itself lives on the server already.
    const secondInput = create.mock.calls[1]?.[0].input as InputItem[];
    expect(secondInput.map((item) => item.type)).toEqual(['function_call_output']);
    expect(secondInput[0]?.call_id).toBe('call_1');
    // And the session follows along, so the *next* run continues from the latest turn too.
    expect(session.serviceSessionId).toBe('resp_2');
  });

  it('round-trips a hosted MCP approval back to the API', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        completedResponse({
          output: [
            {
              type: 'mcp_approval_request',
              id: 'mcpr_1',
              server_label: 'docs_mcp',
              name: 'search_docs',
              arguments: '{"q":"agents"}',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        completedResponse({
          id: 'resp_2',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Found three.', annotations: [] }],
            },
          ],
        }),
      );

    const agent = new Agent({
      client: new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' }),
    });
    const session = agent.createSession();

    const first = await agent.run('search the docs', { session });
    const requests = first.userInputRequests.filter(isApprovalRequest);
    expect(requests.map((request) => request.id)).toEqual(['mcpr_1']);

    const [request] = requests;
    assert.exists(request);
    const resumed = await agent.run(approvalResponse(request, true), { session });

    // The decision has to arrive as an `mcp_approval_response` item. Handling it locally would
    // answer the model with a "not found" tool result and leave the MCP server waiting forever.
    const secondInput = create.mock.calls[1]?.[0].input as InputItem[];
    expect(secondInput).toContainEqual({
      type: 'mcp_approval_response',
      approval_request_id: 'mcpr_1',
      approve: true,
    });
    expect(secondInput.some((item) => item.type === 'function_call_output')).toBe(false);
    expect(resumed.text).toBe('Found three.');
  });

  it('keeps framework-managed history across turns instead of switching to service-side storage', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(completedResponse())
      .mockResolvedValueOnce(completedResponse({ id: 'resp_2' }));

    const agent = new Agent({
      client: new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' }),
    });
    const session = agent.createSession();

    await agent.run('one', { session });
    await agent.run('two', { session });

    // A stored response id must not silently become a serviceSessionId; service-side
    // conversation state is a separate opt-in.
    expect(session.serviceSessionId).toBeUndefined();
    expect(create.mock.calls[1]?.[0].previous_response_id).toBeUndefined();
    const secondCall = create.mock.calls[1];
    assert.exists(secondCall);
    expect((secondCall[0].input as InputItem[]).map((item) => item.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('replays a JSON round-tripped session that still holds an unanswered call', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        completedResponse({
          output: [
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'book_flight',
              arguments: '{"to":"Tokyo"}',
              status: 'completed',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(completedResponse({ id: 'resp_2' }));

    // A declaration-only tool hands the call back to the caller instead of answering it, so turn
    // one ends with a call no result pairs with. Saving and restoring the session is what a
    // caller does between turns, and it must not turn that transcript into a failing request.
    const book = tool({
      name: 'book_flight',
      description: 'Book a flight',
      parameters: { type: 'object', properties: { to: { type: 'string' } } },
    });
    const agent = new Agent({
      client: new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' }),
      tools: [book],
    });
    const session = agent.createSession();
    await agent.run('book me a flight', { session });

    const restored = agent.deserializeSession(JSON.parse(JSON.stringify(session)));
    const stored = await agent.historyProvider.getMessages(
      restored,
      restored.partition(agent.historyProvider.sourceId),
    );
    const restoredCall = stored
      .flatMap((message) => message.contents)
      .find((content): content is FunctionCallContent => content.type === 'function_call');
    // The call is in the transcript the next turn replays, and it arrives there with no provider
    // object attached — serialization drops `rawRepresentation` — so whatever the wire conversion
    // does with it below, it does from the persisted fields alone.
    assert.exists(restoredCall);
    expect(restoredCall.callId).toBe('call_1');
    expect(restoredCall.rawRepresentation).toBeUndefined();

    const resumed = await agent.run('never mind, say hello', { session: restored });

    expect(resumed.text).toBe('Hello!');
    const secondInput = create.mock.calls[1]?.[0].input as InputItem[];
    expect(secondInput.some((item) => item.type === 'function_call')).toBe(false);
    // Both user turns reach the model; only the unanswerable call is missing.
    expect(secondInput.map((item) => [item.type, item.role])).toEqual([
      ['message', 'user'],
      ['message', 'user'],
    ]);
    expect(secondInput.flatMap((item) => item.content ?? []).map((part) => part.text)).toEqual([
      'book me a flight',
      'never mind, say hello',
    ]);
  });
});

describe('OpenAIChatClient background responses', () => {
  it('forces storage on for a background request', () => {
    const client = new OpenAIChatClient({ client: fakeClient(vi.fn()), model: 'gpt-4o' });
    const request = client.buildRequest(HI, { allowBackgroundResponses: true, store: false });

    expect(request.background).toBe(true);
    // Without storage the response could never be retrieved again.
    expect(request.store).toBe(true);
  });

  it('propagates the conversation id of a background response whose storage was forced on', async () => {
    // The wire request carried `store: true`, so the response is genuinely stored; parsing must
    // see the store flag that was sent, not the caller's original `store: false`.
    const create = vi.fn().mockResolvedValue(completedResponse({ id: 'resp_bg', status: 'in_progress' }));
    const client = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' });

    const response = await client.getResponse(HI, { allowBackgroundResponses: true, store: false });

    expect(create.mock.calls[0]?.[0].store).toBe(true);
    expect(response.conversationId).toBe('resp_bg');
  });

  it.each([
    {
      name: 'additionalProperties',
      options: { store: true, additionalProperties: { store: false } },
    },
    {
      name: 'rawRequestTransform',
      options: {
        store: true,
        rawRequestTransform: (request: Record<string, unknown>) => ({ ...request, store: false }),
      },
    },
  ])('parses service storage from the final request after $name', async ({ options }) => {
    const create = vi.fn().mockResolvedValue(completedResponse({ id: 'resp_not_stored' }));
    const client = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' });

    const response = await client.getResponse(HI, options);

    expect(create.mock.calls[0]?.[0].store).toBe(false);
    expect(response.conversationId).toBeUndefined();
  });

  it('offers a continuation token while a background response is still running', async () => {
    const create = vi.fn().mockResolvedValue(completedResponse({ id: 'resp_1', status: 'in_progress' }));
    const client = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' });

    const response = await client.getResponse([{ role: 'user', contents: [textContent('slow')] }], {
      allowBackgroundResponses: true,
    });

    expect(response.continuationToken).toEqual({ responseId: 'resp_1' });
  });

  it('retrieves rather than re-posts when resuming', async () => {
    const create = vi.fn();
    const retrieve = vi.fn().mockResolvedValue(completedResponse({ id: 'resp_1' }));
    const fake = { responses: { create, retrieve }, baseURL: 'https://api.openai.com/v1' };
    const client = new OpenAIChatClient({ client: fake as unknown as OpenAI, model: 'gpt-4o' });

    const response = await client.getResponse([], { continuationToken: { responseId: 'resp_1' } });

    expect(create).not.toHaveBeenCalled();
    expect(retrieve).toHaveBeenCalledWith('resp_1', undefined, undefined);
    expect(response.text).toBe('Hello!');
    expect(response.continuationToken).toBeUndefined();
  });

  it('refuses a continuation token it did not issue', () => {
    const client = new OpenAIChatClient({ client: fakeClient(vi.fn()), model: 'gpt-4o' });

    expect(() => client.getResponse([], { continuationToken: { foreign: 'x' } })).toThrow(
      /was not issued by it/,
    );
  });
});

describe('provider error mapping', () => {
  it('raises ContentFilterError for a content-filtered request', async () => {
    // The SDK reads `code` off the error body it was constructed with.
    const rejected = new OpenAI.BadRequestError(
      400,
      { code: 'content_filter', message: 'blocked' },
      'blocked',
      new Headers(),
    );
    const create = vi.fn().mockRejectedValue(rejected);
    const client = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' });

    await expect(client.getResponse(HI)).rejects.toThrow(ContentFilterError);
  });

  it('leaves other bad requests as plain ChatClientError', async () => {
    const create = vi.fn().mockRejectedValue(new Error('nope'));
    const client = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' });

    await expect(client.getResponse(HI)).rejects.toThrow(ChatClientError);
    await expect(client.getResponse(HI)).rejects.not.toThrow(ContentFilterError);
  });

  it('reports the Azure x-ms-served-model snapshot instead of the deployment alias', async () => {
    const promise = Promise.resolve(completedResponse({ model: 'gpt-5-nano' })) as Promise<unknown> & {
      withResponse?: () => Promise<unknown>;
    };
    promise.withResponse = async () => ({
      data: await promise,
      response: { headers: new Headers({ 'x-ms-served-model': 'gpt-5-nano-2025-08-07' }) },
    });
    const create = vi.fn().mockReturnValue(promise);
    const client = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-5-nano' });

    const response = await client.getResponse(HI);

    expect(response.model).toBe('gpt-5-nano-2025-08-07');
  });

  it('ignores an empty served-model header', async () => {
    const promise = Promise.resolve(completedResponse({ model: 'gpt-5-nano' })) as Promise<unknown> & {
      withResponse?: () => Promise<unknown>;
    };
    promise.withResponse = async () => ({
      data: await promise,
      response: { headers: new Headers({ 'x-ms-served-model': '  ' }) },
    });
    const create = vi.fn().mockReturnValue(promise);
    const client = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-5-nano' });

    expect((await client.getResponse(HI)).model).toBe('gpt-5-nano');
  });

  it('keeps an unmodelled streamed output item as unknown content', async () => {
    const create = vi.fn().mockResolvedValue(
      arrayToStream([
        { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'future_tool_call', id: 'ft_1', payload: 42 },
        },
        { type: 'response.completed', response: { ...completedResponse(), output: [] } },
      ]),
    );
    const client = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' });

    const updates = [];
    for await (const update of client.getResponse(HI)) {
      updates.push(update);
    }

    const unknown = updates
      .flatMap((update) => update.contents)
      .find((content) => content.type === 'unknown');
    expect(unknown).toMatchObject({ type: 'unknown', unknownType: 'future_tool_call' });
  });

  it('does not duplicate items the stream already reconstructed from deltas', async () => {
    const create = vi.fn().mockResolvedValue(
      arrayToStream([
        { type: 'response.output_text.delta', delta: 'hi', item_id: 'msg_1', output_index: 0 },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
        },
        { type: 'response.completed', response: { ...completedResponse(), output: [] } },
      ]),
    );
    const client = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' });

    const stream = client.getResponse(HI);
    for await (const _update of stream) {
      // drain, so the streaming transport is the one exercised
    }

    expect((await stream.finalResponse()).text).toBe('hi');
  });

  it('forwards a stored image by file_id', () => {
    const client = new OpenAIChatClient({ client: fakeClient(vi.fn()), model: 'gpt-4o' });
    const request = client.buildRequest([
      {
        role: 'user',
        contents: [
          {
            type: 'uri',
            uri: 'https://example.com/a.png',
            mediaType: 'image/png',
            additionalProperties: { file_id: 'file-123' },
          },
        ],
      },
    ]);

    const input = request.input as Array<{ content: Array<Record<string, unknown>> }>;
    expect(input[0]?.content[0]).toMatchObject({ type: 'input_image', file_id: 'file-123' });
  });

  it('omits image_url when an image is carried only by file_id', () => {
    const client = new OpenAIChatClient({ client: fakeClient(vi.fn()), model: 'gpt-4o' });
    const request = client.buildRequest([
      {
        role: 'user',
        contents: [
          {
            type: 'uri',
            uri: '',
            mediaType: 'image/png',
            additionalProperties: { file_id: 'file-123' },
          },
        ],
      },
    ]);

    // An empty `image_url` is rejected by the service ("Expected a valid URL"), so the key is left
    // out entirely rather than sent blank.
    const input = request.input as Array<{ content: Array<Record<string, unknown>> }>;
    expect(input[0]?.content[0]).toEqual({ type: 'input_image', detail: 'auto', file_id: 'file-123' });
  });
});

/**
 * Cancellation must reach the caller as an `AbortError`, whichever of the
 * three timings it lands on: between pulls, while the SDK call is in flight, or while the SDK
 * stream is being iterated.
 *
 * These tests use the shapes the *real* SDK produces. `OpenAI.APIUserAbortError` never sets
 * `this.name` (openai@7 `core/error.mjs`), so its `name` is `"Error"` — a classifier keyed on the
 * name alone silently misses every real interruption.
 */
describe('OpenAIChatClient cancellation', () => {
  it('surfaces a real APIUserAbortError from the request phase as AbortError', async () => {
    const controller = new AbortController();
    const create = vi.fn(() => {
      controller.abort();
      return Promise.reject(new OpenAI.APIUserAbortError());
    });
    const client = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' });

    // Guard the premise: this is the object the SDK throws, and its name is not "AbortError".
    expect(new OpenAI.APIUserAbortError().name).toBe('Error');
    const failure = await client.getResponse(HI, { signal: controller.signal }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ name: 'AbortError' });
    expect(failure).not.toBeInstanceOf(ChatClientError);
  });

  it('surfaces an APIUserAbortError even when the caller passed no signal', async () => {
    const create = vi.fn(() => Promise.reject(new OpenAI.APIUserAbortError()));
    const client = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' });

    await expect(client.getResponse(HI)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('surfaces an APIUserAbortError thrown mid-stream as AbortError', async () => {
    const controller = new AbortController();
    async function* aborting(): AsyncGenerator<unknown> {
      yield { type: 'response.output_text.delta', delta: 'He' };
      controller.abort();
      throw new OpenAI.APIUserAbortError();
    }
    const create = vi.fn(async () => aborting());
    const stream = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' }).getResponse(HI, {
      signal: controller.signal,
    });

    await expect(async () => {
      for await (const _ of stream) {
        void _;
      }
    }).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not complete a turn whose SDK stream ended silently on abort', async () => {
    // openai's `Stream` checks the signal between chunks and *returns* — the iteration ends
    // without an error, so a truncated turn would otherwise be folded into a normal response and
    // persisted as `completed`.
    const controller = new AbortController();
    async function* silentlyAborted(): AsyncGenerator<unknown> {
      yield { type: 'response.output_text.delta', delta: 'He' };
      controller.abort();
    }
    const create = vi.fn(async () => silentlyAborted());
    const stream = new OpenAIChatClient({ client: fakeClient(create), model: 'gpt-4o' }).getResponse(HI, {
      signal: controller.signal,
    });

    const seen: unknown[] = [];
    await expect(async () => {
      for await (const update of stream) {
        seen.push(update);
      }
    }).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toHaveLength(1);
  });
});
