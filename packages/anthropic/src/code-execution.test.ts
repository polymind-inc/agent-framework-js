import type { ChatResponseUpdate, Content, Message } from '@polymind-inc/agent-framework-core';
import { mergeChatUpdates, serializeContent } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import {
  createStreamParseState,
  parseContentBlocks,
  parseMessage,
  parseStreamEvent,
} from './from-anthropic.js';
import { toAnthropicMessages } from './to-anthropic.js';

// Anthropic's code-execution beta answers with a family of blocks the generic rules cannot read:
// the call announcing the run, and the code-execution / bash / text-editor results answering it.
// These tests pin each variant to the typed content the framework already models.

/** Reads a block through the complete-message path. */
function parseBlock(block: unknown): Content[] {
  return parseContentBlocks([block]);
}

/** The single content one block maps to. */
function onlyContent(block: unknown): Content {
  const contents = parseBlock(block);
  expect(contents).toHaveLength(1);
  return contents[0] as Content;
}

/** The `outputs` of a hosted tool result. */
function outputsOf(content: Content): Content[] {
  return (content as { outputs?: Content[] }).outputs ?? [];
}

/** The `result` of the function result a text-editor block maps to. */
function resultOf(content: Content): Content[] {
  return (content as { result?: Content[] }).result ?? [];
}

describe('code-execution tool calls', () => {
  it.each([['tool_use'], ['server_tool_use']])(
    'maps a %s block whose name identifies code execution to a code interpreter call',
    (blockType) => {
      const block = {
        type: blockType,
        id: 'srvtoolu_1',
        name: 'code_execution',
        input: { code: "print('hi')" },
      };
      const content = onlyContent(block);

      expect(content).toEqual({
        type: 'code_interpreter_tool_call',
        callId: 'srvtoolu_1',
        inputs: [{ type: 'text', text: '{"code":"print(\'hi\')"}', rawRepresentation: block }],
        rawRepresentation: block,
      });
    },
  );

  it('maps the bash and text-editor code-execution tools the same way', () => {
    const contents = parseBlock({ type: 'server_tool_use', id: 's1', name: 'bash_code_execution' }).concat(
      parseBlock({ type: 'server_tool_use', id: 's2', name: 'text_editor_code_execution' }),
    );
    expect(contents.map((content) => content.type)).toEqual([
      'code_interpreter_tool_call',
      'code_interpreter_tool_call',
    ]);
    // A call with no input still reports one, so the shape does not depend on the wire's omissions.
    expect(outputsOf(contents[0] as Content)).toEqual([]);
    expect((contents[0] as { inputs: Content[] }).inputs).toEqual([
      expect.objectContaining({ type: 'text', text: '{}' }),
    ]);
  });

  it('leaves ordinary tool calls as function calls', () => {
    const [local, server] = parseContentBlocks([
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Osaka' } },
      { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'x' } },
    ]);
    expect(local).toMatchObject({ type: 'function_call', callId: 'toolu_1', name: 'get_weather' });
    expect(local).not.toHaveProperty('informationalOnly');
    expect(server).toMatchObject({
      type: 'function_call',
      callId: 'srvtoolu_2',
      name: 'web_search',
      informationalOnly: true,
    });
  });

  it('carries a string input through unquoted', () => {
    const content = onlyContent({
      type: 'server_tool_use',
      id: 's1',
      name: 'code_execution',
      input: "print('hi')",
    });
    expect((content as { inputs: Content[] }).inputs[0]).toMatchObject({ text: "print('hi')" });
  });
});

