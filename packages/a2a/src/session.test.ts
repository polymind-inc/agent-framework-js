import { AgentSession, ConfigurationError } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import { A2AAgentError } from './errors.js';
import { A2A_STATE_KEY, readA2ASessionState, writeA2ASessionState } from './session.js';

describe('A2A session state', () => {
  it('reads nothing from a fresh session', () => {
    expect(readA2ASessionState(new AgentSession())).toEqual({});
    expect(readA2ASessionState(undefined)).toEqual({});
  });

  it('adopts the context id the first time the agent reports one', () => {
    const session = new AgentSession();

    writeA2ASessionState(session, { contextId: 'ctx-1', taskId: 'task-1', taskState: 'TASK_STATE_WORKING' });

    expect(session.serviceSessionId).toBe('ctx-1');
    expect(readA2ASessionState(session)).toEqual({ taskId: 'task-1', taskState: 'TASK_STATE_WORKING' });
  });

  it('refuses a response from a different conversation', () => {
    const session = new AgentSession({ serviceSessionId: 'ctx-1' });

    expect(() => writeA2ASessionState(session, { contextId: 'ctx-2' })).toThrow(A2AAgentError);
    expect(session.serviceSessionId).toBe('ctx-1');
  });

  it('clears the task when a turn ended on none', () => {
    const session = new AgentSession();
    writeA2ASessionState(session, {
      contextId: 'ctx-1',
      taskId: 'task-1',
      taskState: 'TASK_STATE_COMPLETED',
    });

    // A turn answered with a plain message: there is no task to link the next message to.
    writeA2ASessionState(session, { contextId: 'ctx-1' });

    expect(readA2ASessionState(session)).toEqual({});
    expect(session.serviceSessionId).toBe('ctx-1');
  });

  it('ignores a task recorded for a different conversation', () => {
    const session = new AgentSession({
      serviceSessionId: 'ctx-1',
      state: { a2a: { contextId: 'ctx-2', taskId: 'task-2', taskState: 'TASK_STATE_INPUT_REQUIRED' } },
    });

    // A task id only means something inside the conversation it was created in.
    expect(readA2ASessionState(session)).toEqual({});
  });

  it('ignores a task when the session names no conversation at all', () => {
    const session = new AgentSession({ state: { a2a: { contextId: 'ctx-1', taskId: 'task-1' } } });

    expect(readA2ASessionState(session)).toEqual({});
  });

  it('does not record a task it cannot scope to a conversation', () => {
    const session = new AgentSession();

    writeA2ASessionState(session, { taskId: 'task-1', taskState: 'TASK_STATE_WORKING' });

    expect(readA2ASessionState(session)).toEqual({});
    expect(session.state).toEqual({ a2a: {} });
  });

  it('round-trips through JSON', () => {
    const session = new AgentSession();
    writeA2ASessionState(session, {
      contextId: 'ctx-1',
      taskId: 'task-1',
      taskState: 'TASK_STATE_INPUT_REQUIRED',
    });

    const restored = AgentSession.fromJSON(JSON.parse(JSON.stringify(session)));

    expect(restored.serviceSessionId).toBe('ctx-1');
    expect(readA2ASessionState(restored)).toEqual({
      taskId: 'task-1',
      taskState: 'TASK_STATE_INPUT_REQUIRED',
    });
  });

  it('refuses a partition that was not written by this package', () => {
    const session = new AgentSession({ state: { [A2A_STATE_KEY]: { taskId: 42 } } });

    expect(() => readA2ASessionState(session)).toThrow(ConfigurationError);
    expect(() => readA2ASessionState(session)).toThrow(/'taskId' must be a string, got number/);
  });

  it('treats an empty task id as absent', () => {
    const session = new AgentSession({ state: { [A2A_STATE_KEY]: { taskId: '' } } });

    expect(readA2ASessionState(session)).toEqual({});
  });
});
