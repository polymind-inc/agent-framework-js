import type { OutputItem } from '@polymind-inc/agent-framework-agentserver';
import type { Message } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import {
  approvalResponseTarget,
  decodeFunctionOutput,
  encodeFunctionOutput,
  inputToMessages,
  itemToMessage,
  usageToResponseUsage,
} from './converters.js';

// The Responses wire is produced by arbitrary clients, not just this framework, so every read in
// the converters is guarded: fields can be missing, empty, or of the wrong type, and each of
// those forms has a defined mapping instead of a crash or a silently dropped turn. These tests
// pin the guards down one omitted field at a time.

/** Converts, then narrows away the undefined case with a clear failure. */
function messageOf(item: OutputItem): Message {
  const message = itemToMessage(item);
  if (message === undefined) throw new Error('expected a message');
  return message;
}

describe('function output codec fallbacks', () => {
  it('encodes a value JSON.stringify cannot represent as an empty string', () => {
    expect(encodeFunctionOutput(Symbol('opaque'))).toBe('""');
  });

  it('decodes an absent payload to an empty string', () => {
    expect(decodeFunctionOutput(undefined)).toBe('');
    expect(decodeFunctionOutput(null)).toBe('');
    expect(decodeFunctionOutput('')).toBe('');
  });

  it('stringifies a non-string payload from a legacy producer', () => {
    expect(decodeFunctionOutput(42)).toBe('42');
  });

  it('passes a string that is not valid JSON through unchanged', () => {
    expect(decodeFunctionOutput('{oops')).toBe('{oops');
  });
});

describe('message item content fallbacks', () => {
  it('replays a plain-string content as one text content', () => {
    const message = messageOf({ type: 'message', role: 'user', content: 'hello' });
    expect(message.contents).toEqual([expect.objectContaining({ type: 'text', text: 'hello' })]);
  });

  it('defaults a missing role to user and omits a missing message id', () => {
    const message = messageOf({ type: 'message', content: 'hello' });
    expect(message.role).toBe('user');
    expect(message.messageId).toBeUndefined();
  });

  it('replays a message whose content is neither string nor list as empty text', () => {
    const message = messageOf({ type: 'message', role: 'user', content: 42 });
    expect(message.contents).toEqual([expect.objectContaining({ type: 'text', text: '' })]);
  });

  it('falls back to the concatenated part text when no part is representable', () => {
    // The parts carry types the converter does not know, but their text is still the words the
    // model was shown; deleting the turn would be worse than replaying it flattened.
    const message = messageOf({
      type: 'message',
      role: 'user',
      content: [
        { type: 'mystery_part', text: 'kept ' },
        { type: 'other_part', refusal: 'and this' },
        { type: 'wordless_part' },
      ],
    });
    expect(message.contents).toEqual([expect.objectContaining({ type: 'text', text: 'kept and this' })]);
  });

  it('drops a file part with no url, id or data', () => {
    const message = messageOf({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_file' }, { type: 'input_text', text: 'still here' }],
    });
    expect(message.contents).toEqual([expect.objectContaining({ type: 'text', text: 'still here' })]);
  });

  it('maps a refusal part to text', () => {
    const message = messageOf({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'refusal', refusal: 'cannot help' }],
    });
    expect(message.contents).toEqual([expect.objectContaining({ type: 'text', text: 'cannot help' })]);
  });

  it('maps a summary_text part to text', () => {
    const message = messageOf({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'summary_text', text: 'the gist' }],
    });
    expect(message.contents).toEqual([expect.objectContaining({ type: 'text', text: 'the gist' })]);
  });

  it('keeps the declared media type of a data-URI image and generalises a plain URL', () => {
    const message = messageOf({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' },
        { type: 'input_image', image_url: 'https://img.example/cat' },
      ],
    });
    expect(message.contents[0]).toMatchObject({ mediaType: 'image/jpeg' });
    expect(message.contents[1]).toMatchObject({ uri: 'https://img.example/cat', mediaType: 'image/*' });
  });

  it('replays an image that only has a file id as a hosted file', () => {
    const message = messageOf({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', file_id: 'file_1' }, { type: 'input_image' }],
    });
    // The second, empty part is unrepresentable and drops out.
    expect(message.contents).toEqual([expect.objectContaining({ type: 'hosted_file', fileId: 'file_1' })]);
  });

  it('replays a file by url, by id with and without filename, and by raw base64 data', () => {
    const message = messageOf({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_file', file_url: 'https://files.example/doc.pdf' },
        { type: 'input_file', file_id: 'file_1', filename: 'doc.pdf' },
        { type: 'input_file', file_id: 'file_2' },
        { type: 'input_file', file_data: 'data:application/pdf;base64,AAAA' },
        { type: 'input_file', file_data: 'QUFBQQ==' },
      ],
    });
    expect(message.contents[0]).toMatchObject({ uri: 'https://files.example/doc.pdf' });
    expect(message.contents[1]).toMatchObject({
      type: 'hosted_file',
      fileId: 'file_1',
      additionalProperties: { filename: 'doc.pdf' },
    });
    expect(message.contents[2]).toMatchObject({ type: 'hosted_file', fileId: 'file_2' });
    expect(message.contents[2]?.additionalProperties).toBeUndefined();
    expect(message.contents[3]).toMatchObject({ mediaType: 'application/pdf' });
    // Bare base64 has no self-declared media type; it is wrapped as an opaque octet stream.
    expect(message.contents[4]).toMatchObject({
      type: 'data',
      uri: 'data:application/octet-stream;base64,QUFBQQ==',
      mediaType: 'application/octet-stream',
    });
  });
});