describe('code_execution_tool_result variants', () => {
  it('maps an error result to an error output', () => {
    const inner = { type: 'code_execution_tool_result_error', error_code: 'execution_time_exceeded' };
    const block = { type: 'code_execution_tool_result', tool_use_id: 'srvtoolu_1', content: inner };
    const content = onlyContent(block);

    expect(content).toEqual({
      type: 'code_interpreter_tool_result',
      callId: 'srvtoolu_1',
      outputs: [
        {
          type: 'error',
          message: 'execution_time_exceeded',
          // The code as itself, so a restored transcript can rebuild the error payload without
          // guessing whether the message was a code or prose.
          errorCode: 'execution_time_exceeded',
          rawRepresentation: inner,
        },
      ],
      rawRepresentation: block,
    });
  });

  it('maps stdout, stderr and hosted files of a successful run', () => {
    const file = { type: 'code_execution_output', file_id: 'file_1' };
    const inner = {
      type: 'code_execution_result',
      stdout: 'hello\n',
      stderr: 'warning\n',
      return_code: 0,
      content: [file],
    };
    const content = onlyContent({
      type: 'code_execution_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: inner,
    });

    expect(outputsOf(content)).toEqual([
      { type: 'text', text: 'hello\n', rawRepresentation: inner },
      { type: 'error', message: 'warning\n', rawRepresentation: inner },
      { type: 'hosted_file', fileId: 'file_1', rawRepresentation: file },
    ]);
  });

  it('maps an encrypted stdout result to a text output', () => {
    const inner = {
      type: 'encrypted_code_execution_result',
      encrypted_stdout: 'ENCRYPTED',
      stderr: '',
      return_code: 0,
      content: [],
    };
    const content = onlyContent({
      type: 'code_execution_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: inner,
    });

    expect(outputsOf(content)).toEqual([{ type: 'text', text: 'ENCRYPTED', rawRepresentation: inner }]);
  });

  it('reports empty stdout and stderr as no output at all', () => {
    const content = onlyContent({
      type: 'code_execution_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: { type: 'code_execution_result', stdout: '', stderr: '', return_code: 0, content: [] },
    });
    expect(outputsOf(content)).toEqual([]);
  });

  it('reports a missing result payload as an empty output list', () => {
    expect(outputsOf(onlyContent({ type: 'code_execution_tool_result', tool_use_id: 'c1' }))).toEqual([]);
  });

  it('keeps a result variant it does not model as unknown content', () => {
    const inner = { type: 'future_execution_result', payload: 1 };
    const content = onlyContent({
      type: 'code_execution_tool_result',
      tool_use_id: 'c1',
      content: inner,
    });
    expect(outputsOf(content)).toEqual([
      { type: 'unknown', unknownType: 'future_execution_result', payload: 1, rawRepresentation: inner },
    ]);
  });

  it('keeps a file entry that names no file as unknown content', () => {
    // An empty `fileId` would be a hosted file nothing can fetch, and the transcript would not say
    // why. The entry is preserved instead, so a replay still carries it and it stays debuggable.
    const missing = { type: 'code_execution_output' };
    const numeric = { type: 'code_execution_output', file_id: 7 };
    const content = onlyContent({
      type: 'code_execution_tool_result',
      tool_use_id: 'c1',
      content: {
        type: 'code_execution_result',
        stdout: '',
        stderr: '',
        return_code: 0,
        content: [missing, numeric, { type: 'code_execution_output', file_id: 'file_1' }],
      },
    });

    expect(outputsOf(content)).toEqual([
      { type: 'unknown', unknownType: 'code_execution_output', rawRepresentation: missing },
      { type: 'unknown', unknownType: 'code_execution_output', file_id: 7, rawRepresentation: numeric },
      expect.objectContaining({ type: 'hosted_file', fileId: 'file_1' }),
    ]);
  });
});

