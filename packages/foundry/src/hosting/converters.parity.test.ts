import type { OutputItem } from '@polymind-inc/agent-framework-agentserver';
import type { Content, Message } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import { itemToMessage } from './converters.js';
import { OutputBuilder } from './output.js';

// Fixtures mirror the wire shapes of the official SDK models (`azure-ai-agentserver-responses`
// item types, the same set the .NET `Azure.AI.AgentServer` union declares), so these tests pin
// the converter against payloads a .NET- or Python-hosted container actually produces. Every
// recognized item type must survive replay with its semantic data — a stored-response transcript
// is replayed through `itemToMessage`, and an item that comes back `undefined` is deleted from
// what the model sees.

const WEB_SEARCH_CALL: OutputItem = {
  type: 'web_search_call',
  id: 'ws_0123456789abcdef0123456789abcdef0123456789abcdef01',
  status: 'completed',
  action: { type: 'search', query: 'best pizza in tokyo' },
};

const FILE_SEARCH_CALL: OutputItem = {
  type: 'file_search_call',
  id: 'fs_0123456789abcdef0123456789abcdef0123456789abcdef01',
  status: 'completed',
  queries: ['quarterly revenue'],
  results: [{ file_id: 'file-1', filename: 'q3.pdf', score: 0.92, text: 'Revenue was up.' }],
};

const CODE_INTERPRETER_CALL: OutputItem = {
  type: 'code_interpreter_call',
  id: 'ci_0123456789abcdef0123456789abcdef0123456789abcdef01',
  status: 'completed',
  container_id: 'cntr_1',
  code: 'print(1 + 1)',
  outputs: [
    { type: 'logs', logs: '2\n' },
    { type: 'image', url: 'https://example.com/plot.png' },
  ],
};

const LOCAL_SHELL_CALL: OutputItem = {
  type: 'local_shell_call',
  id: 'lsh_1',
  call_id: 'call_ls1',
  status: 'completed',
  action: { type: 'exec', command: ['ls', '-la'], env: {} },
};

const LOCAL_SHELL_CALL_OUTPUT: OutputItem = {
  type: 'local_shell_call_output',
  id: 'lsho_1',
  status: 'completed',
  output: 'total 0\n',
};

const COMPUTER_CALL: OutputItem = {
  type: 'computer_call',
  id: 'cu_1',
  call_id: 'call_cu1',
  status: 'completed',
  action: { type: 'click', button: 'left', x: 100, y: 200 },
  pending_safety_checks: [],
};

const COMPUTER_CALL_OUTPUT: OutputItem = {
  type: 'computer_call_output',
  id: 'cuo_1',
  call_id: 'call_cu1',
  output: { type: 'computer_screenshot', image_url: 'data:image/png;base64,AAAA' },
};

const CUSTOM_TOOL_CALL: OutputItem = {
  type: 'custom_tool_call',
  id: 'ctc_1',
  call_id: 'call_ct1',
  name: 'run_query',
  input: 'SELECT 1',
};

const APPLY_PATCH_CALL: OutputItem = {
  type: 'apply_patch_call',
  id: 'apc_1',
  call_id: 'call_ap1',
  status: 'completed',
  operation: { type: 'update_file', path: 'src/index.ts', diff: '@@ -1 +1 @@' },
};

const APPLY_PATCH_CALL_OUTPUT: OutputItem = {
  type: 'apply_patch_call_output',
  id: 'apco_1',
  call_id: 'call_ap1',
  status: 'completed',
  output: 'Updated src/index.ts',
};

const STRUCTURED_OUTPUTS: OutputItem = {
  type: 'structured_outputs',
  id: 'so_1',
  output: { answer: 42 },
};

const OUTPUT_MESSAGE: OutputItem = {
  type: 'output_message',
  id: 'om_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
};

/** Converts, then narrows away the undefined case with a clear failure. */
function messageOf(item: OutputItem): Message {
  const message = itemToMessage(item);
  if (message === undefined) throw new Error(`expected a message for item type '${item.type}'`);
  return message;
}

function contentsOf(item: OutputItem): Content[] {
  return messageOf(item).contents;
}

