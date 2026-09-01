import Anthropic from '@anthropic-ai/sdk';
import type { Content, Message } from '@polymind-inc/agent-framework-core';
import {
  Agent,
  ChatClientError,
  ConfigurationError,
  deserializeMessage,
  mergeChatUpdates,
  serializeContent,
  serializeMessage,
  textContent,
  tool,
  withFunctionInvocation,
} from '@polymind-inc/agent-framework-core';
import { arrayToStream } from '@polymind-inc/agent-framework-core/internal';
import { describe, expect, it } from 'vitest';
import { AnthropicChatClient, DEFAULT_BETA_FLAGS } from './chat-client.js';
import {
  createStreamParseState,
  parseContentBlocks,
  parseMessage,
  parseStreamEvent,
} from './from-anthropic.js';
import { toAnthropicMessages, toAnthropicSystem, toAnthropicToolChoice } from './to-anthropic.js';

/** A stand-in for `client.beta.messages`, scripted with whole responses or streams of events. */
class MockMessages {
  readonly requests: Array<Record<string, unknown>> = [];
  #turns: Array<unknown | unknown[]>;

  constructor(turns: Array<unknown | unknown[]>) {
    this.#turns = turns;
  }

  create(body: Record<string, unknown>): unknown {
    this.requests.push(body);
    const turn = this.#turns[Math.min(this.requests.length - 1, this.#turns.length - 1)];
    if (body.stream === true) {
      return arrayToStream(Array.isArray(turn) ? turn : []);
    }
    return Promise.resolve(turn);
  }
}

/**
 * A fake SDK client that only answers on the beta namespace.
 *
 * The GA `messages.create` throws: only `client.beta.messages` lifts the body-level `betas` into
 * the `anthropic-beta` header, so a request reaching the GA namespace is a wiring bug, not a
 * harmless detour.
 */
function fakeSdkClient(messages: MockMessages): unknown {
  return {
    beta: { messages },
    messages: {
      create: () => {
        throw new Error('GA messages namespace must not be called: requests go through beta.messages.');
      },
    },
  };
}

function clientWith(turns: Array<unknown | unknown[]>): {
  client: AnthropicChatClient;
  messages: MockMessages;
} {
  const messages = new MockMessages(turns);
  const client = new AnthropicChatClient({
    model: 'claude-sonnet-4-5',
    client: fakeSdkClient(messages) as never,
  });
  return { client, messages };
}

function message(text: string, options?: { id?: string; stopReason?: string }): Record<string, unknown> {
  return {
    id: options?.id ?? 'msg_1',
    model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text }],
    stop_reason: options?.stopReason ?? 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

describe('construction', () => {
  it('rejects an empty model with a ConfigurationError', () => {
    expect(() => new AnthropicChatClient({ model: '' })).toThrow(ConfigurationError);
  });

  it('reports the endpoint so telemetry can name the server it called', () => {
    // The endpoint verbatim, not its host: `server.address` is derived from this in one place, in
    // core, so every provider reports that attribute the same way.
    const client = new AnthropicChatClient({
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
      baseURL: 'https://anthropic.example.com/v1',
    });
    expect(client.metadata.providerUri).toBe('https://anthropic.example.com/v1');
  });

  it('rejects a blank MCP server label with a ConfigurationError', () => {
    const { client } = clientWith([]);
    expect(() => client.getMcpTool({ serverLabel: '  ', serverUrl: 'https://mcp.example/sse' })).toThrow(
      ConfigurationError,
    );
  });
});

