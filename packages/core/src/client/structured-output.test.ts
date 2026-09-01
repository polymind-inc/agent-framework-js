import { describe, expect, it } from 'vitest';
import { ChatClientError, StructuredOutputError } from '../errors.js';
import { textContent } from '../types/content.js';
import type { Message } from '../types/message.js';
import { chatResponse } from '../types/response.js';
import { applyStructuredOutput, resolveResponseFormat, withStructuredOutput } from './structured-output.js';
import { MockChatClient } from './test-support.js';

/** A minimal responseFormat with a Standard Schema validator. */
const schema = {
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate: (value: unknown) =>
      typeof value === 'object' && value !== null && 'name' in value
        ? { value: value as { name: string } }
        : { issues: [{ message: 'name is required' }] },
  },
  toJsonSchema: () => ({ type: 'object', properties: { name: { type: 'string' } } }),
};

/** A raw-JSON-schema format without a validator. */
const rawFormat = { toJsonSchema: () => ({ type: 'object' }) };

function textResponse(text: string): ReturnType<typeof chatResponse<unknown>> {
  return chatResponse<unknown>({
    messages: [{ role: 'assistant', contents: [textContent(text)] }],
  });
}

/** A response whose messages are given as `[role, text]` pairs, in order. */
function messagesResponse(pairs: [Message['role'], string][]): ReturnType<typeof chatResponse<unknown>> {
  return chatResponse<unknown>({
    messages: pairs.map(([role, text]) => ({ role, contents: [textContent(text)] })),
  });
}

describe('parse source', () => {
  it('reads the last assistant message, not every message joined', async () => {
    // A tool round leaves the model's first answer in the transcript. Joining the whole response
    // put that first answer ahead of the corrected one, and the caller was handed it silently.
    const response = await applyStructuredOutput(
      messagesResponse([
        ['assistant', '{"name":"Taro"}'],
        ['tool', '{"name":"Hanako"}'],
        ['assistant', '{"name":"Jiro"}'],
      ]),
      schema as never,
    );
    expect(response.value).toEqual({ name: 'Jiro' });
  });

  it('never reads a non-assistant message', async () => {
    // Asserting the message, not just the type: before this rule the user message parsed cleanly,
    // so a bare `ChatClientError` check would have passed for the wrong reason.
    await expect(
      applyStructuredOutput(
        messagesResponse([
          ['user', '{"name":"Taro"}'],
          ['tool', '{"name":"Hanako"}'],
        ]),
        schema as never,
      ),
    ).rejects.toThrow(/returned no text/);
  });

  it('skips a trailing assistant message that is blank', async () => {
    const response = await applyStructuredOutput(
      messagesResponse([
        ['assistant', '{"name":"Jiro"}'],
        ['assistant', '   \n '],
      ]),
      schema as never,
    );
    expect(response.value).toEqual({ name: 'Jiro' });
  });

  it('joins the text contents inside the message it chose', async () => {
    const response = await applyStructuredOutput(
      chatResponse<unknown>({
        messages: [{ role: 'assistant', contents: [textContent('{"name":'), textContent('"Jiro"}')] }],
      }),
      schema as never,
    );
    expect(response.value).toEqual({ name: 'Jiro' });
  });

  it('throws when the run produced no assistant text at all', async () => {
    await expect(
      applyStructuredOutput(messagesResponse([['user', 'anything']]), schema as never),
    ).rejects.toThrow(/returned no text/);
  });
});

describe('failure boundary', () => {
  /** The rejection of `applyStructuredOutput`, typed. */
  async function rejection(
    response: ReturnType<typeof chatResponse<unknown>>,
    format: unknown = schema,
  ): Promise<StructuredOutputError> {
    try {
      await applyStructuredOutput(response, format as never);
    } catch (error) {
      return error as StructuredOutputError;
    }
    throw new Error('expected a rejection');
  }

  it('reports every post-response failure as one type, keeping the answer reachable', async () => {
    // Four shapes, one boundary: unparseable text, a truncated answer, a validator that reported
    // issues, and a validator that threw instead of reporting them.
    const asyncThrowing = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async () => {
          throw new Error('lookup service is down');
        },
      },
      toJsonSchema: () => ({ type: 'object' }),
    };
    const cases: [string, ReturnType<typeof chatResponse<unknown>>, unknown][] = [
      ['not JSON', textResponse('not json at all'), schema],
      ['cut off', textResponse('{"name":"Ji'), schema],
      ['issues', textResponse('{"other":1}'), schema],
      ['validator threw', textResponse('{"name":"Jiro"}'), asyncThrowing],
    ];

    for (const [label, response, format] of cases) {
      const error = await rejection(response, format);
      expect(error, label).toBeInstanceOf(StructuredOutputError);
      // Still a ChatClientError, so code catching the old type keeps working.
      expect(error, label).toBeInstanceOf(ChatClientError);
      expect(error.response, label).toBe(response);
    }
  });

  it('carries the underlying failure on `cause`', async () => {
    const error = await rejection(textResponse('{"name":"Ji'));
    expect(error.cause).toBeInstanceOf(SyntaxError);

    const thrown = new Error('lookup service is down');
    const throwing = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async () => {
          throw thrown;
        },
      },
      toJsonSchema: () => ({ type: 'object' }),
    };
    expect((await rejection(textResponse('{"name":"Jiro"}'), throwing)).cause).toBe(thrown);
  });

  it('keeps the response out of anything that serializes the error', async () => {
    // A logger that writes a caught error would otherwise put the whole conversation in the line.
    const error = await rejection(textResponse('{"secret":"conversation text"}'));
    expect(Object.keys(error)).not.toContain('response');
    expect(JSON.stringify({ ...error })).not.toContain('conversation text');
    expect(error.response).toBeDefined();
  });

  it('leaves value unset on the response it hands back', async () => {
    const response = textResponse('{"other":1}');
    const error = await rejection(response);
    expect(error.response.value).toBeUndefined();
  });
});