describe('search item replay', () => {
  it('replays a web search call as the call and its result', () => {
    const message = messageOf(WEB_SEARCH_CALL);
    expect(message.role).toBe('assistant');
    expect(message.contents[0]).toMatchObject({
      type: 'search_tool_call',
      callId: WEB_SEARCH_CALL.id,
      toolName: 'web_search',
      arguments: { type: 'search', query: 'best pizza in tokyo' },
      additionalProperties: { status: 'completed' },
    });
    expect(message.contents[1]).toMatchObject({
      type: 'search_tool_result',
      callId: WEB_SEARCH_CALL.id,
      toolName: 'web_search',
      result: { action: { type: 'search', query: 'best pizza in tokyo' } },
    });
  });

  it('replays a file search call with its queries and results', () => {
    const [call, result] = contentsOf(FILE_SEARCH_CALL);
    expect(call).toMatchObject({
      type: 'search_tool_call',
      callId: FILE_SEARCH_CALL.id,
      toolName: 'file_search',
      arguments: { queries: ['quarterly revenue'] },
    });
    expect(result).toMatchObject({
      type: 'search_tool_result',
      callId: FILE_SEARCH_CALL.id,
      toolName: 'file_search',
      result: { results: [expect.objectContaining({ file_id: 'file-1' })] },
    });
  });
});

describe('code interpreter item replay', () => {
  it('replays the executed code and its outputs', () => {
    const [call, result] = contentsOf(CODE_INTERPRETER_CALL);
    expect(call).toMatchObject({
      type: 'code_interpreter_tool_call',
      callId: CODE_INTERPRETER_CALL.id,
      inputs: [{ type: 'text', text: 'print(1 + 1)' }],
    });
    expect(result).toMatchObject({
      type: 'code_interpreter_tool_result',
      callId: CODE_INTERPRETER_CALL.id,
    });
    const outputs = (result as { outputs: Content[] }).outputs;
    expect(outputs[0]).toMatchObject({ type: 'text', text: '2\n' });
    expect(outputs[1]).toMatchObject({ type: 'uri', uri: 'https://example.com/plot.png' });
  });

  it('replays a call with no code as the result only', () => {
    const contents = contentsOf({ ...CODE_INTERPRETER_CALL, code: null });
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({ type: 'code_interpreter_tool_result' });
  });
});

describe('local shell item replay', () => {
  it('replays a local shell call as a shell tool call', () => {
    const message = messageOf(LOCAL_SHELL_CALL);
    expect(message.role).toBe('assistant');
    expect(message.contents[0]).toMatchObject({
      type: 'shell_tool_call',
      callId: 'call_ls1',
      commands: ['ls', '-la'],
      status: 'completed',
    });
  });

  it('replays a local shell output keyed by the item id', () => {
    const message = messageOf(LOCAL_SHELL_CALL_OUTPUT);
    expect(message.role).toBe('tool');
    // The wire item carries no `call_id`; its own id is the correlation key (Python parity).
    expect(message.contents[0]).toMatchObject({ type: 'shell_tool_result', callId: 'lsho_1' });
    expect((message.contents[0] as { outputs: Content[] }).outputs[0]).toMatchObject({
      type: 'shell_command_output',
      stdout: 'total 0\n',
    });
  });
});

describe('computer, patch and custom tool item replay', () => {
  it('replays a computer call as an informational function call with JSON arguments', () => {
    const message = messageOf(COMPUTER_CALL);
    expect(message.role).toBe('assistant');
    // The action stays a structured object — stringifying it as a repr would make the
    // arguments unparseable on the next hop.
    expect(message.contents[0]).toMatchObject({
      type: 'function_call',
      callId: 'call_cu1',
      name: 'computer_use',
      arguments: { type: 'click', button: 'left', x: 100, y: 200 },
      informationalOnly: true,
    });
  });

  it('replays a computer call output with its structured screenshot payload', () => {
    const message = messageOf(COMPUTER_CALL_OUTPUT);
    expect(message.role).toBe('tool');
    expect(message.contents[0]).toMatchObject({
      type: 'function_result',
      callId: 'call_cu1',
      result: { type: 'computer_screenshot', image_url: 'data:image/png;base64,AAAA' },
    });
  });

  it('replays a custom tool call under its own name', () => {
    expect(contentsOf(CUSTOM_TOOL_CALL)[0]).toMatchObject({
      type: 'function_call',
      callId: 'call_ct1',
      name: 'run_query',
      arguments: 'SELECT 1',
      informationalOnly: true,
    });
  });

  it('replays an apply patch call with its structured operation', () => {
    expect(contentsOf(APPLY_PATCH_CALL)[0]).toMatchObject({
      type: 'function_call',
      callId: 'call_ap1',
      name: 'apply_patch',
      arguments: { type: 'update_file', path: 'src/index.ts', diff: '@@ -1 +1 @@' },
      informationalOnly: true,
    });
  });

  it('replays an apply patch output as the tool result', () => {
    const message = messageOf(APPLY_PATCH_CALL_OUTPUT);
    expect(message.role).toBe('tool');
    expect(message.contents[0]).toMatchObject({
      type: 'function_result',
      callId: 'call_ap1',
      result: 'Updated src/index.ts',
    });
  });
});