describe('bash_code_execution_tool_result variants', () => {
  it('maps a successful run to a shell command output', () => {
    const inner = {
      type: 'bash_code_execution_result',
      stdout: 'a.txt\n',
      stderr: '',
      return_code: 0,
      content: [],
    };
    const block = { type: 'bash_code_execution_tool_result', tool_use_id: 'srvtoolu_1', content: inner };
    const content = onlyContent(block);

    expect(content).toEqual({
      type: 'shell_tool_result',
      callId: 'srvtoolu_1',
      outputs: [
        {
          type: 'shell_command_output',
          stdout: 'a.txt\n',
          exitCode: 0,
          timedOut: false,
          rawRepresentation: inner,
        },
      ],
      rawRepresentation: block,
    });
  });

  it('maps a non-zero exit to stderr and the exit code', () => {
    const content = onlyContent({
      type: 'bash_code_execution_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: {
        type: 'bash_code_execution_result',
        stdout: '',
        stderr: 'no such file',
        return_code: 1,
        content: [],
      },
    });
    expect(outputsOf(content)).toEqual([
      expect.objectContaining({
        type: 'shell_command_output',
        stderr: 'no such file',
        exitCode: 1,
        timedOut: false,
      }),
    ]);
  });

  it('maps a tool error to a shell output carrying the error code', () => {
    const content = onlyContent({
      type: 'bash_code_execution_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: { type: 'bash_code_execution_tool_result_error', error_code: 'unavailable' },
    });
    expect(outputsOf(content)).toEqual([
      expect.objectContaining({ type: 'shell_command_output', stderr: 'unavailable', timedOut: false }),
    ]);
  });

  it('marks an exceeded execution time as timed out', () => {
    const content = onlyContent({
      type: 'bash_code_execution_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: { type: 'bash_code_execution_tool_result_error', error_code: 'execution_time_exceeded' },
    });
    expect(outputsOf(content)).toEqual([
      expect.objectContaining({ stderr: 'execution_time_exceeded', timedOut: true }),
    ]);
  });

  it('reports file outputs beside the shell result', () => {
    const file = { type: 'bash_code_execution_output', file_id: 'file_9' };
    const contents = parseBlock({
      type: 'bash_code_execution_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: {
        type: 'bash_code_execution_result',
        stdout: '',
        stderr: '',
        return_code: 0,
        content: [file],
      },
    });
    expect(contents).toEqual([
      { type: 'hosted_file', fileId: 'file_9', rawRepresentation: file },
      expect.objectContaining({ type: 'shell_tool_result', callId: 'srvtoolu_1' }),
    ]);
  });

  it('keeps a bash result variant it does not model as unknown content', () => {
    const content = onlyContent({
      type: 'bash_code_execution_tool_result',
      tool_use_id: 'c1',
      content: { type: 'future_bash_result', payload: 2 },
    });
    expect(outputsOf(content)).toEqual([
      expect.objectContaining({ type: 'unknown', unknownType: 'future_bash_result' }),
    ]);
  });
});

