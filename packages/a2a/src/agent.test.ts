import { UnsupportedOperationError } from '@a2a-js/sdk/errors';
import type {
  AgentResponse,
  AgentResponseUpdate,
  ContinuationToken,
} from '@polymind-inc/agent-framework-core';
import {
  AgentSession,
  ConfigurationError,
  isAbortError,
  textOfContents,
} from '@polymind-inc/agent-framework-core';
import { assert, describe, expect, it } from 'vitest';
import { A2AAgent } from './agent.js';
import { A2AAgentError } from './errors.js';
import { readA2ASessionState } from './session.js';
import { agentCard, fakeClient, message, streamEvent, task } from './test-support.js';

const answer = message({
  messageId: 'm1',
  contextId: 'ctx-1',
  role: 'ROLE_AGENT',
  parts: [{ text: 'Invoice 42 is paid.' }],
});

function sentMessage(params: unknown): {
  parts: Array<{ content?: { value?: unknown } }>;
  taskId: string;
  referenceTaskIds: string[];
  contextId: string;
} {
  return (params as { message: never }).message;
}

describe('construction', () => {
  it('needs a client or a card', () => {
    expect(() => new A2AAgent({})).toThrow(ConfigurationError);
  });

  it('takes its name and description from the card', () => {
    const agent = new A2AAgent({ agentCard: agentCard() });

    expect(agent.name).toBe('Invoice agent');
    expect(agent.description).toBe('Answers questions about invoices.');
    expect(agent.id).not.toBe('');
  });

  it('lets the caller override what the card says', () => {
    const agent = new A2AAgent({ agentCard: agentCard(), id: 'a1', name: 'Billing', description: 'Mine' });

    expect(agent).toMatchObject({ id: 'a1', name: 'Billing', description: 'Mine' });
  });

  it('keeps an explicitly empty name rather than falling back to the card', () => {
    const agent = new A2AAgent({ agentCard: agentCard(), name: '' });

    expect(agent.name).toBe('');
  });

  it('does not talk to the network while being constructed', () => {
    // No client is resolved and no card is fetched: a constructor that made a request could not be
    // called from synchronous code.
    expect(() => new A2AAgent({ agentCard: agentCard({ supportedInterfaces: [] }) })).not.toThrow();
  });
});

