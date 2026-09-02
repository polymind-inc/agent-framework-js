/**
 * Replaying provider-executed turns after a session round-trips through persistence.
 *
 * `rawRepresentation` is not serialized, so a restored transcript arrives with only the typed
 * contents. The conversion rebuilds the provider blocks from those — and for a turn whose typed
 * form captures everything the wire said, the rebuilt request must be *identical* to the one the
 * in-memory transcript produces from the raw blocks. These tests drive real wire fixtures through
 * the receive-side parser, serialize and restore the message, and compare both paths.
 */
import type { Message } from '@polymind-inc/agent-framework-core';
import { deserializeMessage, serializeMessage } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import { parseContentBlocks } from './from-anthropic.js';
import { toAnthropicMessages } from './to-anthropic.js';

/** An assistant turn as the receive side reports it, straight from wire blocks. */
function assistantTurn(blocks: readonly unknown[]): Message {
  return { role: 'assistant', contents: parseContentBlocks(blocks) };
}

/** The message after a session save and restore: same typed fields, no raw representations. */
function restored(msg: Message): Message {
  return deserializeMessage(JSON.parse(JSON.stringify(serializeMessage(msg))) as never);
}

const CODE_TURN = [
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'code_execution', input: { code: 'print(1)' } },
  {
    type: 'code_execution_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: {
      type: 'code_execution_result',
      stdout: 'ok\n',
      stderr: '',
      return_code: 0,
      content: [{ type: 'code_execution_output', file_id: 'file_1' }],
    },
  },
];

const CODE_STRING_INPUT_TURN = [
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'code_execution', input: 'print(1)' },
  {
    type: 'code_execution_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: { type: 'code_execution_result', stdout: '1\n', stderr: '', return_code: 0, content: [] },
  },
];

const CODE_MALFORMED_FILE_TURN = [
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'code_execution', input: { code: 'save()' } },
  {
    type: 'code_execution_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: {
      type: 'code_execution_result',
      stdout: '',
      stderr: '',
      return_code: 0,
      // The first entry names no file; the receive side preserves it as unknown content, and the
      // rebuilt payload must carry it back in place.
      content: [{ type: 'code_execution_output' }, { type: 'code_execution_output', file_id: 'file_1' }],
    },
  },
];

const BASH_MALFORMED_FILE_TURN = [
  { type: 'server_tool_use', id: 'srvtoolu_2', name: 'bash_code_execution', input: { command: 'make' } },
  {
    type: 'bash_code_execution_tool_result',
    tool_use_id: 'srvtoolu_2',
    content: {
      type: 'bash_code_execution_result',
      stdout: 'built\n',
      stderr: '',
      return_code: 0,
      content: [
        { type: 'bash_code_execution_output', file_id: 7 },
        { type: 'bash_code_execution_output', file_id: 'file_2' },
      ],
    },
  },
];

const CODE_ERROR_TURN = [
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'code_execution', input: { code: 'boom()' } },
  {
    type: 'code_execution_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: { type: 'code_execution_tool_result_error', error_code: 'unavailable' },
  },
];

const BASH_TURN = [
  { type: 'server_tool_use', id: 'srvtoolu_2', name: 'bash_code_execution', input: { command: 'ls' } },
  {
    type: 'bash_code_execution_tool_result',
    tool_use_id: 'srvtoolu_2',
    content: {
      type: 'bash_code_execution_result',
      stdout: 'a\nb\n',
      stderr: '',
      return_code: 0,
      content: [{ type: 'bash_code_execution_output', file_id: 'file_2' }],
    },
  },
];

const BASH_TIMEOUT_TURN = [
  { type: 'server_tool_use', id: 'srvtoolu_2', name: 'bash_code_execution', input: { command: 'sleep 999' } },
  {
    type: 'bash_code_execution_tool_result',
    tool_use_id: 'srvtoolu_2',
    content: { type: 'bash_code_execution_tool_result_error', error_code: 'execution_time_exceeded' },
  },
];

const EDITOR_VIEW_TURN = [
  {
    type: 'server_tool_use',
    id: 'srvtoolu_3',
    name: 'text_editor_code_execution',
    input: { command: 'view', path: '/tmp/a.txt' },
  },
  {
    type: 'text_editor_code_execution_tool_result',
    tool_use_id: 'srvtoolu_3',
    content: {
      type: 'text_editor_code_execution_view_result',
      content: 'hello world',
      file_type: 'text',
      start_line: 1,
      num_lines: 1,
    },
  },
];