describe('call and result item fallbacks', () => {
  it('falls back to the item id, then empty, when a function call omits call_id', () => {
    expect(messageOf({ type: 'function_call', id: 'fc_1' }).contents[0]).toMatchObject({
      callId: 'fc_1',
      name: '',
      arguments: '',
    });
    expect(messageOf({ type: 'function_call' }).contents[0]).toMatchObject({ callId: '' });
  });

  it('passes structured function-call arguments through and blanks unusable ones', () => {
    const structured = messageOf({ type: 'function_call', call_id: 'c', arguments: { city: 'Osaka' } });
    expect(structured.contents[0]).toMatchObject({ arguments: { city: 'Osaka' } });
    const unusable = messageOf({ type: 'function_call', call_id: 'c', arguments: 42 });
    expect(unusable.contents[0]).toMatchObject({ arguments: '' });
  });

  it('maps a function_call_output without call_id to an empty one', () => {
    expect(messageOf({ type: 'function_call_output', output: '"ok"' }).contents[0]).toMatchObject({
      type: 'function_result',
      callId: '',
      result: 'ok',
    });
  });

  it('reads reasoning text from content when there is no summary', () => {
    const message = messageOf({
      type: 'reasoning',
      content: [{ type: 'reasoning_text', text: 'thought' }],
    });
    expect(message.contents[0]).toMatchObject({ type: 'text_reasoning', text: 'thought' });
    expect(message.contents[0]).not.toHaveProperty('id');
    expect(message.contents[0]).not.toHaveProperty('protectedData');
  });

  it('reads reasoning text from a plain-string summary', () => {
    const message = messageOf({ type: 'reasoning', summary: 'the gist' });
    expect(message.contents[0]).toMatchObject({ type: 'text_reasoning', text: 'the gist' });
  });

  it('maps a bare mcp_call with no output to the call alone', () => {
    const message = messageOf({ type: 'mcp_call' });
    expect(message.contents).toEqual([
      expect.objectContaining({ type: 'mcp_server_tool_call', callId: '', toolName: '', serverName: '' }),
    ]);
  });

  it('falls back to call_id when an mcp_call has an empty id', () => {
    const message = messageOf({ type: 'mcp_call', id: '', call_id: 'mc_1' });
    expect(message.contents[0]).toMatchObject({ callId: 'mc_1' });
  });

  it('maps a custom_tool_call_output without call_id or output to empty strings', () => {
    expect(messageOf({ type: 'custom_tool_call_output' }).contents[0]).toMatchObject({
      type: 'function_result',
      callId: '',
      result: '',
    });
  });

  it('stringifies a non-string custom tool output', () => {
    expect(messageOf({ type: 'custom_tool_call_output', output: 7 }).contents[0]).toMatchObject({
      result: '7',
    });
  });
});