describe('request mapping', () => {
  it('refuses a request that would carry no messages', () => {
    // A divergence this build chooses: the reference implementation sends the empty list and lets
    // the service answer. Pinned so the divergence stays deliberate rather than drifting back.
    const { client, messages } = clientWith([message('hi')]);

    expect(() => client.buildRequest([])).toThrow(ChatClientError);
    expect(messages.requests).toHaveLength(0);
  });

  it('maps the framework options onto the Messages API request', () => {
    const { client } = clientWith([message('hi')]);

    const request = client.buildRequest([{ role: 'user', contents: [textContent('hello')] }], {
      instructions: 'Be brief.',
      temperature: 0.3,
      topP: 0.9,
      topK: 40,
      maxTokens: 256,
      stop: ['STOP'],
      user: 'user-42',
      thinking: { type: 'enabled', budgetTokens: 2048 },
    });

    expect(request).toMatchObject({
      model: 'claude-sonnet-4-5',
      max_tokens: 256,
      system: 'Be brief.',
      temperature: 0.3,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ['STOP'],
      metadata: { user_id: 'user-42' },
      thinking: { type: 'enabled', budget_tokens: 2048 },
    });
  });

  it('defaults max_tokens, which the API requires', () => {
    const { client } = clientWith([message('hi')]);
    const request = client.buildRequest([{ role: 'user', contents: [textContent('hello')] }]);
    expect(request.max_tokens).toBe(1024);
  });

  it.each([
    { type: 'enabled' },
    { type: 'enabled', budgetTokens: 1023 },
    { type: 'enabled', budgetTokens: 2048.5 },
    { type: 'enabled', budgetTokens: Number.POSITIVE_INFINITY },
    { type: 'disabled', budgetTokens: 2048 },
  ])('rejects an invalid thinking configuration ($type, $budgetTokens)', (thinking) => {
    const { client } = clientWith([message('hi')]);
    expect(() =>
      client.buildRequest([{ role: 'user', contents: [textContent('hello')] }], {
        thinking: thinking as never,
      }),
    ).toThrow(ConfigurationError);
  });

  it('drops options the Messages API has no equivalent for', () => {
    const { client } = clientWith([message('hi')]);
    const request = client.buildRequest([{ role: 'user', contents: [textContent('hello')] }], {
      seed: 7,
      frequencyPenalty: 1,
      presencePenalty: 1,
      store: true,
      conversationId: 'conv_1',
    });
    for (const key of ['seed', 'frequency_penalty', 'presence_penalty', 'store', 'conversation_id']) {
      expect(request).not.toHaveProperty(key);
    }
  });

  it('concatenates instructions with a leading system message', () => {
    const messages: Message[] = [
      { role: 'system', contents: [textContent('From the transcript.')] },
      { role: 'user', contents: [textContent('hi')] },
    ];
    expect(toAnthropicSystem(messages, 'From the agent.')).toBe('From the agent.\n\nFrom the transcript.');
    // The system message is not repeated in the message list.
    expect(toAnthropicMessages(messages)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
  });

  it('converts function tools and routes MCP servers to their own field', () => {
    const { client } = clientWith([message('hi')]);
    const search = tool({
      name: 'search',
      description: 'Searches',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      execute: () => 'ok',
    });
    const request = client.buildRequest([{ role: 'user', contents: [textContent('hi')] }], {
      tools: [search, client.getMcpTool({ serverLabel: 'docs', serverUrl: 'https://mcp.example/sse' })],
      toolChoice: 'required',
    });

    expect(request.tools).toEqual([
      {
        type: 'custom',
        name: 'search',
        description: 'Searches',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]);
    expect(request.mcp_servers).toEqual([{ type: 'url', name: 'docs', url: 'https://mcp.example/sse' }]);
    expect(request.tool_choice).toEqual({ type: 'any' });
  });

  it('replaces spaces in the server label, as Python does', () => {
    // Messages API rejects a `mcp_servers[].name` containing spaces. Python's
    // `AnthropicClient.get_mcp_tool` normalises with `name.replace(" ", "_")`
    // (`_chat_client.py`), and the openai package already does the same.
    const { client } = clientWith([message('hi')]);
    const request = client.buildRequest([{ role: 'user', contents: [textContent('hi')] }], {
      tools: [client.getMcpTool({ serverLabel: 'my docs', serverUrl: 'https://mcp.example/sse' })],
    });

    expect(request.mcp_servers).toEqual([{ type: 'url', name: 'my_docs', url: 'https://mcp.example/sse' }]);
    // The hosted tool's own name is the normalised label too, so an approval keyed by it matches.
    expect(client.getMcpTool({ serverLabel: 'my docs', serverUrl: 'https://x' }).name).toBe('my_docs');
  });

  it('maps tool choice, approximating a multi-name requirement as any', () => {
    expect(toAnthropicToolChoice('auto')).toEqual({ type: 'auto' });
    expect(toAnthropicToolChoice('none')).toEqual({ type: 'none' });
    expect(toAnthropicToolChoice({ required: ['a'] })).toEqual({ type: 'tool', name: 'a' });
    expect(toAnthropicToolChoice({ required: ['a', 'b'] })).toEqual({ type: 'any' });
  });

  describe('tool choice independence', () => {
    const search = tool({
      name: 'search',
      description: 'Searches',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      execute: () => 'ok',
    });
    const prompt: Message[] = [{ role: 'user', contents: [textContent('hi')] }];

    it('sends a configured choice on a request that declares no tools at all', () => {
      const { client } = clientWith([message('hi')]);
      const request = client.buildRequest(prompt, { toolChoice: 'none' });

      expect(request.tool_choice).toEqual({ type: 'none' });
      expect(request).not.toHaveProperty('tools');
      expect(request).not.toHaveProperty('mcp_servers');
    });

    it('sends a configured choice on a request that declares only an MCP server', () => {
      const { client } = clientWith([message('hi')]);
      const request = client.buildRequest(prompt, {
        tools: [client.getMcpTool({ serverLabel: 'docs', serverUrl: 'https://mcp.example/sse' })],
        toolChoice: 'auto',
      });

      expect(request.tool_choice).toEqual({ type: 'auto' });
      expect(request).not.toHaveProperty('tools');
      expect(request.mcp_servers).toHaveLength(1);
    });

    it('sends a configured choice on a request that declares local tools', () => {
      const { client } = clientWith([message('hi')]);
      const request = client.buildRequest(prompt, {
        tools: [search],
        toolChoice: { required: ['search'] },
      });

      expect(request.tool_choice).toEqual({ type: 'tool', name: 'search' });
      expect(request.tools).toHaveLength(1);
    });

    it.each([
      { label: 'with local tools', tools: [search] },
      { label: 'without any tools', tools: undefined },
    ])('omits tool_choice when no choice was configured ($label)', ({ tools }) => {
      const { client } = clientWith([message('hi')]);
      const request = client.buildRequest(prompt, tools === undefined ? undefined : { tools });

      expect(request).not.toHaveProperty('tool_choice');
    });
  });

  it('sends structured output through output_config.format', () => {
    const { client } = clientWith([message('{}')]);
    const request = client.buildRequest([{ role: 'user', contents: [textContent('hi')] }], {
      responseFormat: { name: 'result', schema: { type: 'object', properties: { a: { type: 'string' } } } },
    });
    // Only `type` and `schema`: the API rejects a `name` here, and the strict decoder needs a
    // closed object (caught against the live API).
    expect(request.output_config).toEqual({
      format: {
        type: 'json_schema',
        schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
      },
    });
  });

  it('merges structured output into a caller-supplied output_config', () => {
    // `additionalProperties` is the only way to reach `output_config` (there is no typed
    // option for `effort`), so applying it *after* the format was computed replaced the whole
    // object and structured output silently stopped being requested. Python merges — it applies
    // caller kwargs first and only then sets `output_config["format"]`.
    const { client } = clientWith([message('{}')]);
    const request = client.buildRequest([{ role: 'user', contents: [textContent('hi')] }], {
      responseFormat: { name: 'result', schema: { type: 'object', properties: { a: { type: 'string' } } } },
      additionalProperties: { output_config: { effort: 'high' } },
    });

    expect(request.output_config).toEqual({
      effort: 'high',
      format: {
        type: 'json_schema',
        schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
      },
    });
  });

  it('still lets additionalProperties override the fields it always could', () => {
    // Only `output_config` is computed after the merge; everything else keeps losing to the
    // caller's escape hatch, as before.
    const { client } = clientWith([message('hi')]);
    const request = client.buildRequest([{ role: 'user', contents: [textContent('hi')] }], {
      temperature: 0.3,
      additionalProperties: { temperature: 0.9, top_k: 5 },
    });

    expect(request.temperature).toBe(0.9);
    expect(request.top_k).toBe(5);
  });

  it('refuses a request that would carry no messages', () => {
    const { client } = clientWith([message('hi')]);
    expect(() => client.buildRequest([])).toThrow(ChatClientError);
  });

  it('merges caller betas with the defaults without duplicates', () => {
    const { client } = clientWith([message('hi')]);
    const request = client.buildRequest([{ role: 'user', contents: [textContent('hi')] }], {
      betas: ['code-execution-2025-08-25', 'context-1m-2025-08-07'],
    });
    expect(request.betas).toEqual([
      'mcp-client-2025-04-04',
      'code-execution-2025-08-25',
      'context-1m-2025-08-07',
    ]);
  });
});

describe('beta namespace routing', () => {
  it('sends a plain request through beta.messages with the default beta flags', async () => {
    const { client, messages } = clientWith([message('hi')]);

    const response = await client.getResponse([{ role: 'user', contents: [textContent('hello')] }]);

    expect(response.text).toBe('hi');
    // The fake's GA namespace throws, so reaching here proves the beta namespace served the call —
    // and `betas` stays in the body, which is what beta.messages turns into the header.
    expect(messages.requests).toHaveLength(1);
    expect(messages.requests[0]?.betas).toEqual([...DEFAULT_BETA_FLAGS]);
  });

  it('sends an MCP request through beta.messages with the MCP flag present', async () => {
    const { client, messages } = clientWith([message('hi')]);

    await client.getResponse([{ role: 'user', contents: [textContent('hello')] }], {
      tools: [client.getMcpTool({ serverLabel: 'docs', serverUrl: 'https://mcp.example/sse' })],
    });

    const request = messages.requests[0];
    expect(request?.mcp_servers).toEqual([{ type: 'url', name: 'docs', url: 'https://mcp.example/sse' }]);
    // `mcp_servers` only works on the beta endpoint under this flag.
    expect(request?.betas).toContain('mcp-client-2025-04-04');
  });

  it('routes a streamed request through beta.messages too', async () => {
    const { client, messages } = clientWith([
      [
        {
          type: 'message_start',
          message: { id: 'msg_1', content: [], usage: { input_tokens: 1, output_tokens: 1 } },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      ],
    ]);

    const stream = client.getResponse([{ role: 'user', contents: [textContent('hello')] }]);
    for await (const _update of stream) {
      // drain
    }

    expect(messages.requests[0]).toMatchObject({ stream: true, betas: [...DEFAULT_BETA_FLAGS] });
  });
});

describe('message conversion', () => {
  it('carries non-object tool arguments under `raw` instead of erasing them', () => {
    // `tool_use.input` must be a JSON object on the wire; a replayed transcript can carry a
    // stringified array or scalar, and neither may pass through as `input`. Sending `{}` in their
    // place would read as a valid no-argument call for any tool whose parameters are optional.
    const calls: Message = {
      role: 'assistant',
      contents: [
        { type: 'function_call', callId: 'c1', name: 'search', arguments: '[]' },
        { type: 'function_call', callId: 'c2', name: 'search', arguments: '"text"' },
      ],
    };
    const results: Message = {
      role: 'tool',
      contents: [
        { type: 'function_result', callId: 'c1', result: 'a' },
        { type: 'function_result', callId: 'c2', result: 'b' },
      ],
    };

    expect(toAnthropicMessages([calls, results])[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'c1', name: 'search', input: { raw: [] } },
        { type: 'tool_use', id: 'c2', name: 'search', input: { raw: 'text' } },
      ],
    });
  });

  it('splits a mixed message into the roles the API requires', () => {
    const exchange: Message = {
      role: 'assistant',
      contents: [
        { type: 'function_call', callId: 'call_1', name: 'search', arguments: { q: 'x' } },
        { type: 'function_result', callId: 'call_1', result: 'found' },
      ],
    };

    expect(toAnthropicMessages([exchange])).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'found', is_error: false }],
      },
    ]);
  });

  it('appends a user turn when the transcript would end on an assistant message', () => {
    const converted = toAnthropicMessages([
      { role: 'user', contents: [textContent('hi')] },
      { role: 'assistant', contents: [textContent('hello')] },
    ]);
    expect(converted.at(-1)).toEqual({ role: 'user', content: 'Continue' });
  });

  describe('unanswered tool calls are dropped at send time', () => {
    // The Messages API refuses a transcript holding a `tool_use` with no `tool_result` — measured
    // 2026-08-31: "Each `tool_use` block must have a corresponding `tool_result` block." A
    // transcript legitimately reaches that state (an approval pause, the iteration limit, an
    // abandoned stream, a fatal middleware abort, a declaration-only tool handed back to the
    // caller), so the conversion removes the one block the API cannot accept instead of letting
    // the request fail — the same send-time filtering the OpenAI conversion applies.

    it('omits an unanswered call while keeping the rest of the transcript', () => {
      const messages: Message[] = [
        { role: 'user', contents: [textContent('hi')] },
        {
          role: 'assistant',
          contents: [
            textContent('let me check'),
            { type: 'function_call', callId: 'c1', name: 'search', arguments: { q: 'x' } },
          ],
        },
        { role: 'user', contents: [textContent('never mind')] },
      ];

      expect(toAnthropicMessages(messages)).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'let me check' }] },
        { role: 'user', content: [{ type: 'text', text: 'never mind' }] },
      ]);
    });

    it('keeps a call whose result arrives in a later message', () => {
      // The answered-call scan covers the whole transcript, not just the message holding the
      // call: the result living in the following tool message — the ordinary shape — must keep
      // the call on the wire.
      const converted = toAnthropicMessages([
        {
          role: 'assistant',
          contents: [{ type: 'function_call', callId: 'c1', name: 'search', arguments: { q: 'x' } }],
        },
        { role: 'tool', contents: [{ type: 'function_result', callId: 'c1', result: 'found' }] },
      ]);

      expect(converted[0]).toEqual({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'search', input: { q: 'x' } }],
      });
    });

    it('drops a trailing pending call and closes the transcript on a user turn', () => {
      // The pending call used to be left as the last turn; sending it is exactly the pairing the
      // API refuses, so the call is dropped and the assistant turn that held only that call
      // disappears with it.
      const converted = toAnthropicMessages([
        { role: 'user', contents: [textContent('hi')] },
        {
          role: 'assistant',
          contents: [{ type: 'function_call', callId: 'call_1', name: 'search', arguments: {} }],
        },
      ]);

      expect(converted).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    });

    it('drops both halves of an empty-callId exchange', () => {
      // An empty id is not an identity: the OpenAI conversion refuses to treat two '' as a pair,
      // and this conversion follows the same rule — for the result as much as the call, since a
      // `tool_result` whose call was omitted is the same unpairable shape from the other side.
      const converted = toAnthropicMessages([
        {
          role: 'assistant',
          contents: [{ type: 'function_call', callId: '', name: 'search', arguments: {} }],
        },
        { role: 'tool', contents: [{ type: 'function_result', callId: '', result: 'found' }] },
      ]);

      const blocks = converted.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
      expect(blocks).not.toContainEqual(expect.objectContaining({ type: 'tool_use' }));
      expect(blocks).not.toContainEqual(expect.objectContaining({ type: 'tool_result' }));
    });

    it('does not mutate the transcript it filters', () => {
      const call: Content = { type: 'function_call', callId: 'c1', name: 'search', arguments: {} };
      const messages: Message[] = [{ role: 'assistant', contents: [call] }];

      toAnthropicMessages(messages);

      expect(messages[0]?.contents).toEqual([call]);
    });
  });

  it('drops empty text, which the API rejects', () => {
    const converted = toAnthropicMessages([
      { role: 'user', contents: [textContent(''), textContent('real')] },
    ]);
    expect(converted).toEqual([{ role: 'user', content: [{ type: 'text', text: 'real' }] }]);
  });

  it('attaches a signature-only reasoning item to the thinking block before it', () => {
    const converted = toAnthropicMessages([
      {
        role: 'assistant',
        contents: [
          { type: 'text_reasoning', text: 'Let me think.' },
          { type: 'text_reasoning', protectedData: 'sig-abc' },
        ],
      },
      { role: 'user', contents: [textContent('go on')] },
    ]);
    expect(converted[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Let me think.', signature: 'sig-abc' }],
    });
  });

  it('sends images from data and uri content', () => {
    const contents: Content[] = [
      { type: 'data', uri: 'data:image/png;base64,AAAA', mediaType: 'image/png' },
      { type: 'uri', uri: 'https://example.com/a.png', mediaType: 'image/png' },
      { type: 'data', uri: 'data:application/pdf;base64,BBBB', mediaType: 'application/pdf' },
    ];
    const converted = toAnthropicMessages([{ role: 'user', contents }]);
    expect(converted[0]?.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
    ]);
  });

  it('marks a failed tool result as an error', () => {
    const converted = toAnthropicMessages([
      {
        role: 'tool',
        contents: [{ type: 'function_result', callId: 'c1', result: 'boom', exception: 'boom' }],
      },
    ]);
    expect(converted[0]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true },
    ]);
  });

  it('replays an unknown block verbatim', () => {
    const converted = toAnthropicMessages([
      {
        role: 'assistant',
        contents: [
          {
            type: 'unknown',
            unknownType: 'future_block',
            rawRepresentation: { type: 'future_block', payload: 1 },
          },
        ],
      },
      { role: 'user', contents: [textContent('next')] },
    ]);
    expect(converted[0]?.content).toEqual([{ type: 'future_block', payload: 1 }]);
  });

  it('replays an unknown block that has been through session persistence', () => {
    // `rawRepresentation` is dropped by serialization, so a transcript that
    // was persisted and restored reaches this converter with the unknown block's fields only. The
    // block used to be dropped silently, which loses the `redacted_thinking` payload the API needs
    // back to continue an extended-thinking turn.
    const block = { type: 'redacted_thinking', data: 'ENCRYPTED' };
    const parsed = parseContentBlocks([block]);
    const restored = deserializeMessage(
      JSON.parse(JSON.stringify(serializeMessage({ role: 'assistant', contents: parsed }))),
    );

    const converted = toAnthropicMessages([restored, { role: 'user', contents: [textContent('next')] }]);

    expect(converted[0]?.content).toEqual([block]);
  });

  it('does not invent a block for unknown content that never had a wire type', () => {
    // `unknownType: ''` is core's sentinel for "there was no string `type`" (`deserializeContent`).
    // Replaying it would put a literal `{type: ''}` on the wire; dropping it is what the raw-object
    // path did too, since it required a string `type` before pushing anything.
    const converted = toAnthropicMessages([
      { role: 'assistant', contents: [{ type: 'unknown', unknownType: '', payload: 1 }] },
      { role: 'user', contents: [textContent('next')] },
    ]);

    expect(converted).toEqual([{ role: 'user', content: [{ type: 'text', text: 'next' }] }]);
  });
});