const EDITOR_STR_REPLACE_TURN = [
  {
    type: 'server_tool_use',
    id: 'srvtoolu_3',
    name: 'text_editor_code_execution',
    input: { command: 'str_replace', path: '/tmp/a.txt', old_str: 'x', new_str: 'new line' },
  },
  {
    type: 'text_editor_code_execution_tool_result',
    tool_use_id: 'srvtoolu_3',
    content: {
      type: 'text_editor_code_execution_str_replace_result',
      lines: ['new line'],
      old_start: 5,
      old_lines: 1,
      new_start: 5,
      new_lines: 1,
    },
  },
];

const EDITOR_CREATE_TURN = [
  {
    type: 'server_tool_use',
    id: 'srvtoolu_3',
    name: 'text_editor_code_execution',
    input: { command: 'create', path: '/tmp/b.txt', file_text: 'x' },
  },
  {
    type: 'text_editor_code_execution_tool_result',
    tool_use_id: 'srvtoolu_3',
    content: { type: 'text_editor_code_execution_create_result', is_file_update: false },
  },
];

const EDITOR_ERROR_TURN = [
  {
    type: 'server_tool_use',
    id: 'srvtoolu_3',
    name: 'text_editor_code_execution',
    input: { command: 'view', path: '/nope' },
  },
  {
    type: 'text_editor_code_execution_tool_result',
    tool_use_id: 'srvtoolu_3',
    content: {
      type: 'text_editor_code_execution_tool_result_error',
      error_code: 'file_not_found',
      error_message: 'File not found: /nope',
    },
  },
];

describe('restored provider-executed turns', () => {
  it.each([
    ['code execution', CODE_TURN],
    ['code execution with a string input', CODE_STRING_INPUT_TURN],
    ['code execution with a malformed file entry', CODE_MALFORMED_FILE_TURN],
    ['code execution error', CODE_ERROR_TURN],
    ['bash with a malformed file entry', BASH_MALFORMED_FILE_TURN],
    ['bash', BASH_TURN],
    ['bash timeout', BASH_TIMEOUT_TURN],
    ['text editor view', EDITOR_VIEW_TURN],
    ['text editor str_replace', EDITOR_STR_REPLACE_TURN],
    ['text editor create', EDITOR_CREATE_TURN],
    ['text editor error', EDITOR_ERROR_TURN],
  ])('replays a restored %s turn identically to the in-memory one', (_label, blocks) => {
    const turn = assistantTurn(blocks);

    const inMemory = toAnthropicMessages([turn]);
    const replayed = toAnthropicMessages([restored(turn)]);

    // The in-memory path replays the exact wire blocks; matching it means the rebuilt request is
    // byte-equal to what the API sent, calls paired with their results included.
    expect(replayed).toEqual(inMemory);
    expect(inMemory).toEqual([{ role: 'assistant', content: blocks }]);
  });

  it('keeps using the raw block when it is present', () => {
    // The raw block is the exact bytes the provider sent; reconstruction is the fallback, not a
    // replacement. An extra field this build does not model must survive an in-memory replay.
    const marked = [{ ...CODE_TURN[0], extra_field: 'kept' }, CODE_TURN[1]];
    const [first] = toAnthropicMessages([assistantTurn(marked)]);

    expect(Array.isArray(first?.content) && first.content[0]).toMatchObject({ extra_field: 'kept' });
  });

  it('does not serialize rawRepresentation', () => {
    const serialized = JSON.stringify(serializeMessage(assistantTurn(CODE_TURN)));
    expect(serialized).not.toContain('rawRepresentation');
  });

  it('leaves an ordinary local tool exchange on the local mapping after a restore', () => {
    // The text-editor detection keys on a `function_result` answering a provider-executed call;
    // a result answering a local `function_call` must keep converting to a plain `tool_result`.
    const local: Message = {
      role: 'assistant',
      contents: [
        { type: 'function_call', callId: 'c1', name: 'search', arguments: { q: 'x' } },
        { type: 'function_result', callId: 'c1', result: 'found' },
      ],
    };

    expect(toAnthropicMessages([restored(local)])).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'search', input: { q: 'x' } }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'found', is_error: false }],
      },
    ]);
  });
});