describe('text_editor_code_execution_tool_result variants', () => {
  it('maps an error result to an error item on a function result', () => {
    const inner = {
      type: 'text_editor_code_execution_tool_result_error',
      error_code: 'file_not_found',
      error_message: 'File not found',
    };
    const block = {
      type: 'text_editor_code_execution_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: inner,
    };
    const content = onlyContent(block);

    expect(content).toEqual({
      type: 'function_result',
      callId: 'srvtoolu_1',
      result: [
        { type: 'error', message: 'File not found', errorCode: 'file_not_found', rawRepresentation: inner },
      ],
      rawRepresentation: block,
    });
  });

  it('maps a view result to text annotated with the lines it covers', () => {
    const inner = {
      type: 'text_editor_code_execution_view_result',
      content: 'file body',
      file_type: 'text',
      num_lines: 5,
      start_line: 10,
      total_lines: 40,
    };
    const content = onlyContent({
      type: 'text_editor_code_execution_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: inner,
    });

    expect(resultOf(content)).toEqual([
      {
        type: 'text',
        text: 'file body',
        annotations: [
          {
            type: 'citation',
            annotatedRegions: [{ type: 'text_span', startIndex: 10, endIndex: 15 }],
            rawRepresentation: inner,
          },
        ],
        rawRepresentation: inner,
      },
    ]);
  });

  it('leaves a view result without line numbers unannotated', () => {
    const content = onlyContent({
      type: 'text_editor_code_execution_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: { type: 'text_editor_code_execution_view_result', content: 'body', file_type: 'text' },
    });
    expect(resultOf(content)).toEqual([expect.objectContaining({ type: 'text', text: 'body' })]);
    expect(resultOf(content)[0]).not.toHaveProperty('annotations');
  });

  it('maps a string-replace result to the replacement lines and both spans', () => {
    const inner = {
      type: 'text_editor_code_execution_str_replace_result',
      lines: ['one', 'two'],
      old_start: 5,
      old_lines: 3,
      new_start: 5,
      new_lines: 2,
    };
    const content = onlyContent({
      type: 'text_editor_code_execution_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: inner,
    });

    expect(resultOf(content)).toEqual([
      {
        type: 'text',
        text: 'one\ntwo',
        annotations: [
          {
            type: 'citation',
            annotatedRegions: [{ type: 'text_span', startIndex: 5, endIndex: 8 }],
            rawRepresentation: inner,
          },
          {
            type: 'citation',
            snippet: 'one\ntwo',
            annotatedRegions: [{ type: 'text_span', startIndex: 5, endIndex: 7 }],
            rawRepresentation: inner,
          },
        ],
        rawRepresentation: inner,
      },
    ]);
  });

  it('maps a string-replace result without spans to bare text', () => {
    const content = onlyContent({
      type: 'text_editor_code_execution_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: { type: 'text_editor_code_execution_str_replace_result', lines: null },
    });
    expect(resultOf(content)).toEqual([expect.objectContaining({ type: 'text', text: '' })]);
    expect(resultOf(content)[0]).not.toHaveProperty('annotations');
  });

  it('maps a create result to the file-update flag', () => {
    const [created, updated] = [false, true].map((isFileUpdate) =>
      resultOf(
        onlyContent({
          type: 'text_editor_code_execution_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: { type: 'text_editor_code_execution_create_result', is_file_update: isFileUpdate },
        }),
      ),
    );
    expect(created).toEqual([expect.objectContaining({ type: 'text', text: 'File update: false' })]);
    expect(updated).toEqual([expect.objectContaining({ type: 'text', text: 'File update: true' })]);
  });

  it('keeps a text-editor result variant it does not model as unknown content', () => {
    const content = onlyContent({
      type: 'text_editor_code_execution_tool_result',
      tool_use_id: 'c1',
      content: { type: 'future_editor_result', payload: 3 },
    });
    expect(resultOf(content)).toEqual([
      expect.objectContaining({ type: 'unknown', unknownType: 'future_editor_result' }),
    ]);
  });
});

describe('unrecognized blocks', () => {
  it('keeps a block kind it does not model as unknown content that round-trips verbatim', () => {
    const block = { type: 'code_execution_future_result', tool_use_id: 'c1', detail: { a: 1 } };
    const content = onlyContent(block);
    expect(content).toMatchObject({ type: 'unknown', unknownType: 'code_execution_future_result' });
    expect(serializeContent(content)).toEqual(block);
  });

  it('keeps a malformed result block, whose payload is not an object, readable', () => {
    const contents = parseContentBlocks([
      { type: 'code_execution_tool_result', tool_use_id: 'c1', content: 'oops' },
      { type: 'bash_code_execution_tool_result', tool_use_id: 'c2', content: 42 },
      { type: 'text_editor_code_execution_tool_result', tool_use_id: 'c3', content: null },
    ]);
    expect(contents.map((content) => content.type)).toEqual([
      'code_interpreter_tool_result',
      'shell_tool_result',
      'function_result',
    ]);
    expect(outputsOf(contents[0] as Content)).toEqual([]);
    expect(outputsOf(contents[1] as Content)).toEqual([]);
    expect(resultOf(contents[2] as Content)).toEqual([]);
  });
});

// Every top-level block kind the conversion models, in one response and in the stream that carries
// the same response. Folding the stream must reproduce the awaited transcript: a provider-executed
// call has no fragment representation, so its input has to survive the deltas that spell it out.
const CODE_INPUT = { code: "print('hi')" };

