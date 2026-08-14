import { Part, Role, TaskState, taskStateToJSON } from '@a2a-js/sdk';
import type {
  Content,
  DataContent,
  TextContent,
  UnknownContent,
  UriContent,
} from '@polymind-inc/agent-framework-core';
import { dataContent, textContent, uriContent } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import {
  fromA2AParts,
  type ObservedTaskState,
  toA2AMessage,
  toA2AParts,
  updatesFromPayload,
} from './convert.js';
import { A2AAgentError } from './errors.js';
import { message, streamEvent, task } from './test-support.js';

/** Fails the test rather than returning `undefined`, so a missing item is reported where it happens. */
function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}

describe('framework content to A2A parts', () => {
  it('sends text as a text part and carries its metadata', () => {
    const parts = toA2AParts([textContent('hello', { additionalProperties: { lang: 'en' } })]);

    expect(parts).toHaveLength(1);
    expect(must(parts[0]).content).toEqual({ $case: 'text', value: 'hello' });
    expect(must(parts[0]).metadata).toEqual({ lang: 'en' });
  });

  it('skips empty text, which some agents reject', () => {
    expect(toA2AParts([textContent('')])).toEqual([]);
  });

  it('sends a uri as a url part with its media type and file name', () => {
    const parts = toA2AParts([
      uriContent('https://example.test/a.pdf', 'application/pdf', { name: 'a.pdf' }),
    ]);

    expect(must(parts[0]).content).toEqual({ $case: 'url', value: 'https://example.test/a.pdf' });
    expect(must(parts[0]).mediaType).toBe('application/pdf');
    expect(must(parts[0]).filename).toBe('a.pdf');
  });

  it('sends data content as raw bytes, decoded from its data URI', () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);

    const parts = toA2AParts([dataContent(bytes, 'application/octet-stream')]);

    const content = must(must(parts[0]).content);
    expect(content.$case).toBe('raw');
    expect(Array.from(content.value as Uint8Array)).toEqual([1, 2, 3, 250]);
    // Round-trips through the SDK's own encoder rather than stopping at our object.
    expect(Part.toJSON(must(parts[0]))).toEqual({ raw: 'AQID+g==', mediaType: 'application/octet-stream' });
  });

  it('sends a hosted file as a url part carrying its id', () => {
    const parts = toA2AParts([{ type: 'hosted_file', fileId: 'file-1', name: 'report.csv' }]);

    expect(must(parts[0]).content).toEqual({ $case: 'url', value: 'file-1' });
    expect(must(parts[0]).filename).toBe('report.csv');
  });

  it('sends error content as text, with a stand-in when it has no message', () => {
    const parts = toA2AParts([{ type: 'error' }, { type: 'error', message: 'boom' }]);

    expect(must(parts[0]).content).toEqual({ $case: 'text', value: 'An error occurred.' });
    expect(must(parts[1]).content).toEqual({ $case: 'text', value: 'boom' });
  });

  it('drops content the protocol cannot carry instead of failing', () => {
    const contents: Content[] = [
      { type: 'function_call', callId: 'c1', name: 'lookup', arguments: {} },
      { type: 'function_result', callId: 'c1', result: 'x' },
      { type: 'usage', usageDetails: { inputTokenCount: 1 } },
      textContent('kept'),
    ];

    const parts = toA2AParts(contents);

    expect(parts).toHaveLength(1);
    expect(must(parts[0]).content).toEqual({ $case: 'text', value: 'kept' });
  });

  it('refuses data content whose URI is not base64, without quoting the payload', () => {
    const bad: DataContent = { type: 'data', uri: 'data:text/plain,plain-secret', mediaType: 'text/plain' };

    expect(() => toA2AParts([bad])).toThrow(A2AAgentError);
    // Only the URI prefix is quoted; the payload is the caller's data.
    expect(() => toA2AParts([bad])).toThrow(/got 'data:text\/plain'\.$/);
    expect(() => toA2AParts([bad])).not.toThrow(/plain-secret/);
  });
});