describe('response parsing', () => {
  it('parses a complete message', () => {
    const response = parseMessage(message('hello', { id: 'msg_9', stopReason: 'max_tokens' }));
    expect(response.text).toBe('hello');
    expect(response.responseId).toBe('msg_9');
    expect(response.model).toBe('claude-sonnet-4-5');
    expect(response.finishReason).toBe('length');
    expect(response.usageDetails).toEqual({ inputTokenCount: 10, outputTokenCount: 5 });
  });

  it('extracts the same message fields from a complete response and message_start', () => {
    const wireMessage = {
      id: 'msg_shared',
      model: 'claude-sonnet-4-5',
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: 'same fields' }],
      usage: { input_tokens: 4, output_tokens: 2 },
    };
    const event = { type: 'message_start', message: wireMessage };

    const complete = parseMessage(wireMessage);
    const started = parseStreamEvent(event, createStreamParseState());
    const streamedContents = started?.contents.filter((content) => content.type !== 'usage');

    expect(started).toMatchObject({
      responseId: complete.responseId,
      model: complete.model,
      finishReason: complete.finishReason,
    });
    expect(streamedContents).toEqual(complete.messages[0]?.contents);
    expect(started?.contents.find((content) => content.type === 'usage')).toMatchObject({
      usageDetails: complete.usageDetails,
    });
    // The shared field parser must not erase the path-specific raw provider object.
    expect(complete.rawRepresentation).toBe(wireMessage);
    expect(started?.rawRepresentation).toBe(event);
  });

  it('maps cache counters onto the framework usage names', () => {
    const response = parseMessage({
      id: 'msg_1',
      content: [],
      usage: {
        input_tokens: 4,
        output_tokens: 2,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 3,
      },
    });
    expect(response.usageDetails).toEqual({
      inputTokenCount: 4,
      outputTokenCount: 2,
      cacheReadInputTokenCount: 7,
      cacheCreationInputTokenCount: 3,
    });
  });

  it('parses tool use, thinking and unknown blocks', () => {
    const contents = parseContentBlocks([
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } },
      { type: 'server_tool_use', id: 'call_2', name: 'web_search', input: {} },
      { type: 'future_block', payload: 1 },
    ]);
    expect(contents[0]).toMatchObject({ type: 'text_reasoning', text: 'hmm', protectedData: 'sig' });
    expect(contents[1]).toMatchObject({ type: 'function_call', callId: 'call_1', name: 'search' });
    expect(contents[2]).toMatchObject({ type: 'function_call', informationalOnly: true });
    expect(contents[3]).toMatchObject({ type: 'unknown', unknownType: 'future_block' });
  });

  it('maps Anthropic text citations to framework annotations', () => {
    const response = parseMessage({
      id: 'msg_citations',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Cited answer',
          citations: [
            {
              type: 'char_location',
              title: 'Source document',
              cited_text: 'supporting text',
              file_id: 'file-1',
              start_char_index: 4,
              end_char_index: 19,
            },
            {
              type: 'web_search_result_location',
              title: 'Web source',
              cited_text: 'web snippet',
              url: 'https://example.test/source',
            },
          ],
        },
      ],
    });

    expect(response.messages[0]?.contents[0]?.annotations).toEqual([
      expect.objectContaining({
        type: 'citation',
        title: 'Source document',
        snippet: 'supporting text',
        fileId: 'file-1',
        annotatedRegions: [{ type: 'text_span', startIndex: 4, endIndex: 19 }],
      }),
      expect.objectContaining({
        type: 'citation',
        title: 'Web source',
        snippet: 'web snippet',
        url: 'https://example.test/source',
      }),
    ]);
  });

  it('parses an MCP call and its result', () => {
    const contents = parseContentBlocks([
      { type: 'mcp_tool_use', id: 'c1', name: 'lookup', server_name: 'docs', input: { q: 'x' } },
      { type: 'mcp_tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'answer' }] },
    ]);
    expect(contents[0]).toMatchObject({
      type: 'mcp_server_tool_call',
      callId: 'c1',
      toolName: 'lookup',
      serverName: 'docs',
    });
    expect(contents[1]).toMatchObject({ type: 'mcp_server_tool_result', callId: 'c1' });
    expect((contents[1] as { output: Content[] }).output[0]).toMatchObject({ type: 'text', text: 'answer' });
  });

  it('parses redacted thinking as unknown content, preserving the raw block', () => {
    // The unmodelled fields sit at the top level, which is the shape `serializeContent`
    // turns back into the wire block (core `UnknownContent`: `type: 'unknown'` + `unknownType` +
    // every other field verbatim). Nesting them under a `data` key produced
    // `{type: 'redacted_thinking', data: {data: 'ENCRYPTED'}}` on serialization instead.
    const block = { type: 'redacted_thinking', data: 'ENCRYPTED' };
    const contents = parseContentBlocks([block]);
    expect(contents).toEqual([
      {
        type: 'unknown',
        unknownType: 'redacted_thinking',
        data: 'ENCRYPTED',
        rawRepresentation: block,
      },
    ]);
    expect(serializeContent(contents[0] as Content)).toEqual(block);
  });

  it('maps every stop reason', () => {
    const cases: Array<[string, string]> = [
      ['end_turn', 'stop'],
      ['stop_sequence', 'stop'],
      ['pause_turn', 'stop'],
      ['max_tokens', 'length'],
      ['tool_use', 'tool_calls'],
      ['refusal', 'content_filter'],
    ];
    for (const [stop, expected] of cases) {
      expect(parseMessage({ id: 'm', content: [], stop_reason: stop }).finishReason).toBe(expected);
    }
  });
});