const COMPLETE_BLOCKS: readonly Record<string, unknown>[] = [
  { type: 'text', text: 'Answer.' },
  { type: 'thinking', thinking: 'Let me think.', signature: 'sig-1' },
  { type: 'redacted_thinking', data: 'ENCRYPTED' },
  { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Osaka' } },
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'weather' } },
  {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: [{ type: 'web_search_result', url: 'https://example.test/a' }],
  },
  { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_1', content: { url: 'https://example.test/a' } },
  { type: 'mcp_tool_use', id: 'mcptoolu_1', name: 'lookup', server_name: 'docs', input: { q: 'x' } },
  { type: 'mcp_tool_result', tool_use_id: 'mcptoolu_1', content: [{ type: 'text', text: 'answer' }] },
  { type: 'server_tool_use', id: 'srvtoolu_2', name: 'code_execution', input: CODE_INPUT },
  {
    type: 'code_execution_tool_result',
    tool_use_id: 'srvtoolu_2',
    content: {
      type: 'code_execution_result',
      stdout: 'hi\n',
      stderr: 'warn\n',
      return_code: 0,
      content: [{ type: 'code_execution_output', file_id: 'file_1' }],
    },
  },
  { type: 'server_tool_use', id: 'srvtoolu_3', name: 'bash_code_execution', input: { command: 'ls' } },
  {
    type: 'bash_code_execution_tool_result',
    tool_use_id: 'srvtoolu_3',
    content: {
      type: 'bash_code_execution_result',
      stdout: 'a.txt\n',
      stderr: '',
      return_code: 0,
      content: [{ type: 'bash_code_execution_output', file_id: 'file_2' }],
    },
  },
  {
    type: 'server_tool_use',
    id: 'srvtoolu_4',
    name: 'text_editor_code_execution',
    input: { command: 'view', path: '/a' },
  },
  {
    type: 'text_editor_code_execution_tool_result',
    tool_use_id: 'srvtoolu_4',
    content: {
      type: 'text_editor_code_execution_view_result',
      content: 'file body',
      file_type: 'text',
      num_lines: 2,
      start_line: 1,
      total_lines: 10,
    },
  },
  { type: 'future_block', payload: 1 },
];