describe('approval and consent item fallbacks', () => {
  it('does not replay an approval request without a server label', () => {
    expect(itemToMessage({ type: 'mcp_approval_request', id: 'apr_1' })).toBeUndefined();
  });

  it('replays a hosted approval request, defaulting its missing fields', () => {
    const message = messageOf({ type: 'mcp_approval_request', server_label: 'external' });
    expect(message.contents[0]).toMatchObject({
      type: 'function_approval_request',
      id: '',
      functionCall: expect.objectContaining({
        callId: '',
        name: '',
        arguments: '',
        additionalProperties: { server_label: 'external' },
      }),
    });
  });

  it('replays a consent request without a link as an empty one', () => {
    const message = messageOf({ type: 'oauth_consent_request' });
    expect(message.contents[0]).toMatchObject({ type: 'oauth_consent_request', consentLink: '' });
  });

  it('resolves an approval response, treating anything but approve:true as denial', () => {
    expect(approvalResponseTarget({ type: 'mcp_approval_response', approval_request_id: 'apr_1' })).toEqual({
      id: 'apr_1',
      approved: false,
    });
    expect(approvalResponseTarget({ type: 'mcp_approval_response' })).toBeUndefined();
    expect(approvalResponseTarget({ type: 'message' })).toBeUndefined();
  });
});

describe('shell item fallbacks', () => {
  it('maps a bare shell_call to an empty command list without a status', () => {
    const message = messageOf({ type: 'shell_call', id: 'sh_1' });
    expect(message.contents[0]).toMatchObject({ type: 'shell_tool_call', callId: 'sh_1', commands: [] });
    expect((message.contents[0] as { status?: string }).status).toBeUndefined();
  });

  it('keeps only the string commands of a shell_call action', () => {
    const message = messageOf({
      type: 'shell_call',
      call_id: 'sh_1',
      action: { commands: ['ls', 42, 'pwd'] },
    });
    expect(message.contents[0]).toMatchObject({ commands: ['ls', 'pwd'] });
  });

  it('maps a bare shell_call_output to an empty result', () => {
    const message = messageOf({ type: 'shell_call_output' });
    expect(message.contents[0]).toMatchObject({ type: 'shell_tool_result', callId: '', outputs: [] });
    expect((message.contents[0] as { maxOutputLength?: number }).maxOutputLength).toBeUndefined();
  });

  it('defaults the streams of an empty shell output entry and drops a non-numeric exit code', () => {
    const message = messageOf({
      type: 'shell_call_output',
      call_id: 'sh_1',
      output: [{}, { stdout: 'out', stderr: 'err', outcome: { exit_code: 'zero' } }],
    });
    const [result] = message.contents;
    if (result?.type !== 'shell_tool_result') throw new Error('expected a shell_tool_result');
    expect(result.outputs?.[0]).toMatchObject({ stdout: '', stderr: '' });
    expect(result.outputs?.[1]).toMatchObject({ stdout: 'out', stderr: 'err' });
    expect(result.outputs?.[1]).not.toHaveProperty('exitCode');
  });
});

describe('image generation item fallbacks', () => {
  it('omits the image id when the item has none', () => {
    const message = messageOf({ type: 'image_generation_call' });
    expect(message.contents[0]?.type).toBe('image_generation_tool_call');
    expect((message.contents[0] as { imageId?: string }).imageId).toBeUndefined();
  });
});

describe('usage and input fallbacks', () => {
  it('reports zeroes for usage that was never accumulated', () => {
    expect(usageToResponseUsage({})).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  it('maps an empty or unusable request input to no messages', () => {
    expect(inputToMessages('')).toEqual([]);
    expect(inputToMessages(42)).toEqual([]);
    expect(inputToMessages(undefined)).toEqual([]);
  });
});