describe('remaining recognized item replay', () => {
  it('replays structured outputs as their JSON text', () => {
    const message = messageOf(STRUCTURED_OUTPUTS);
    expect(message.role).toBe('assistant');
    expect(message.contents[0]).toMatchObject({ type: 'text', text: '{"answer":42}' });
  });

  it('passes a string structured output through unchanged', () => {
    expect(contentsOf({ ...STRUCTURED_OUTPUTS, output: 'plain' })[0]).toMatchObject({
      type: 'text',
      text: 'plain',
    });
  });

  it('replays an output_message like a message', () => {
    const message = messageOf(OUTPUT_MESSAGE);
    expect(message.role).toBe('assistant');
    expect(message.contents[0]).toMatchObject({ type: 'text', text: 'Done.' });
    expect(message.messageId).toBe('om_1');
  });
});

describe('items with no framework representation', () => {
  it('preserves an unrecognized item as unknown content instead of dropping it', () => {
    const item: OutputItem = {
      type: 'memory_search_call',
      id: 'msc_1',
      status: 'completed',
      query: 'what did we decide',
    };
    const message = messageOf(item);
    expect(message.role).toBe('assistant');
    expect(message.contents[0]).toMatchObject({
      type: 'unknown',
      unknownType: 'memory_search_call',
      id: 'msc_1',
      query: 'what did we decide',
    });
  });

  it('does not double-handle an approval decision', () => {
    // `mcp_approval_response` is consumed out of band (`approvalResponseTarget` binds the
    // decision to the stored request); replaying it as content too would answer twice.
    expect(
      itemToMessage({ type: 'mcp_approval_response', approval_request_id: 'mcpr_1', approve: true }),
    ).toBeUndefined();
  });

  it('does not replay an item reference', () => {
    // A reference points at a service-held item this container cannot dereference.
    expect(itemToMessage({ type: 'item_reference', id: 'msg_1' })).toBeUndefined();
  });
});