/** The stream that carries {@link COMPLETE_BLOCKS}, argument fragments and all. */
function streamEvents(): unknown[] {
  const events: unknown[] = [
    { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-5', content: [] } },
  ];
  let index = 0;
  const openBlock = (block: unknown, deltas: unknown[] = []): void => {
    events.push({ type: 'content_block_start', index, content_block: block });
    for (const delta of deltas) {
      events.push({ type: 'content_block_delta', index, delta });
    }
    events.push({ type: 'content_block_stop', index });
    index += 1;
  };
  /** A call block as the API opens it: an empty `input` placeholder plus JSON fragments. */
  const openCall = (block: Record<string, unknown>): void => {
    const json = JSON.stringify(block.input);
    const half = Math.ceil(json.length / 2);
    openBlock({ ...block, input: {} }, [
      { type: 'input_json_delta', partial_json: json.slice(0, half) },
      { type: 'input_json_delta', partial_json: json.slice(half) },
    ]);
  };

  for (const block of COMPLETE_BLOCKS) {
    switch (block.type) {
      case 'text':
        openBlock({ type: 'text', text: '' }, [{ type: 'text_delta', text: block.text }]);
        break;
      case 'thinking':
        openBlock({ type: 'thinking', thinking: '', signature: '' }, [
          { type: 'thinking_delta', thinking: block.thinking },
          { type: 'signature_delta', signature: block.signature },
        ]);
        break;
      case 'tool_use':
      case 'server_tool_use':
      case 'mcp_tool_use':
        openCall(block);
        break;
      default:
        openBlock(block);
        break;
    }
  }
  events.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
  events.push({ type: 'message_stop' });
  return events;
}

/**
 * The comparable shape of a folded transcript.
 *
 * `serializeContent` strips the provider objects at every level — they are the one thing the two
 * paths legitimately disagree on. A streamed *local* call still ends with its arguments as the JSON
 * string the API spelled out, which the tool loop parses exactly as it parses the awaited object;
 * normalizing that one field is what leaves every other difference visible.
 */
function comparable(contents: readonly Content[]): unknown[] {
  return contents.map((content) => {
    const wire = serializeContent(content);
    if (wire.type === 'function_call' && typeof wire.arguments === 'string') {
      wire.arguments = wire.arguments === '' ? {} : JSON.parse(wire.arguments);
    }
    return wire;
  });
}

describe('complete-message and streaming equivalence', () => {
  const awaited = parseMessage({
    id: 'msg_1',
    model: 'claude-sonnet-4-5',
    content: COMPLETE_BLOCKS,
    stop_reason: 'end_turn',
  });

  it('covers every top-level block kind the conversion models', () => {
    expect(awaited.messages[0]?.contents.map((content) => content.type)).toEqual([
      'text',
      'text_reasoning',
      'unknown',
      'function_call',
      'function_call',
      'function_result',
      'function_result',
      'mcp_server_tool_call',
      'mcp_server_tool_result',
      'code_interpreter_tool_call',
      'code_interpreter_tool_result',
      'code_interpreter_tool_call',
      'hosted_file',
      'shell_tool_result',
      'code_interpreter_tool_call',
      'function_result',
      'unknown',
    ]);
  });

  it('replays a code-execution exchange as the blocks the API sent', () => {
    // Typing these blocks must not cost the transcript its next turn: the calls the provider ran
    // have no request-side form, so the blocks themselves go back, on the assistant turn that
    // produced them. A `tool_result` answering a call the replay no longer contains would be a 400.
    const blocks = COMPLETE_BLOCKS.filter((block) =>
      `${block.type}${block.name ?? ''}`.includes('code_execution'),
    );
    const turn = parseMessage({ id: 'msg_1', content: blocks });
    expect(toAnthropicMessages([turn.messages[0] as Message])).toEqual([
      { role: 'assistant', content: blocks },
    ]);
  });

  it('folds the stream into the awaited transcript', () => {
    const state = createStreamParseState();
    const updates: ChatResponseUpdate[] = [];
    for (const event of streamEvents()) {
      const update = parseStreamEvent(event, state);
      if (update !== undefined) {
        updates.push(update);
      }
    }
    const folded = mergeChatUpdates(updates);

    expect(comparable(folded.messages[0]?.contents ?? [])).toEqual(
      comparable(awaited.messages[0]?.contents ?? []),
    );
  });

  // A code-execution call carries its program as a plain string, so its fragments spell a JSON
  // string rather than an object. Reading only objects back would leave the streamed call holding
  // the placeholder its block opened with while the awaited one held the program.
  it.each<[string, unknown]>([
    ['a string', "print('hi')"],
    ['an array', ['print(1)', 'print(2)']],
    ['null', null],
  ])('folds %s input the awaited path would have carried', (_label, input) => {
    const block = { type: 'server_tool_use', id: 's1', name: 'code_execution', input };
    const state = createStreamParseState();

    parseStreamEvent({ type: 'content_block_start', content_block: { ...block, input: {} } }, state);
    parseStreamEvent(
      {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
      state,
    );
    const closed = parseStreamEvent({ type: 'content_block_stop' }, state);

    expect(comparable(closed?.contents ?? [])).toEqual(comparable(parseBlock(block)));
  });

  it('keeps accumulating across a usage snapshot that ends nothing', () => {
    // A `message_delta` carrying only usage is not the end of the message. Converting the open
    // call there would clear it mid-flight, and the fragments still to come would belong to no
    // call and be dropped — the call would fold with its opening placeholder for an input.
    const block = { type: 'server_tool_use', id: 's1', name: 'code_execution', input: { code: 'x' } };
    const state = createStreamParseState();

    parseStreamEvent({ type: 'content_block_start', content_block: { ...block, input: {} } }, state);
    parseStreamEvent(
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"code"' } },
      state,
    );
    const snapshot = parseStreamEvent(
      { type: 'message_delta', delta: {}, usage: { output_tokens: 5 } },
      state,
    );
    parseStreamEvent(
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: ':"x"}' } },
      state,
    );
    const closed = parseStreamEvent({ type: 'content_block_stop' }, state);

    // The snapshot reports the usage it carried and nothing else.
    expect(snapshot?.contents.map((content) => content.type)).toEqual(['usage']);
    expect(comparable(closed?.contents ?? [])).toEqual(comparable(parseBlock(block)));
  });
});