describe('A2A parts to framework content', () => {
  it('maps every part kind the protocol defines', () => {
    const parts = [
      Part.fromJSON({ text: 'hi', metadata: { k: 'v' } }),
      Part.fromJSON({ url: 'https://example.test/a.pdf', mediaType: 'application/pdf', filename: 'a.pdf' }),
      Part.fromJSON({ raw: 'AQID', mediaType: 'image/png' }),
      Part.fromJSON({ data: { total: 42 } }),
    ];

    const [text, uri, data, structured] = fromA2AParts(parts) as [
      TextContent,
      UriContent,
      DataContent,
      TextContent,
    ];

    expect(text).toMatchObject({ type: 'text', text: 'hi', additionalProperties: { k: 'v' } });
    expect(uri).toMatchObject({
      type: 'uri',
      uri: 'https://example.test/a.pdf',
      mediaType: 'application/pdf',
    });
    expect(uri.name).toBe('a.pdf');
    expect(data).toMatchObject({ type: 'data', uri: 'data:image/png;base64,AQID', mediaType: 'image/png' });
    // Structured data has no content kind of its own; its JSON text is what every consumer can read.
    expect(structured).toMatchObject({ type: 'text', text: '{"total":42}' });
  });

  it('names an unlabelled raw part as binary', () => {
    const [content] = fromA2AParts([Part.fromJSON({ raw: 'AQID' })]) as [DataContent];

    expect(content.mediaType).toBe('application/octet-stream');
  });

  it('keeps a part whose content kind the SDK did not recognize', () => {
    const part = Part.fromJSON({ somethingNew: 'x', metadata: { k: 'v' } });

    const [content] = fromA2AParts([part]) as [UnknownContent];

    expect(content.type).toBe('unknown');
    // Unknown wire objects keep their own fields at the top level, which is what lets them be
    // serialized back to the shape they arrived in.
    expect(content.metadata).toEqual({ k: 'v' });
    expect(content.rawRepresentation).toBe(part);
  });
});

describe('the message a turn sends', () => {
  it('flattens every input message into one user message', () => {
    const a2a = toA2AMessage(
      [
        { role: 'system', contents: [textContent('be brief')] },
        { role: 'user', contents: [textContent('invoice 42?')] },
      ],
      {},
      'm1',
    );

    expect(a2a.role).toBe(Role.ROLE_USER);
    expect(a2a.parts.map((part) => part.content)).toEqual([
      { $case: 'text', value: 'be brief' },
      { $case: 'text', value: 'invoice 42?' },
    ]);
    expect(a2a.messageId).toBe('m1');
    expect(a2a.contextId).toBe('');
    expect(a2a.taskId).toBe('');
    expect(a2a.referenceTaskIds).toEqual([]);
  });

  it('continues a task that is waiting for input', () => {
    const a2a = toA2AMessage(
      [{ role: 'user', contents: [textContent('yes')] }],
      {
        contextId: 'ctx-1',
        taskId: 'task-1',
        taskState: taskStateToJSON(TaskState.TASK_STATE_INPUT_REQUIRED),
      },
      'm1',
    );

    expect(a2a.taskId).toBe('task-1');
    expect(a2a.referenceTaskIds).toEqual([]);
    expect(a2a.contextId).toBe('ctx-1');
  });

  it('references a task in any other state as prior context', () => {
    const a2a = toA2AMessage(
      [{ role: 'user', contents: [textContent('and now?')] }],
      {
        taskId: 'task-1',
        taskState: taskStateToJSON(TaskState.TASK_STATE_COMPLETED),
      },
      'm1',
    );

    expect(a2a.taskId).toBe('');
    expect(a2a.referenceTaskIds).toEqual(['task-1']);
  });
});

