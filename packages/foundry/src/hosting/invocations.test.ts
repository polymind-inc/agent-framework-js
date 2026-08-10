import { HEADERS, INVOCATION_ID_HEADER } from '@polymind-inc/agent-framework-agentserver';
import type { AgentLike } from '@polymind-inc/agent-framework-core';
import { Agent, textContent } from '@polymind-inc/agent-framework-core';
import type { MockTurn } from '@polymind-inc/agent-framework-core/testing';
import { MockChatClient } from '@polymind-inc/agent-framework-core/testing';
import { describe, expect, it } from 'vitest';
import { InvocationsHostServer } from './invocations.js';

function say(text: string): MockTurn {
  return { contents: [textContent(text)], finishReason: 'stop' };
}

function server(client: MockChatClient, hosted = false): InvocationsHostServer {
  return new InvocationsHostServer({
    agent: new Agent({ client, instructions: 'Be helpful.' }),
    hosted,
  });
}

function invoke(body: unknown, headers: Record<string, string> = {}, query = ''): Request {
  return new Request(`http://localhost:8088/invocations${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function errorCodeOf(payload: unknown): string {
  return (payload as { error: { code: string } }).error.code;
}

const HOSTED_HEADERS = { [HEADERS.userId]: 'user-1', [HEADERS.foundryCallId]: 'call-1' };

describe('InvocationsHostServer', () => {
  it('answers a non-streaming turn as plain text', async () => {
    const app = server(new MockChatClient([say('Hello there')]));
    const response = await app.handle(invoke({ message: 'Hi' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('Hello there');
    expect(response.headers.get(INVOCATION_ID_HEADER)).toBeTruthy();
    expect(response.headers.get(HEADERS.sessionId)).toBeTruthy();
  });

  it('streams the update text under text/event-stream when asked to', async () => {
    const app = server(new MockChatClient([say('streamed reply')]));
    const response = await app.handle(invoke({ message: 'Hi', stream: true }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toBe('streamed reply');
  });

  it.each([
    ['a missing message', {}],
    ['an empty message', { message: '' }],
    ['a non-string message', { message: 42 }],
  ])('answers 400 for %s', async (_name, body) => {
    const app = server(new MockChatClient([say('unused')]));
    const response = await app.handle(invoke(body));
    expect(response.status).toBe(400);
    expect(errorCodeOf(await response.json())).toBe('invalid_request');
    expect(response.headers.get(HEADERS.errorSource)).toBe('user');
  });

  it.each([
    ['unparseable', 'this is { not json'],
    ['a JSON array', [1, 2]],
    ['a JSON string', '"just text"'],
  ])('answers 400 for a body that is %s', async (_name, body) => {
    const app = server(new MockChatClient([say('unused')]));
    const response = await app.handle(invoke(body));
    expect(response.status).toBe(400);
  });

  it('continues the conversation when the caller pins the session id', async () => {
    const client = new MockChatClient([say('first answer'), say('second answer')]);
    const app = server(client);

    const first = await app.handle(invoke({ message: 'my name is Alice' }));
    const sessionId = first.headers.get(HEADERS.sessionId);
    expect(sessionId).toBeTruthy();

    const second = await app.handle(
      invoke({ message: 'what is my name?' }, {}, `?agent_session_id=${sessionId}`),
    );
    expect(await second.text()).toBe('second answer');

    // The second model call replays the first turn: same session, same transcript.
    const replayed = JSON.stringify(client.calls[1]?.messages);
    expect(replayed).toContain('my name is Alice');
    expect(replayed).toContain('first answer');
  });

  it('starts a fresh conversation for a different session id', async () => {
    const client = new MockChatClient([say('one'), say('two')]);
    const app = server(client);

    await app.handle(invoke({ message: 'first conversation' }, {}, '?agent_session_id=sess-a'));
    await app.handle(invoke({ message: 'second conversation' }, {}, '?agent_session_id=sess-b'));

    expect(JSON.stringify(client.calls[1]?.messages)).not.toContain('first conversation');
  });

  it('fails closed when hosted without the platform call id', async () => {
    const app = server(new MockChatClient([say('unused')]), true);
    const response = await app.handle(invoke({ message: 'Hi' }, { [HEADERS.userId]: 'user-1' }));

    expect(response.status).toBe(501);
    expect(errorCodeOf(await response.json())).toBe('unsupported_container_protocol_version');
  });

  it.each([
    ['missing', {}],
    ['empty', { [HEADERS.userId]: '' }],
  ])('refuses a hosted request whose user id is %s', async (_name, extra) => {
    const app = server(new MockChatClient([say('unused')]), true);
    const response = await app.handle(
      invoke({ message: 'Hi' }, { [HEADERS.foundryCallId]: 'call-1', ...extra }),
    );
    expect(response.status).toBe(400);
    expect(errorCodeOf(await response.json())).toBe('missing_user_id');
  });

  it('answers a hosted request that carries the full platform identity', async () => {
    const app = server(new MockChatClient([say('hosted reply')]), true);
    const response = await app.handle(invoke({ message: 'Hi' }, HOSTED_HEADERS));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hosted reply');
  });

  it('partitions hosted conversations per user within one session', async () => {
    const client = new MockChatClient([say('for user 1'), say('for user 2')]);
    const app = server(client, true);
    const query = '?agent_session_id=shared-sandbox';

    await app.handle(invoke({ message: 'user one secret' }, HOSTED_HEADERS, query));
    await app.handle(
      invoke({ message: 'hello' }, { [HEADERS.userId]: 'user-2', [HEADERS.foundryCallId]: 'call-2' }, query),
    );

    // The second user's turn must not replay the first user's transcript.
    expect(JSON.stringify(client.calls[1]?.messages)).not.toContain('user one secret');
  });

  it('keeps one hosted user’s conversation flowing across turns', async () => {
    const client = new MockChatClient([say('first'), say('second')]);
    const app = server(client, true);
    const query = '?agent_session_id=shared-sandbox';

    await app.handle(invoke({ message: 'remember me' }, HOSTED_HEADERS, query));
    await app.handle(invoke({ message: 'again' }, HOSTED_HEADERS, query));

    expect(JSON.stringify(client.calls[1]?.messages)).toContain('remember me');
  });

  // The reference adapter constructs `AgentSession(session_id=partition_key)`, so tools,
  // middleware and custom agents observe the conversation's real identity rather than a
  // throwaway UUID.
  function recording(agent: Agent, created: Array<string | undefined>): AgentLike {
    return {
      id: agent.id,
      run: agent.run.bind(agent),
      createSession: (options) => {
        created.push(options?.sessionId);
        return agent.createSession(options);
      },
      deserializeSession: agent.deserializeSession.bind(agent),
      asTool: agent.asTool.bind(agent),
    };
  }

  it('creates the local session under the resolved session id', async () => {
    const created: Array<string | undefined> = [];
    const agent = new Agent({ client: new MockChatClient([say('ok')]), instructions: 'x' });
    const app = new InvocationsHostServer({ agent: recording(agent, created), hosted: false });

    await app.handle(invoke({ message: 'hi' }, {}, '?agent_session_id=sess-a'));

    expect(created).toEqual(['sess-a']);
  });

  it('keeps colliding partition spellings apart', async () => {
    // `S:v` × user `u` and `S` × user `v:u` both read `S:v:u` when naively joined with a colon;
    // the partition must tell them apart or one caller reads another's conversation.
    const client = new MockChatClient([say('one'), say('two')]);
    const app = server(client, true);

    await app.handle(
      invoke(
        { message: 'first secret' },
        { [HEADERS.userId]: 'u', [HEADERS.foundryCallId]: 'c1' },
        '?agent_session_id=S:v',
      ),
    );
    await app.handle(
      invoke(
        { message: 'hello' },
        { [HEADERS.userId]: 'v:u', [HEADERS.foundryCallId]: 'c2' },
        '?agent_session_id=S',
      ),
    );

    expect(JSON.stringify(client.calls[1]?.messages)).not.toContain('first secret');
  });

  it('streams only the non-empty update text', async () => {
    // Tool rounds surface as updates with no text; the body must carry the text and nothing else.
    const client = new MockChatClient([
      { contents: [textContent(''), textContent('streamed'), textContent('')], finishReason: 'stop' },
    ]);
    const app = server(client);
    const response = await app.handle(invoke({ message: 'Hi', stream: true }));
    expect(await response.text()).toBe('streamed');
  });

  it('creates the hosted session under the user-partitioned key', async () => {
    const created: Array<string | undefined> = [];
    const agent = new Agent({ client: new MockChatClient([say('ok')]), instructions: 'x' });
    const app = new InvocationsHostServer({ agent: recording(agent, created), hosted: true });

    await app.handle(invoke({ message: 'hi' }, HOSTED_HEADERS, '?agent_session_id=shared-sandbox'));

    expect(created).toEqual(['shared-sandbox:user-1']);
  });
});