describe('search and code interpreter output round trip', () => {
  it('emits a web search call item and replays it', () => {
    const builder = new OutputBuilder('caresp_hint');
    const events = [
      ...builder.push({
        type: 'search_tool_call',
        callId: WEB_SEARCH_CALL.id,
        toolName: 'web_search',
        arguments: { type: 'search', query: 'best pizza in tokyo' },
      } as Content),
      ...builder.push({
        type: 'search_tool_result',
        callId: WEB_SEARCH_CALL.id,
        toolName: 'web_search',
        result: { action: { type: 'search', query: 'best pizza in tokyo' } },
      } as Content),
      ...builder.close(),
    ];

    const done = events.filter((event) => event.type === 'response.output_item.done');
    expect(done).toHaveLength(1);
    const item = (done[0] as unknown as { item: OutputItem }).item;
    expect(item).toMatchObject({
      type: 'web_search_call',
      id: WEB_SEARCH_CALL.id,
      status: 'completed',
      action: { type: 'search', query: 'best pizza in tokyo' },
    });

    const replayed = messageOf(item);
    expect(replayed.contents[0]).toMatchObject({
      type: 'search_tool_call',
      callId: WEB_SEARCH_CALL.id,
      toolName: 'web_search',
      arguments: { type: 'search', query: 'best pizza in tokyo' },
    });
  });

  it('emits a file search call item carrying the results and replays it', () => {
    const builder = new OutputBuilder('caresp_hint');
    const events = [
      ...builder.push({
        type: 'search_tool_call',
        callId: FILE_SEARCH_CALL.id,
        toolName: 'file_search',
        arguments: { queries: ['quarterly revenue'] },
      } as Content),
      ...builder.push({
        type: 'search_tool_result',
        callId: FILE_SEARCH_CALL.id,
        toolName: 'file_search',
        result: {
          results: [{ file_id: 'file-1', filename: 'q3.pdf', score: 0.92, text: 'Revenue was up.' }],
        },
      } as Content),
      ...builder.close(),
    ];

    const done = events.filter((event) => event.type === 'response.output_item.done');
    expect(done).toHaveLength(1);
    const item = (done[0] as unknown as { item: OutputItem }).item;
    expect(item).toMatchObject({
      type: 'file_search_call',
      id: FILE_SEARCH_CALL.id,
      status: 'completed',
      queries: ['quarterly revenue'],
      results: [expect.objectContaining({ file_id: 'file-1' })],
    });

    const [call, result] = messageOf(item).contents;
    expect(call).toMatchObject({ type: 'search_tool_call', toolName: 'file_search' });
    expect(result).toMatchObject({
      type: 'search_tool_result',
      result: { results: [expect.objectContaining({ file_id: 'file-1' })] },
    });
  });

  it('re-mints a search item id that does not fit the protocol format', () => {
    const builder = new OutputBuilder('caresp_hint');
    const events = [
      ...builder.push({
        type: 'search_tool_call',
        callId: 'provider-namespace-id',
        toolName: 'web_search',
        arguments: {},
      } as Content),
      ...builder.close(),
    ];
    const done = events.at(-1) as unknown as { item: OutputItem };
    expect(String(done.item.id)).toMatch(/^ws_/);
  });

  it('parses arguments streamed as a JSON string instead of dropping them', () => {
    // While streaming, tool-call arguments commonly arrive as the concatenated JSON string
    // rather than a parsed object; the emitted item must carry the same action either way.
    const builder = new OutputBuilder('caresp_hint');
    const events = [
      ...builder.push({
        type: 'search_tool_call',
        callId: WEB_SEARCH_CALL.id,
        toolName: 'web_search',
        arguments: '{"type":"search","query":"best pizza in tokyo"}',
      } as Content),
      ...builder.close(),
    ];
    const done = events.at(-1) as unknown as { item: OutputItem };
    expect(done.item).toMatchObject({
      type: 'web_search_call',
      action: { type: 'search', query: 'best pizza in tokyo' },
    });

    const fileBuilder = new OutputBuilder('caresp_hint');
    const fileEvents = [
      ...fileBuilder.push({
        type: 'search_tool_call',
        callId: FILE_SEARCH_CALL.id,
        toolName: 'file_search',
        arguments: '{"queries":["quarterly revenue"]}',
      } as Content),
      ...fileBuilder.close(),
    ];
    const fileDone = fileEvents.at(-1) as unknown as { item: OutputItem };
    expect(fileDone.item).toMatchObject({
      type: 'file_search_call',
      queries: ['quarterly revenue'],
    });
  });

  it('reports a search call whose tool it does not recognize instead of guessing a wire type', () => {
    // A `search_tool_call` carrying an unknown `toolName` (or none) has no defined wire item;
    // emitting it as `web_search_call` would invent semantics the content never had.
    const dropped: Content[] = [];
    const builder = new OutputBuilder('caresp_hint', {
      onUnsupportedContent: (content) => dropped.push(content),
    });
    const events = [
      ...builder.push({
        type: 'search_tool_call',
        callId: 'ms_1',
        toolName: 'memory_search',
        arguments: {},
      } as Content),
      ...builder.push({ type: 'search_tool_call', callId: 'anon_1', arguments: {} } as Content),
      ...builder.close(),
    ];
    expect(events).toHaveLength(0);
    expect(dropped).toHaveLength(2);
  });

  it('emits a code interpreter call item with code and outputs and replays it', () => {
    const builder = new OutputBuilder('caresp_hint');
    const events = [
      ...builder.push({
        type: 'code_interpreter_tool_call',
        callId: CODE_INTERPRETER_CALL.id,
        inputs: [{ type: 'text', text: 'print(1 + 1)' }],
      } as Content),
      ...builder.push({
        type: 'code_interpreter_tool_result',
        callId: CODE_INTERPRETER_CALL.id,
        outputs: [
          { type: 'text', text: '2\n' },
          { type: 'uri', uri: 'https://example.com/plot.png', mediaType: 'image' },
        ],
      } as Content),
      ...builder.close(),
    ];

    const done = events.filter((event) => event.type === 'response.output_item.done');
    expect(done).toHaveLength(1);
    const item = (done[0] as unknown as { item: OutputItem }).item;
    expect(item).toMatchObject({
      type: 'code_interpreter_call',
      id: CODE_INTERPRETER_CALL.id,
      status: 'completed',
      code: 'print(1 + 1)',
      outputs: [
        { type: 'logs', logs: '2\n' },
        { type: 'image', url: 'https://example.com/plot.png' },
      ],
    });

    const [call, result] = messageOf(item).contents;
    expect(call).toMatchObject({
      type: 'code_interpreter_tool_call',
      inputs: [{ type: 'text', text: 'print(1 + 1)' }],
    });
    expect((result as { outputs: Content[] }).outputs).toHaveLength(2);
  });

  it('reports a search result with no open call instead of emitting an orphan', () => {
    const dropped: Content[] = [];
    const builder = new OutputBuilder('caresp_hint', {
      onUnsupportedContent: (content) => dropped.push(content),
    });
    const events = [
      ...builder.push({
        type: 'search_tool_result',
        callId: 'ws_orphan',
        toolName: 'web_search',
        result: {},
      } as Content),
    ];
    expect(events).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });
});