describe('applyStructuredOutput', () => {
  it('parses and validates the response text into value', async () => {
    const response = await applyStructuredOutput(textResponse('{"name":"Taro"}'), schema as never);
    expect(response.value).toEqual({ name: 'Taro' });
  });

  it('reads only the first top-level JSON object, ignoring a second one (.NET parity)', async () => {
    // Some backends emit two top-level objects after a function call
    // (.NET AgentResponse{T}.DeserializeFirstTopLevelObject, AllowMultipleValues).
    const response = await applyStructuredOutput(
      textResponse('{"name":"Taro"}{"name":"Jiro"}'),
      schema as never,
    );
    expect(response.value).toEqual({ name: 'Taro' });
  });

  it('ignores trailing prose after the JSON value', async () => {
    const response = await applyStructuredOutput(
      textResponse('{"name":"Taro"}\nHope that helps!'),
      schema as never,
    );
    expect(response.value).toEqual({ name: 'Taro' });
  });

  it('still rejects leading prose, matching .NET', async () => {
    await expect(
      applyStructuredOutput(textResponse('Sure! {"name":"Taro"}'), schema as never),
    ).rejects.toThrow(ChatClientError);
  });

  it('throws when the model returned no text', async () => {
    await expect(applyStructuredOutput(textResponse(''), schema as never)).rejects.toThrow(
      /returned no text/,
    );
  });

  it('throws when the text is not JSON at all', async () => {
    await expect(applyStructuredOutput(textResponse('not json'), schema as never)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('throws when the parsed value fails schema validation', async () => {
    await expect(applyStructuredOutput(textResponse('{"other":1}'), schema as never)).rejects.toThrow(
      /failed schema validation/,
    );
  });

  it('skips a response suspended on a continuation token', async () => {
    const suspended = chatResponse<unknown>({
      messages: [{ role: 'assistant', contents: [textContent('working…')] }],
      continuationToken: { responseId: 'resp_1' },
    });
    const response = await applyStructuredOutput(suspended, schema as never);
    expect(response.value).toBeUndefined();
  });

  it('skips a response suspended on a pending approval request', async () => {
    const suspended = chatResponse<unknown>({
      messages: [
        {
          role: 'assistant',
          contents: [
            {
              type: 'function_approval_request',
              id: 'ficc_c1',
              functionCall: { type: 'function_call', callId: 'c1', name: 'wipe', arguments: '{}' },
            },
          ],
        },
      ],
    });
    const response = await applyStructuredOutput(suspended, schema as never);
    expect(response.value).toBeUndefined();
  });

  it('skips a response suspended on a pending OAuth consent request', async () => {
    const suspended = chatResponse<unknown>({
      messages: [
        {
          role: 'assistant',
          contents: [
            { type: 'oauth_consent_request', consentLink: 'https://consent', userInputRequest: true },
          ],
        },
      ],
    });
    const response = await applyStructuredOutput(suspended, schema as never);
    expect(response.value).toBeUndefined();
  });

  it('skips a response suspended on an unexecuted function call (declaration-only tool)', async () => {
    const suspended = chatResponse<unknown>({
      messages: [
        {
          role: 'assistant',
          contents: [{ type: 'function_call', callId: 'c1', name: 'caller_owned', arguments: '{}' }],
        },
      ],
    });
    const response = await applyStructuredOutput(suspended, schema as never);
    expect(response.value).toBeUndefined();
  });

  it('parses normally when every function call has its result', async () => {
    const completed = chatResponse<unknown>({
      messages: [
        {
          role: 'assistant',
          contents: [{ type: 'function_call', callId: 'c1', name: 'lookup', arguments: '{}' }],
        },
        { role: 'tool', contents: [{ type: 'function_result', callId: 'c1', result: 'ok' }] },
        { role: 'assistant', contents: [textContent('{"name":"Taro"}')] },
      ],
    });
    const response = await applyStructuredOutput(completed, schema as never);
    expect(response.value).toEqual({ name: 'Taro' });
  });

  it('parses normally when a pending call is informational only', async () => {
    const completed = chatResponse<unknown>({
      messages: [
        {
          role: 'assistant',
          contents: [
            { type: 'function_call', callId: 'c1', name: 'svc', arguments: '{}', informationalOnly: true },
            textContent('{"name":"Taro"}'),
          ],
        },
      ],
    });
    const response = await applyStructuredOutput(completed, schema as never);
    expect(response.value).toEqual({ name: 'Taro' });
  });
});

describe('withStructuredOutput', () => {
  it('fills value when the wrapped client is awaited', async () => {
    const mock = new MockChatClient([{ contents: [textContent('{"name":"Taro"}')], finishReason: 'stop' }]);
    const client = withStructuredOutput(mock);
    const response = await client.getResponse([{ role: 'user', contents: [textContent('hi')] }], {
      responseFormat: schema as never,
    });
    expect(response.value).toEqual({ name: 'Taro' });
  });

  it('fills value when the wrapped client is streamed', async () => {
    const mock = new MockChatClient([{ contents: [textContent('{"name":"Taro"}')], finishReason: 'stop' }]);
    const client = withStructuredOutput(mock);
    const stream = client.getResponse([{ role: 'user', contents: [textContent('hi')] }], {
      responseFormat: rawFormat as never,
    });
    const texts: string[] = [];
    for await (const update of stream) {
      texts.push(update.text);
    }
    expect(texts.join('')).toBe('{"name":"Taro"}');
    expect((await stream.finalResponse()).value).toEqual({ name: 'Taro' });
  });

  it('does not parse when the caller abandons the stream', async () => {
    // Same contract as `Agent.run`: `break` is the caller's decision to stop reading, not a model
    // failure, so it must not surface a parse error for text that was never finished.
    const mock = new MockChatClient([
      { contents: [textContent('{"na'), textContent('me":"Taro"}')], finishReason: 'stop' },
    ]);
    const client = withStructuredOutput(mock);
    const stream = client.getResponse([{ role: 'user', contents: [textContent('hi')] }], {
      responseFormat: rawFormat as never,
    });
    for await (const _ of stream) {
      break;
    }
    expect((await stream.finalResponse()).value).toBeUndefined();
  });

  it('passes through untouched when no responseFormat is set', async () => {
    const mock = new MockChatClient([{ contents: [textContent('plain')], finishReason: 'stop' }]);
    const client = withStructuredOutput(mock);
    const response = await client.getResponse([{ role: 'user', contents: [textContent('hi')] }]);
    expect(response.text).toBe('plain');
    expect(response.value).toBeUndefined();
  });
});

describe('resolveResponseFormat', () => {
  it('defaults to strict for every accepted form', () => {
    expect(resolveResponseFormat(schema as never).strict).toBe(true);
    expect(resolveResponseFormat(rawFormat as never).strict).toBe(true);
    expect(resolveResponseFormat({ name: 'person', schema: { type: 'object', properties: {} } }).strict).toBe(
      true,
    );
    expect(resolveResponseFormat({ name: 'person', schema: { type: 'object' }, strict: false }).strict).toBe(
      false,
    );
  });

  it('names an unnamed format after the schema root title', () => {
    const titled = { type: 'object', title: 'Person', properties: { name: { type: 'string' } } };
    expect(resolveResponseFormat(titled).name).toBe('Person');
    expect(resolveResponseFormat({ schema: titled }).name).toBe('Person');
    expect(resolveResponseFormat({ name: 'explicit', schema: titled }).name).toBe('explicit');
  });

  it('falls back to "response" when there is no usable title', () => {
    expect(resolveResponseFormat({ type: 'object', properties: {} }).name).toBe('response');
    expect(resolveResponseFormat({ type: 'object', title: '', properties: {} }).name).toBe('response');
    expect(resolveResponseFormat({ type: 'object', title: 7, properties: {} }).name).toBe('response');
  });

  it('keeps the schema object it was handed', () => {
    // Providers own whatever rewriting their wire format needs; resolution itself copies nothing.
    const raw = { type: 'object', properties: { name: { type: 'string' } } };
    expect(resolveResponseFormat(raw).schema).toBe(raw);
    expect(resolveResponseFormat({ name: 'person', schema: raw }).schema).toBe(raw);
  });
});