describe('redacted thinking round trip', () => {
  /** What the API sent, and what the replay must reproduce block-for-block. */
  const wireBlocks = [
    { type: 'thinking', thinking: 'Let me think.', signature: 'sig-1' },
    { type: 'redacted_thinking', data: 'ENCRYPTED' },
    { type: 'text', text: 'Answer.' },
  ];

  it('replays an awaited response verbatim', () => {
    const response = parseMessage({
      id: 'msg_1',
      model: 'claude-sonnet-4-5',
      content: wireBlocks,
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const assistant = response.messages[0] as Message;
    expect(assistant.contents.map((c) => c.type)).toEqual(['text_reasoning', 'unknown', 'text']);
    expect(assistant.contents[1]).toMatchObject({ type: 'unknown', unknownType: 'redacted_thinking' });

    const replayed = toAnthropicMessages([assistant, { role: 'user', contents: [textContent('next')] }]);
    expect(replayed[0]).toEqual({
      role: 'assistant',
      content: [
        // The thinking block keeps its own signature; the encrypted blob never becomes one.
        { type: 'thinking', thinking: 'Let me think.', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'ENCRYPTED' },
        { type: 'text', text: 'Answer.' },
      ],
    });
  });

  it('replays a streamed response identically to the awaited one', async () => {
    const events = [
      {
        type: 'message_start',
        message: { id: 'msg_1', content: [], usage: { input_tokens: 1, output_tokens: 1 } },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'redacted_thinking', data: 'ENCRYPTED' },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Answer.' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ];
    const { client } = clientWith([events]);

    const stream = client.getResponse([{ role: 'user', contents: [textContent('hi')] }]);
    const updates = [];
    for await (const update of stream) {
      updates.push(update);
    }
    const folded = mergeChatUpdates(updates);

    const assistant = folded.messages[0] as Message;
    const replayed = toAnthropicMessages([assistant, { role: 'user', contents: [textContent('next')] }]);
    expect(replayed[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me think.', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'ENCRYPTED' },
        { type: 'text', text: 'Answer.' },
      ],
    });
  });
});

describe('streaming', () => {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        model: 'claude-sonnet-4-5',
        content: [],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    { type: 'message_stop' },
  ];

  it('folds a stream into the same transcript as an awaited call', async () => {
    const { client } = clientWith([events]);
    const stream = client.getResponse([{ role: 'user', contents: [textContent('hi')] }]);

    const updates = [];
    for await (const update of stream) {
      updates.push(update);
    }
    const folded = mergeChatUpdates(updates);

    expect(folded.text).toBe('Hello');
    expect(folded.responseId).toBe('msg_1');
    expect(folded.finishReason).toBe('stop');
    // Anthropic reports cumulative usage; the increments must sum back to the final total.
    expect(folded.usageDetails).toEqual({ inputTokenCount: 10, outputTokenCount: 5 });
  });

  it('turns cumulative usage snapshots into increments', () => {
    const state = createStreamParseState();
    const first = parseStreamEvent(events[0], state);
    const second = parseStreamEvent(events[5], state);
    const usageOf = (update: unknown): unknown =>
      (update as { contents: Content[] }).contents.find((c) => c.type === 'usage');
    expect(usageOf(first)).toMatchObject({ usageDetails: { inputTokenCount: 10, outputTokenCount: 1 } });
    expect(usageOf(second)).toMatchObject({ usageDetails: { inputTokenCount: 0, outputTokenCount: 4 } });
  });

  it('reassembles streamed tool-call arguments', async () => {
    const toolEvents = [
      {
        type: 'message_start',
        message: { id: 'msg_1', content: [], usage: { input_tokens: 1, output_tokens: 1 } },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_1', name: 'search', input: {} },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"x"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
    ];
    const { client } = clientWith([toolEvents]);

    const stream = client.getResponse([{ role: 'user', contents: [textContent('hi')] }]);
    for await (const _update of stream) {
      // drain, so the streaming transport is the one exercised
    }
    const response = await stream.finalResponse();

    const call = response.messages
      .flatMap((msg) => msg.contents)
      .find((content) => content.type === 'function_call');
    expect(call).toMatchObject({ callId: 'call_1', name: 'search', arguments: '{"q":"x"}' });
  });
});

describe('through the agent', () => {
  const weather = tool({
    name: 'get_weather',
    description: 'Gets the weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
    execute: (({ city }: { city: string }) => `${city}: sunny`) as never,
  });

  it('runs a full tool round', async () => {
    const { client, messages } = clientWith([
      {
        id: 'msg_1',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      message('Tokyo is sunny.'),
    ]);
    const agent = new Agent({ client, tools: [weather] });

    const response = await agent.run('weather in Tokyo?');

    expect(response.text).toBe('Tokyo is sunny.');
    expect(messages.requests).toHaveLength(2);
    // The second request replays the call and its result as the roles the API demands.
    const second = messages.requests[1]?.messages as Array<{ role: string; content: unknown }>;
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('still sends the pinned choice on the final round, after local tools are withdrawn', async () => {
    // The function-calling loop's last round withdraws local declarations and pins the choice to
    // `'none'`, so a request with a choice but no declarations is a shape this package produces on
    // its own — not a hypothetical.
    const { client, messages } = clientWith([
      {
        id: 'msg_1',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      message('Tokyo is sunny.'),
    ]);

    await withFunctionInvocation(client, { maxIterations: 1 }).getResponse(
      [{ role: 'user', contents: [textContent('weather in Tokyo?')] }],
      { tools: [weather] },
    );

    expect(messages.requests).toHaveLength(2);
    expect(messages.requests[1]).not.toHaveProperty('tools');
    expect(messages.requests[1]?.tool_choice).toEqual({ type: 'none' });
  });

  it('parses structured output', async () => {
    const { client } = clientWith([
      {
        id: 'msg_1',
        content: [{ type: 'text', text: '{"city":"Tokyo"}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    const agent = new Agent({ client });

    const response = await agent.run('where?', {
      responseFormat: { name: 'place', schema: { type: 'object', properties: { city: { type: 'string' } } } },
    });

    expect(response.value).toEqual({ city: 'Tokyo' });
  });

  it('surfaces a tool that needs approval instead of running it', async () => {
    const dangerous = tool({
      name: 'delete_all',
      description: 'Deletes everything',
      parameters: { type: 'object', properties: {} },
      approvalMode: 'always_require',
      execute: () => 'deleted',
    });
    const { client } = clientWith([
      {
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'call_1', name: 'delete_all', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    const agent = new Agent({ client, tools: [dangerous] });

    const response = await agent.run('clean up', { session: agent.createSession() });

    expect(response.userInputRequests).toHaveLength(1);
  });

  it('wraps SDK failures in ChatClientError', async () => {
    const failing = {
      beta: {
        messages: {
          create: () => Promise.reject(new Error('rate limited')),
        },
      },
    };
    const client = new AnthropicChatClient({ model: 'claude-sonnet-4-5', client: failing as never });

    await expect(client.getResponse([{ role: 'user', contents: [textContent('hi')] }])).rejects.toThrow(
      ChatClientError,
    );
  });
});

/**
 * Cancellation must reach the caller as an `AbortError` at every timing:
 * between pulls, while the SDK call is in flight, and while the SDK stream is being iterated.
 *
 * The shapes below are the ones the real SDK produces. `Anthropic.APIUserAbortError` does not set
 * `this.name` (@anthropic-ai/sdk `core/error.mjs`), so its `name` stays `"Error"`.
 */
describe('AnthropicChatClient cancellation', () => {
  const HI: Message[] = [{ role: 'user', contents: [textContent('hi')] }];

  function clientOf(create: () => unknown): AnthropicChatClient {
    return new AnthropicChatClient({
      model: 'claude-sonnet-4-5',
      client: { beta: { messages: { create } } } as never,
    });
  }

  it('surfaces a real APIUserAbortError from the request phase as AbortError', async () => {
    const controller = new AbortController();
    const client = clientOf(() => {
      controller.abort();
      return Promise.reject(new Anthropic.APIUserAbortError());
    });

    // Guard the premise: this is the object the SDK throws, and its name is not "AbortError".
    expect(new Anthropic.APIUserAbortError().name).toBe('Error');
    const failure = await client.getResponse(HI, { signal: controller.signal }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ name: 'AbortError' });
    expect(failure).not.toBeInstanceOf(ChatClientError);
  });

  it('surfaces an APIUserAbortError even when the caller passed no signal', async () => {
    const client = clientOf(() => Promise.reject(new Anthropic.APIUserAbortError()));

    await expect(client.getResponse(HI)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('surfaces an APIUserAbortError thrown mid-stream as AbortError', async () => {
    const controller = new AbortController();
    async function* aborting(): AsyncGenerator<unknown> {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'He' } };
      controller.abort();
      throw new Anthropic.APIUserAbortError();
    }
    const stream = clientOf(() => aborting()).getResponse(HI, { signal: controller.signal });

    await expect(async () => {
      for await (const _ of stream) {
        void _;
      }
    }).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not complete a turn whose SDK stream ended silently on abort', async () => {
    // @anthropic-ai/sdk's `Stream` checks the signal between chunks and *returns*, so the
    // truncated turn would otherwise fold into a normal response and be persisted as `completed`.
    const controller = new AbortController();
    async function* silentlyAborted(): AsyncGenerator<unknown> {
      yield {
        type: 'message_start',
        message: { id: 'msg_1', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 1 } },
      };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'He' } };
      controller.abort();
    }
    const stream = clientOf(() => silentlyAborted()).getResponse(HI, { signal: controller.signal });

    const seen: unknown[] = [];
    await expect(async () => {
      for await (const update of stream) {
        seen.push(update);
      }
    }).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen.length).toBeGreaterThan(0);
  });
});