describe('a blocking turn', () => {
  it('sends the input and folds the answer', async () => {
    const { client, transport } = fakeClient({ sendMessage: answer });
    const agent = new A2AAgent({ client, id: 'a1', name: 'Invoice agent' });

    const response = await agent.run('Is invoice 42 paid?');

    const [call] = transport.calls;
    const [responseMessage] = response.messages;
    assert.exists(call);
    assert.exists(responseMessage);
    expect(call.method).toBe('sendMessage');
    expect(sentMessage(call.params).parts).toHaveLength(1);
    expect(response.text).toBe('Invoice 42 is paid.');
    expect(response.agentId).toBe('a1');
    expect(responseMessage.authorName).toBe('Invoice agent');
    expect(response.finishReason).toBe('stop');
  });

  it('asks for a foreground answer unless background was requested', async () => {
    const { client, transport } = fakeClient({ sendMessage: answer });

    await new A2AAgent({ client }).run('hello');

    const [call] = transport.calls;
    assert.exists(call);
    const configuration = (call.params as { configuration: { returnImmediately: boolean } }).configuration;
    expect(configuration.returnImmediately).toBe(false);
  });

  it('returns immediately with a token when background was requested', async () => {
    const { client, transport } = fakeClient({
      sendMessage: task({ id: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_SUBMITTED' } }),
    });
    const agent = new A2AAgent({ client });
    const session = agent.createSession();

    const response = await agent.run('long one', { session, allowBackgroundResponses: true });

    const [call] = transport.calls;
    assert.exists(call);
    const configuration = (call.params as { configuration: { returnImmediately: boolean } }).configuration;
    expect(configuration.returnImmediately).toBe(true);
    expect(response.continuationToken).toEqual({ taskId: 'task-1' });
  });

  it('keeps the client’s own request configuration when running in the background', async () => {
    const { client, transport } = fakeClient(
      { sendMessage: task({ id: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_SUBMITTED' } }) },
      agentCard(),
      // What the caller configured their client with must survive: only `returnImmediately` is
      // this package's to say.
      { acceptedOutputModes: ['text/plain', 'application/json'] },
    );
    const agent = new A2AAgent({ client });

    await agent.run('long one', { session: agent.createSession(), allowBackgroundResponses: true });

    const [call] = transport.calls;
    assert.exists(call);
    const configuration = (
      call.params as {
        configuration: { returnImmediately: boolean; acceptedOutputModes: string[] };
      }
    ).configuration;
    expect(configuration.returnImmediately).toBe(true);
    expect(configuration.acceptedOutputModes).toEqual(['text/plain', 'application/json']);
  });

  it('refuses background execution without a session to resume into', () => {
    const { client } = fakeClient({ sendMessage: answer });

    expect(() => new A2AAgent({ client }).run('hi', { allowBackgroundResponses: true })).toThrow(
      ConfigurationError,
    );
  });

  it('refuses input alongside a continuation token', () => {
    const { client } = fakeClient({ sendMessage: answer });

    expect(() => new A2AAgent({ client }).run('hi', { continuationToken: { taskId: 'task-1' } })).toThrow(
      ConfigurationError,
    );
  });

  it('refuses a turn with nothing to send', () => {
    const { client } = fakeClient({ sendMessage: answer });

    expect(() => new A2AAgent({ client }).run()).toThrow(ConfigurationError);
  });

  it('passes run metadata to the request', async () => {
    const { client, transport } = fakeClient({ sendMessage: answer });

    await new A2AAgent({ client }).run('hi', { metadata: { tenantHint: 'acme' } });

    const [call] = transport.calls;
    assert.exists(call);
    expect((call.params as { metadata: unknown }).metadata).toEqual({
      tenantHint: 'acme',
    });
  });
});

describe('a streamed turn', () => {
  it('subscribes and yields an update per event', async () => {
    const { client, transport } = fakeClient({
      sendMessageStream: [
        streamEvent({
          task: { id: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_SUBMITTED' } },
        }),
        streamEvent({
          artifactUpdate: {
            taskId: 'task-1',
            contextId: 'ctx-1',
            artifact: { artifactId: 'a1', parts: [{ text: 'Invoice 42 ' }] },
          },
        }),
        streamEvent({
          artifactUpdate: {
            taskId: 'task-1',
            contextId: 'ctx-1',
            artifact: { artifactId: 'a1', parts: [{ text: 'is paid.' }] },
          },
        }),
        streamEvent({
          statusUpdate: { taskId: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_COMPLETED' } },
        }),
      ],
    });
    const agent = new A2AAgent({ client });
    const session = agent.createSession();

    const updates: AgentResponseUpdate[] = [];
    const stream = agent.run('Is invoice 42 paid?', { session });
    for await (const update of stream) {
      updates.push(update);
    }
    const response = await stream.finalResponse();

    const [call] = transport.calls;
    assert.exists(call);
    expect(call.method).toBe('sendMessageStream');
    expect(updates).toHaveLength(4);
    expect(response.text).toBe('Invoice 42 is paid.');
    expect(session.serviceSessionId).toBe('ctx-1');
    expect(readA2ASessionState(session)).toEqual({ taskId: 'task-1', taskState: 'TASK_STATE_COMPLETED' });
  });

  it('folds to the same answer as the blocking turn', async () => {
    // One piece of wire JSON, sent both ways: the two transports are the same response.
    const finished = {
      id: 'task-1',
      contextId: 'ctx-1',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [
        { artifactId: 'a1', parts: [{ text: 'Invoice 42 ' }] },
        { artifactId: 'a2', parts: [{ text: 'is paid.' }] },
      ],
    };
    const blocking = fakeClient({ sendMessage: task(finished) });
    const streaming = fakeClient({ sendMessageStream: [streamEvent({ task: finished })] });

    const awaited = await new A2AAgent({ client: blocking.client, id: 'a1' }).run('q');
    const streamed = await (async (): Promise<{ text: string; finishReason?: string }> => {
      const stream = new A2AAgent({ client: streaming.client, id: 'a1' }).run('q');
      for await (const _ of stream) {
        // Drain: the folded result is what is being compared.
      }
      return stream.finalResponse();
    })();

    expect(streamed.text).toBe(awaited.text);
    expect(streamed.finishReason).toBe(awaited.finishReason);
  });

  it('does not repeat a streamed artifact when the final task snapshot carries it again', async () => {
    const { client } = fakeClient({
      sendMessageStream: [
        streamEvent({
          artifactUpdate: {
            taskId: 'task-1',
            contextId: 'ctx-1',
            artifact: { artifactId: 'a1', parts: [{ text: 'Invoice 42 is paid.' }] },
          },
        }),
        // Some agents close a stream with a full task snapshot whose artifacts were already
        // streamed one by one. That snapshot must contribute its state, not its content.
        streamEvent({
          task: {
            id: 'task-1',
            contextId: 'ctx-1',
            status: { state: 'TASK_STATE_COMPLETED' },
            artifacts: [{ artifactId: 'a1', parts: [{ text: 'Invoice 42 is paid.' }] }],
          },
        }),
      ],
    });
    const agent = new A2AAgent({ client });
    const session = agent.createSession();

    const stream = agent.run('Is invoice 42 paid?', { session });
    for await (const _ of stream) {
      // Drain.
    }
    const response = await stream.finalResponse();

    expect(response.text).toBe('Invoice 42 is paid.');
    expect(readA2ASessionState(session)).toEqual({ taskId: 'task-1', taskState: 'TASK_STATE_COMPLETED' });
    // The dedup bookkeeping is per-run state; a serialized session carries none of it.
    expect(JSON.stringify(session)).not.toContain('streamedArtifacts');
  });

  it('keeps progress commentary out of the folded transcript', async () => {
    const { client } = fakeClient({
      sendMessageStream: [
        streamEvent({
          artifactUpdate: {
            taskId: 'task-1',
            contextId: 'ctx-1',
            artifact: { artifactId: 'a1', parts: [{ text: 'Invoice 42 ' }] },
          },
        }),
        // A progress message the agent sends while working. Its content is dropped; identifying it
        // would split the artifact around an empty message.
        streamEvent({
          statusUpdate: {
            taskId: 'task-1',
            contextId: 'ctx-1',
            status: {
              state: 'TASK_STATE_WORKING',
              message: { messageId: 'p1', role: 'ROLE_AGENT', parts: [{ text: 'still looking…' }] },
            },
          },
        }),
        streamEvent({
          artifactUpdate: {
            taskId: 'task-1',
            contextId: 'ctx-1',
            artifact: { artifactId: 'a1', parts: [{ text: 'is paid.' }] },
          },
        }),
        streamEvent({
          statusUpdate: { taskId: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_COMPLETED' } },
        }),
      ],
    });

    const stream = new A2AAgent({ client }).run('q');
    for await (const _ of stream) {
      // Drain.
    }
    const response = await stream.finalResponse();

    expect(response.text).toBe('Invoice 42 is paid.');
    expect(response.messages).toHaveLength(1);
    const [responseMessage] = response.messages;
    assert.exists(responseMessage);
    expect(responseMessage.contents).toHaveLength(1);
  });

  it('leaves the session alone when the caller stops early', async () => {
    const { client } = fakeClient({
      sendMessageStream: [
        streamEvent({ task: { id: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_WORKING' } } }),
        streamEvent({
          statusUpdate: { taskId: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_COMPLETED' } },
        }),
      ],
    });
    const agent = new A2AAgent({ client });
    const session = agent.createSession();

    for await (const _ of agent.run('q', { session })) {
      break;
    }

    // The turn never finished, so the session must not be moved onto a task whose outcome was
    // never observed.
    expect(session.serviceSessionId).toBeUndefined();
    expect(readA2ASessionState(session)).toEqual({});
  });
});

/**
 * Folds one remote task both ways.
 *
 * Awaiting a run reads a whole task snapshot; iterating it reads the status and artifact events
 * that describe the same task. Both are handed the same wire JSON, so any difference in the folded
 * transcript is this package's, not the agent's.
 */
async function foldBothWays(
  snapshot: Record<string, unknown>,
  events: Array<Record<string, unknown>>,
): Promise<{ awaited: AgentResponse<unknown>; streamed: AgentResponse<unknown> }> {
  const blocking = fakeClient({ sendMessage: task(snapshot) });
  const streaming = fakeClient({ sendMessageStream: events.map((event) => streamEvent(event)) });

  const awaited = await new A2AAgent({ client: blocking.client, id: 'a1' }).run('q');
  const stream = new A2AAgent({ client: streaming.client, id: 'a1' }).run('q');
  for await (const _ of stream) {
    // Drain: the folded transcript, not the individual updates, is what is being compared.
  }
  return { awaited, streamed: await stream.finalResponse() };
}

/** The whole folded transcript, as what a caller of either path actually reads. */
function transcript(response: AgentResponse<unknown>): Array<{ role: string; text: string }> {
  return response.messages.map((item) => ({ role: item.role, text: textOfContents(item.contents) }));
}

describe('one task consumed both ways', () => {
  it('keeps a terminal status message out of the transcript on both paths', async () => {
    const status = {
      state: 'TASK_STATE_COMPLETED',
      message: { messageId: 's1', role: 'ROLE_AGENT', parts: [{ text: 'Finished the lookup.' }] },
    };

    const { awaited, streamed } = await foldBothWays({ id: 'task-1', contextId: 'ctx-1', status }, [
      { statusUpdate: { taskId: 'task-1', contextId: 'ctx-1', status } },
    ]);

    expect(transcript(awaited)).toEqual(transcript(streamed));
    // The closing commentary of a finished task is not its answer, so neither path speaks it.
    expect(awaited.text).toBe('');
    expect(streamed.text).toBe('');
  });

  it.each(['TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED'])(
    'keeps a %s status message out of the transcript on both paths',
    async (state) => {
      const status = {
        state,
        message: { messageId: 's1', role: 'ROLE_AGENT', parts: [{ text: 'the reason' }] },
      };

      const { awaited, streamed } = await foldBothWays({ id: 'task-1', contextId: 'ctx-1', status }, [
        { statusUpdate: { taskId: 'task-1', contextId: 'ctx-1', status } },
      ]);

      expect(transcript(awaited)).toEqual(transcript(streamed));
      expect(awaited.text).toBe('');
      expect(streamed.text).toBe('');
    },
  );

  it('materializes an input-required status message identically on both paths', async () => {
    const status = {
      state: 'TASK_STATE_INPUT_REQUIRED',
      message: { messageId: 'q1', role: 'ROLE_AGENT', parts: [{ text: 'Which invoice?' }] },
    };

    const { awaited, streamed } = await foldBothWays({ id: 'task-1', contextId: 'ctx-1', status }, [
      { statusUpdate: { taskId: 'task-1', contextId: 'ctx-1', status } },
    ]);

    expect(transcript(awaited)).toEqual(transcript(streamed));
    // A question is addressed to the caller, so it is the one status message that is an answer.
    expect(awaited.text).toBe('Which invoice?');
    expect(streamed.text).toBe('Which invoice?');
  });

  it('names no message for an input-required status that carries no parts', async () => {
    const status = {
      state: 'TASK_STATE_INPUT_REQUIRED',
      message: { messageId: 'q1', role: 'ROLE_AGENT', parts: [] },
    };

    const { awaited, streamed } = await foldBothWays({ id: 'task-1', contextId: 'ctx-1', status }, [
      { statusUpdate: { taskId: 'task-1', contextId: 'ctx-1', status } },
    ]);

    // A question with nothing in it asks nothing. Identifying the message anyway would start an
    // empty one during folding and split whatever surrounds it.
    expect(transcript(awaited)).toEqual(transcript(streamed));
    expect(awaited.messages.map((item) => item.messageId)).toEqual(
      streamed.messages.map((item) => item.messageId),
    );
  });

  it('does not synthesize an answer from the history of a terminal task without artifacts', async () => {
    const history = [
      { messageId: 'u1', contextId: 'ctx-1', role: 'ROLE_USER', parts: [{ text: 'question' }] },
      { messageId: 'a1', contextId: 'ctx-1', role: 'ROLE_AGENT', parts: [{ text: 'answer from history' }] },
    ];
    const status = { state: 'TASK_STATE_COMPLETED' };

    const { awaited, streamed } = await foldBothWays({ id: 'task-1', contextId: 'ctx-1', status, history }, [
      { statusUpdate: { taskId: 'task-1', contextId: 'ctx-1', status } },
    ]);

    // The history is the conversation so far, not new output: replaying it would answer with a
    // message the caller already has, and only the awaited path could ever see it.
    expect(transcript(awaited)).toEqual(transcript(streamed));
    expect(awaited.text).toBe('');
    expect(streamed.text).toBe('');
  });

  it('emits one message per artifact and never twice for a streamed one', async () => {
    const artifacts = [
      { artifactId: 'a1', parts: [{ text: 'Invoice 42 ' }] },
      { artifactId: 'a2', parts: [{ text: 'is paid.' }] },
    ];
    const status = { state: 'TASK_STATE_COMPLETED' };
    const snapshot = { id: 'task-1', contextId: 'ctx-1', status, artifacts };

    const { awaited, streamed } = await foldBothWays(snapshot, [
      { artifactUpdate: { taskId: 'task-1', contextId: 'ctx-1', artifact: artifacts[0] } },
      { artifactUpdate: { taskId: 'task-1', contextId: 'ctx-1', artifact: artifacts[1] } },
      // Agents that close a stream by repeating the whole task must not double the answer.
      { task: snapshot },
    ]);

    // One message per artifact, in order, and the repeated snapshot adds none.
    const expected = [
      { role: 'assistant', text: 'Invoice 42 ' },
      { role: 'assistant', text: 'is paid.' },
    ];
    expect(transcript(awaited)).toEqual(expected);
    expect(transcript(streamed)).toEqual(expected);
  });
});

describe('linking turns together', () => {
  it('continues a task that is waiting for input', async () => {
    const asking = task({
      id: 'task-1',
      contextId: 'ctx-1',
      status: {
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: { messageId: 'q1', role: 'ROLE_AGENT', parts: [{ text: 'which invoice?' }] },
      },
    });
    const { client, transport } = fakeClient({ sendMessage: asking });
    const agent = new A2AAgent({ client });
    const session = agent.createSession();

    await agent.run('is it paid?', { session });
    transport.calls.length = 0;
    await agent.run('42', { session });

    const [call] = transport.calls;
    assert.exists(call);
    const sent = sentMessage(call.params);
    expect(sent.taskId).toBe('task-1');
    expect(sent.referenceTaskIds).toEqual([]);
    expect(sent.contextId).toBe('ctx-1');
  });

  it('references a finished task as prior context', async () => {
    const done = task({
      id: 'task-1',
      contextId: 'ctx-1',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ artifactId: 'a1', parts: [{ text: 'paid' }] }],
    });
    const { client, transport } = fakeClient({ sendMessage: done });
    const agent = new A2AAgent({ client });
    const session = agent.createSession();

    await agent.run('is it paid?', { session });
    transport.calls.length = 0;
    await agent.run('and invoice 43?', { session });

    const [call] = transport.calls;
    assert.exists(call);
    const sent = sentMessage(call.params);
    expect(sent.taskId).toBe('');
    expect(sent.referenceTaskIds).toEqual(['task-1']);
  });

  it('refuses content from another conversation before handing any of it over', async () => {
    const { client } = fakeClient({
      sendMessageStream: [
        streamEvent({
          artifactUpdate: {
            taskId: 'task-9',
            contextId: 'ctx-2',
            artifact: { artifactId: 'a1', parts: [{ text: 'someone else’s invoice' }] },
          },
        }),
      ],
    });
    const agent = new A2AAgent({ client });
    const session = agent.createSession({ serviceSessionId: 'ctx-1' });

    const seen: string[] = [];
    await expect(
      (async (): Promise<void> => {
        for await (const update of agent.run('hi', { session })) {
          seen.push(update.text);
        }
      })(),
    ).rejects.toThrow(A2AAgentError);

    // The check has to precede the yield: a caller that breaks on the first update would otherwise
    // never reach it, having already read a conversation that is not theirs.
    expect(seen).toEqual([]);
  });

  it('refuses a conversation switch in the middle of a stream', async () => {
    const { client } = fakeClient({
      sendMessageStream: [
        streamEvent({
          artifactUpdate: {
            taskId: 'task-1',
            contextId: 'ctx-1',
            artifact: { artifactId: 'a1', parts: [{ text: 'mine' }] },
          },
        }),
        streamEvent({
          artifactUpdate: {
            taskId: 'task-9',
            contextId: 'ctx-2',
            artifact: { artifactId: 'a2', parts: [{ text: 'not mine' }] },
          },
        }),
      ],
    });
    const agent = new A2AAgent({ client });
    // No context id yet: the first event's is adopted as the one this stream belongs to.
    const session = agent.createSession();

    const seen: string[] = [];
    await expect(
      (async (): Promise<void> => {
        for await (const update of agent.run('hi', { session })) {
          seen.push(update.text);
        }
      })(),
    ).rejects.toThrow(A2AAgentError);

    expect(seen).toEqual(['mine']);
    // The run failed, so nothing about it is committed to the session.
    expect(session.serviceSessionId).toBeUndefined();
  });

  it('fails a run whose answer belongs to another conversation', async () => {
    const { client } = fakeClient({
      sendMessage: message({
        messageId: 'm1',
        contextId: 'ctx-2',
        role: 'ROLE_AGENT',
        parts: [{ text: 'hi' }],
      }),
    });
    const agent = new A2AAgent({ client });
    const session = agent.createSession({ serviceSessionId: 'ctx-1' });

    await expect(agent.run('hi', { session })).rejects.toThrow(A2AAgentError);
  });
});

describe('a session whose conversation is gone', () => {
  /** What `agentAsTool({ propagateSession: true })` hands a sub-agent: shared state, no context id. */
  function childSessionOf(parent: AgentSession): AgentSession {
    return new AgentSession({ sessionId: parent.sessionId, state: parent.state });
  }

  it('does not link to a task from a conversation it no longer names', async () => {
    const { client, transport } = fakeClient({
      sendMessage: task({
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ artifactId: 'a1', parts: [{ text: 'paid' }] }],
      }),
    });
    const agent = new A2AAgent({ client });
    const parent = agent.createSession();
    await agent.run('is it paid?', { session: parent });

    transport.calls.length = 0;
    await agent.run('and 43?', { session: childSessionOf(parent) });

    // A task id means nothing outside the conversation it was created in: referencing it here
    // would point the remote agent at a task belonging to a context this message does not name.
    const [call] = transport.calls;
    assert.exists(call);
    const sent = sentMessage(call.params);
    expect(sent.contextId).toBe('');
    expect(sent.referenceTaskIds).toEqual([]);
    expect(sent.taskId).toBe('');
  });

  it('does not let a sub-conversation redirect the parent to its task', async () => {
    const first = task({
      id: 'task-1',
      contextId: 'ctx-1',
      status: { state: 'TASK_STATE_INPUT_REQUIRED' },
    });
    const second = task({ id: 'task-2', contextId: 'ctx-2', status: { state: 'TASK_STATE_COMPLETED' } });
    let next = first;
    const { client, transport } = fakeClient({ sendMessage: (): typeof first => next });
    const agent = new A2AAgent({ client });

    const parent = agent.createSession();
    await agent.run('start', { session: parent });
    next = second;
    // The child shares state, so it writes its own task into the same partition.
    await agent.run('sub-question', { session: childSessionOf(parent) });

    transport.calls.length = 0;
    next = first;
    await agent.run('back to the first thread', { session: parent });

    // Neither continued nor referenced: the recorded task belongs to ctx-2, and this message is
    // being sent in ctx-1.
    const [call] = transport.calls;
    assert.exists(call);
    const sent = sentMessage(call.params);
    expect(sent.contextId).toBe('ctx-1');
    expect(sent.taskId).toBe('');
    expect(sent.referenceTaskIds).toEqual([]);
  });
});

describe('resuming a background turn', () => {
  it('reads the task once when awaited', async () => {
    const { client, transport } = fakeClient({
      getTask: task({
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ artifactId: 'a1', parts: [{ text: 'done' }] }],
      }),
    });
    const agent = new A2AAgent({ client });
    const session = agent.createSession();

    const response = await agent.run(undefined, {
      session,
      continuationToken: { taskId: 'task-1' },
    });

    const [call] = transport.calls;
    assert.exists(call);
    expect(call.method).toBe('getTask');
    expect(call.params).toMatchObject({ id: 'task-1' });
    expect(response.text).toBe('done');
    expect(response.continuationToken).toBeUndefined();
  });

  it('resumes from the token alone, without a session', async () => {
    const { client, transport } = fakeClient({
      getTask: task({
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ artifactId: 'a1', parts: [{ text: 'done' }] }],
      }),
    });

    // The task is server-side state: its id is all a resumed run needs.
    const response = await new A2AAgent({ client }).run(undefined, {
      continuationToken: { taskId: 'task-1' },
    });

    const [call] = transport.calls;
    assert.exists(call);
    expect(call.method).toBe('getTask');
    expect(response.text).toBe('done');
  });

  it('updates a session from the resumed task rather than gating on its recorded state', async () => {
    const { client } = fakeClient({
      getTask: task({
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ artifactId: 'a1', parts: [{ text: 'done' }] }],
      }),
    });
    const agent = new A2AAgent({ client });
    // The session recorded another task — a later turn moved on while the background run was out.
    // The resumed task is what the remote side reports, and the session follows it.
    const session = agent.createSession({ serviceSessionId: 'ctx-1', taskId: 'task-other' });

    const response = await agent.run(undefined, { session, continuationToken: { taskId: 'task-1' } });

    expect(response.text).toBe('done');
    expect(readA2ASessionState(session)).toEqual({ taskId: 'task-1', taskState: 'TASK_STATE_COMPLETED' });
  });

  it('re-subscribes when iterated', async () => {
    const { client, transport } = fakeClient({
      resubscribeTask: [
        streamEvent({
          statusUpdate: { taskId: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_COMPLETED' } },
        }),
      ],
    });

    const stream = new A2AAgent({ client }).run(undefined, { continuationToken: { taskId: 'task-1' } });
    for await (const _ of stream) {
      // Drain.
    }

    const [call] = transport.calls;
    assert.exists(call);
    expect(call.method).toBe('resubscribeTask');
  });

  it('reads the final state when the task can no longer be subscribed to', async () => {
    const { client, transport } = fakeClient({
      resubscribeTask: (): AsyncGenerator<never> => {
        // biome-ignore lint/correctness/useYield: the generator exists only to fail on its first pull
        async function* fail(): AsyncGenerator<never> {
          throw new UnsupportedOperationError();
        }
        return fail();
      },
      getTask: task({
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ artifactId: 'a1', parts: [{ text: 'done' }] }],
      }),
    });

    const stream = new A2AAgent({ client }).run(undefined, { continuationToken: { taskId: 'task-1' } });
    const updates: AgentResponseUpdate[] = [];
    for await (const update of stream) {
      updates.push(update);
    }

    expect(transport.calls.map((call) => call.method)).toEqual(['resubscribeTask', 'getTask']);
    const [update] = updates;
    assert.exists(update);
    expect(update.text).toBe('done');
  });

  it('reports any other subscription failure', async () => {
    const { client } = fakeClient({
      resubscribeTask: (): AsyncGenerator<never> => {
        // biome-ignore lint/correctness/useYield: the generator exists only to fail on its first pull
        async function* fail(): AsyncGenerator<never> {
          throw new Error('connection reset');
        }
        return fail();
      },
    });

    const stream = new A2AAgent({ client }).run(undefined, { continuationToken: { taskId: 'task-1' } });

    await expect(
      (async (): Promise<void> => {
        for await (const _ of stream) {
          // Drain.
        }
      })(),
    ).rejects.toThrow(A2AAgentError);
  });

  it('refuses a token this package did not issue', () => {
    const { client } = fakeClient();

    expect(() =>
      new A2AAgent({ client }).run(undefined, {
        continuationToken: { responseId: 'x' } as ContinuationToken,
      }),
    ).toThrow(ConfigurationError);
  });
});

describe('failures', () => {
  it('wraps a protocol failure', async () => {
    const { client } = fakeClient({
      sendMessage: (): never => {
        throw new UnsupportedOperationError();
      },
    });

    await expect(new A2AAgent({ client }).run('hi')).rejects.toThrow(A2AAgentError);
  });

  it('reports a refused payload as itself rather than as a transport failure', async () => {
    const { client } = fakeClient({
      sendMessageStream: [streamEvent({ artifactUpdate: { taskId: 'task-1', contextId: 'ctx-1' } })],
    });

    const stream = new A2AAgent({ client }).run('hi');
    const failure = await (async (): Promise<unknown> => {
      try {
        for await (const _ of stream) {
          // Drain.
        }
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    // The error this client raised, not a second one wrapped around it.
    expect((failure as Error).message).toBe('The A2A agent sent an artifact update with no artifact.');
    expect((failure as Error).cause).toBeUndefined();
  });

  it('reports input that cannot be sent as a configuration mistake', async () => {
    const { client } = fakeClient({ sendMessage: answer });

    // Only content the A2A content model cannot carry: there is no message to send.
    await expect(
      new A2AAgent({ client }).run({ type: 'function_result', callId: 'c1', result: 'x' }),
    ).rejects.toThrow(ConfigurationError);
  });

  it('reports a card with no usable transport as a configuration mistake', async () => {
    const agent = new A2AAgent({ agentCard: agentCard({ supportedInterfaces: [] }) });

    await expect(agent.run('hi')).rejects.toThrow(ConfigurationError);
  });

  it('keeps a cancellation a cancellation', async () => {
    const controller = new AbortController();
    const { client } = fakeClient({
      sendMessage: (): never => {
        controller.abort();
        throw new DOMException('This operation was aborted', 'AbortError');
      },
    });

    const failure = await new A2AAgent({ client }).run('hi', { signal: controller.signal }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isAbortError(failure, controller.signal)).toBe(true);
    expect(failure).not.toBeInstanceOf(A2AAgentError);
  });

  it('passes the abort signal on to the transport', async () => {
    const controller = new AbortController();
    const { client, transport } = fakeClient({ sendMessage: answer });

    await new A2AAgent({ client }).run('hi', { signal: controller.signal });

    const [call] = transport.calls;
    assert.exists(call);
    expect(call.options?.signal).toBe(controller.signal);
  });
});

describe('sessions', () => {
  it('restores one that was saved', () => {
    const { client } = fakeClient();
    const agent = new A2AAgent({ client });
    const session = agent.createSession({ serviceSessionId: 'ctx-1', taskId: 'task-1' });

    const restored = agent.deserializeSession(JSON.parse(JSON.stringify(session)));

    expect(restored.serviceSessionId).toBe('ctx-1');
    expect(readA2ASessionState(restored)).toEqual({ taskId: 'task-1' });
  });

  it('refuses a malformed one where it can still be fixed', () => {
    const { client } = fakeClient();
    const agent = new A2AAgent({ client });

    expect(() =>
      agent.deserializeSession({ type: 'session', sessionId: 's1', state: { a2a: { taskId: 42 } } }),
    ).toThrow(ConfigurationError);
  });
});