describe('payloads to response updates', () => {
  it('rejects a payload kind this protocol version does not define', () => {
    expect(() =>
      updatesFromPayload(
        { $case: 'hologram', value: {} } as unknown as Parameters<typeof updatesFromPayload>[0],
        {},
      ),
    ).toThrow(/unsupported payload: 'hologram'/);
  });

  it('turns a message payload into one finished assistant update', () => {
    const observed: ObservedTaskState = {};

    const updates = updatesFromPayload(
      {
        $case: 'message',
        value: message({ messageId: 'm1', contextId: 'ctx-1', role: 'ROLE_AGENT', parts: [{ text: 'hi' }] }),
      },
      observed,
    );

    expect(updates).toHaveLength(1);
    expect(must(updates[0])).toMatchObject({
      role: 'assistant',
      responseId: 'm1',
      messageId: 'm1',
      finishReason: 'stop',
    });
    expect(must(updates[0]).text).toBe('hi');
    expect(observed).toEqual({ contextId: 'ctx-1' });
  });

  it('reads a message from the client back as a user message', () => {
    const updates = updatesFromPayload(
      { $case: 'message', value: message({ messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }] }) },
      {},
    );

    expect(must(updates[0]).role).toBe('user');
  });

  it('emits one update per artifact and merges task metadata into each', () => {
    const observed: ObservedTaskState = {};

    const updates = updatesFromPayload(
      {
        $case: 'task',
        value: task({
          id: 'task-1',
          contextId: 'ctx-1',
          status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-08-03T10:00:00Z' },
          metadata: { turn: 1 },
          artifacts: [
            { artifactId: 'a1', parts: [{ text: 'part one' }], metadata: { seq: 1 } },
            { artifactId: 'a2', parts: [{ text: 'part two' }] },
          ],
        }),
      },
      observed,
    );

    expect(updates.map((update) => update.messageId)).toEqual(['a1', 'a2']);
    expect(must(updates[0]).additionalProperties).toEqual({ seq: 1, turn: 1 });
    expect(updates.every((update) => update.createdAt === '2026-08-03T10:00:00Z')).toBe(true);
    // Only the last update ends the turn, so folding does not stop at the first artifact.
    expect(must(updates[0]).finishReason).toBeUndefined();
    expect(must(updates[1]).finishReason).toBe('stop');
    expect(observed).toEqual({
      contextId: 'ctx-1',
      taskId: 'task-1',
      taskState: 'TASK_STATE_COMPLETED',
    });
  });

  it('adds the question when a task is waiting for input', () => {
    const updates = updatesFromPayload(
      {
        $case: 'task',
        value: task({
          id: 'task-1',
          contextId: 'ctx-1',
          status: {
            state: 'TASK_STATE_INPUT_REQUIRED',
            message: { messageId: 'q1', role: 'ROLE_AGENT', parts: [{ text: 'which invoice?' }] },
          },
          artifacts: [{ artifactId: 'a1', parts: [{ text: 'found two' }] }],
        }),
      },
      {},
    );

    expect(updates.map((update) => update.text)).toEqual(['found two', 'which invoice?']);
    // An interrupted task waits for the caller, not for the agent: there is nothing to resume.
    expect(must(updates[1]).continuationToken).toBeUndefined();
  });

  it('surfaces a terminal status message, including a failure reason', () => {
    const updates = updatesFromPayload(
      {
        $case: 'task',
        value: task({
          id: 'task-1',
          contextId: 'ctx-1',
          status: {
            state: 'TASK_STATE_FAILED',
            message: {
              messageId: 'failure-1',
              role: 'ROLE_AGENT',
              parts: [{ text: 'invoice service failed' }],
            },
          },
        }),
      },
      {},
    );

    expect(updates.map((update) => update.text)).toContain('invoice service failed');
  });

  it('falls back to the last agent history message when a task has no artifacts', () => {
    const updates = updatesFromPayload(
      {
        $case: 'task',
        value: task({
          id: 'task-1',
          contextId: 'ctx-1',
          status: { state: 'TASK_STATE_COMPLETED' },
          history: [
            { messageId: 'u1', role: 'ROLE_USER', parts: [{ text: 'question' }] },
            { messageId: 'a1', role: 'ROLE_AGENT', parts: [{ text: 'answer from history' }] },
          ],
        }),
      },
      {},
    );

    expect(updates.map((update) => update.text)).toContain('answer from history');
  });

  it('does not replay a history message while a task is still working', () => {
    const working = task({
      id: 'task-1',
      contextId: 'ctx-1',
      status: { state: 'TASK_STATE_WORKING' },
      history: [
        { messageId: 'u1', role: 'ROLE_USER', parts: [{ text: 'question' }] },
        { messageId: 'a1', role: 'ROLE_AGENT', parts: [{ text: 'stale answer' }] },
      ],
    });

    // Two polls of the same unfinished task, as resuming produces: neither may present the
    // history as fresh output, or every poll would repeat it.
    for (let poll = 0; poll < 2; poll += 1) {
      const updates = updatesFromPayload({ $case: 'task', value: working }, {});

      expect(updates.map((update) => update.text)).not.toContain('stale answer');
      expect(must(updates.at(-1)).continuationToken).toEqual({ taskId: 'task-1' });
    }
  });

  it('does not fall back to history when the terminal task repeats only streamed artifacts', () => {
    const observed: ObservedTaskState = {};
    const streamed = streamEvent({
      artifactUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: { artifactId: 'a1', parts: [{ text: 'the answer' }] },
      },
    });
    updatesFromPayload(must(streamed.payload), observed);

    const terminal = updatesFromPayload(
      {
        $case: 'task',
        value: task({
          id: 'task-1',
          contextId: 'ctx-1',
          status: { state: 'TASK_STATE_COMPLETED' },
          artifacts: [{ artifactId: 'a1', parts: [{ text: 'the answer' }] }],
          history: [{ messageId: 'h1', role: 'ROLE_AGENT', parts: [{ text: 'the answer' }] }],
        }),
      },
      observed,
    );

    // The artifact already delivered the answer; the history copy of it must not bring it back.
    expect(terminal.flatMap((update) => update.contents)).toEqual([]);
  });

  it('emits a message mirrored in both the status and the history exactly once', () => {
    const finalMessage = { messageId: 'final-1', role: 'ROLE_AGENT', parts: [{ text: 'the answer' }] };

    const updates = updatesFromPayload(
      {
        $case: 'task',
        value: task({
          id: 'task-1',
          contextId: 'ctx-1',
          status: { state: 'TASK_STATE_COMPLETED', message: finalMessage },
          history: [finalMessage],
        }),
      },
      {},
    );

    expect(updates.map((update) => update.text).filter((text) => text === 'the answer')).toHaveLength(1);
  });

  it('does not emit an artifact again when the terminal task repeats a streamed artifact', () => {
    const observed: ObservedTaskState = {};
    const streamed = streamEvent({
      artifactUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: { artifactId: 'a1', parts: [{ text: 'once' }] },
      },
    });
    const first = updatesFromPayload(must(streamed.payload), observed);
    const terminal = updatesFromPayload(
      {
        $case: 'task',
        value: task({
          id: 'task-1',
          contextId: 'ctx-1',
          status: { state: 'TASK_STATE_COMPLETED' },
          artifacts: [{ artifactId: 'a1', parts: [{ text: 'once' }] }],
        }),
      },
      observed,
    );

    expect(first.map((update) => update.text)).toEqual(['once']);
    expect(terminal.map((update) => update.text)).not.toContain('once');
  });

  it.each([
    ['TASK_STATE_SUBMITTED', true, undefined],
    ['TASK_STATE_WORKING', true, undefined],
    ['TASK_STATE_COMPLETED', false, 'stop'],
    ['TASK_STATE_INPUT_REQUIRED', false, undefined],
    ['TASK_STATE_AUTH_REQUIRED', false, undefined],
    ['TASK_STATE_FAILED', false, undefined],
    ['TASK_STATE_CANCELED', false, undefined],
    ['TASK_STATE_REJECTED', false, undefined],
  ])('reports %s as resumable=%s finishReason=%s', (state, resumable, finishReason) => {
    const updates = updatesFromPayload(
      { $case: 'task', value: task({ id: 'task-1', contextId: 'ctx-1', status: { state } }) },
      {},
    );

    const last = must(updates.at(-1));
    expect(last.continuationToken).toEqual(resumable ? { taskId: 'task-1' } : undefined);
    expect(last.finishReason).toBe(finishReason);
  });

  it('still reports a task that produced nothing', () => {
    const updates = updatesFromPayload(
      {
        $case: 'task',
        value: task({ id: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_WORKING' } }),
      },
      {},
    );

    expect(updates).toHaveLength(1);
    expect(must(updates[0]).contents).toEqual([]);
    expect(must(updates[0]).continuationToken).toEqual({ taskId: 'task-1' });
  });

  it('keeps progress commentary out of the transcript', () => {
    const event = streamEvent({
      statusUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        status: {
          state: 'TASK_STATE_WORKING',
          message: { messageId: 'p1', role: 'ROLE_AGENT', parts: [{ text: 'working on it' }] },
        },
      },
    });

    const updates = updatesFromPayload(must(event.payload), {});

    expect(must(updates[0]).contents).toEqual([]);
    // Not even identified: a message id whose content was dropped would start an empty message
    // during folding and split the surrounding artifact in two.
    expect(must(updates[0]).messageId).toBeUndefined();
  });

  it('surfaces a status message when the state is input-required', () => {
    const event = streamEvent({
      statusUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        status: {
          state: 'TASK_STATE_INPUT_REQUIRED',
          message: { messageId: 'q1', role: 'ROLE_AGENT', parts: [{ text: 'which invoice?' }] },
        },
      },
    });
    const observed: ObservedTaskState = {};

    const updates = updatesFromPayload(must(event.payload), observed);

    expect(must(updates[0]).text).toBe('which invoice?');
    expect(observed.taskState).toBe('TASK_STATE_INPUT_REQUIRED');
  });

  it('merges artifact and event metadata on an artifact update, the event winning', () => {
    const event = streamEvent({
      artifactUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: { artifactId: 'a1', parts: [{ text: 'chunk' }], metadata: { seq: 1, from: 'artifact' } },
        metadata: { from: 'event' },
      },
    });

    const updates = updatesFromPayload(must(event.payload), {});

    expect(must(updates[0])).toMatchObject({ responseId: 'task-1', messageId: 'a1' });
    expect(must(updates[0]).additionalProperties).toEqual({ seq: 1, from: 'event' });
  });

  it('keeps the last reported task state when an artifact update carries no status', () => {
    const observed: ObservedTaskState = {
      contextId: 'ctx-1',
      taskId: 'task-1',
      taskState: 'TASK_STATE_WORKING',
    };
    const event = streamEvent({
      artifactUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: { artifactId: 'a1', parts: [{ text: 'chunk' }] },
      },
    });

    updatesFromPayload(must(event.payload), observed);

    expect(observed.taskState).toBe('TASK_STATE_WORKING');
  });

  it('resets the last task state when a status-bearing payload omits its status', () => {
    const observed: ObservedTaskState = {
      contextId: 'ctx-1',
      taskId: 'task-old',
      taskState: 'TASK_STATE_WORKING',
    };

    updatesFromPayload({ $case: 'task', value: task({ id: 'task-2', contextId: 'ctx-1' }) }, observed);

    expect(observed).toEqual({ contextId: 'ctx-1', taskId: 'task-2', taskState: undefined });
  });

  it('refuses an artifact update with no artifact', () => {
    expect(() =>
      updatesFromPayload(
        {
          $case: 'artifactUpdate',
          value: {
            taskId: 't',
            contextId: 'c',
            artifact: undefined,
            append: false,
            lastChunk: false,
            metadata: undefined,
          },
        },
        {},
      ),
    ).toThrow(A2AAgentError);
  });
});
