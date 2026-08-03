import { describe, expect, it } from 'vitest';
import { ChatClientError } from '../errors.js';
import { textContent } from '../types/content.js';
import { chatResponse } from '../types/response.js';
import { applyStructuredOutput, withStructuredOutput } from './structured-output.js';
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
