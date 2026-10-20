/**
 * Replaying turns that used Anthropic's web search and web fetch server tools.
 *
 * The receive side reports a server call as an informational `function_call` and its result as a
 * `function_result`, the same shape a local exchange has. Sent back as `tool_use` / `tool_result`,
 * the exchange would answer a call the API ran itself, so the conversion has to send the server's
 * own blocks — the raw ones while they are held, and blocks rebuilt from the typed contents once a
 * session store has stripped them. These tests drive real wire fixtures through the receive-side
 * parser and compare the in-memory replay with the replay of a saved and restored transcript.
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

const user = (text: string): Message => ({ role: 'user', contents: [{ type: 'text', text }] });

const SEARCH_CALL = {
  type: 'server_tool_use',
  id: 'srvtoolu_1',
  name: 'web_search',
  input: { query: 'quantum computing 2025' },
};

const WEB_SEARCH_TURN = [
  { type: 'text', text: 'Searching.' },
  SEARCH_CALL,
  {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: [
      {
        type: 'web_search_result',
        url: 'https://example.test/a',
        title: 'A',
        encrypted_content: 'ENC',
        page_age: 'April 30, 2025',
      },
    ],
  },
  { type: 'text', text: 'Found it.' },
];

const WEB_SEARCH_ERROR_TURN = [
  SEARCH_CALL,
  {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
  },
];

const WEB_FETCH_TURN = [
  { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_fetch', input: { url: 'https://example.test/a' } },
  {
    type: 'web_fetch_tool_result',
    tool_use_id: 'srvtoolu_2',
    content: {
      type: 'web_fetch_result',
      url: 'https://example.test/a',
      content: {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: 'Full text.' },
      },
      retrieved_at: '2025-08-25T10:30:00Z',
    },
  },
];

describe('web search and web fetch replay', () => {
  it.each([
    ['web search', WEB_SEARCH_TURN],
    ['web search error', WEB_SEARCH_ERROR_TURN],
    ['web fetch', WEB_FETCH_TURN],
  ])('replays a %s turn as the blocks the API sent, in memory and restored', (_label, blocks) => {
    const turn = assistantTurn(blocks);

    const inMemory = toAnthropicMessages([user('go'), turn]);
    const replayed = toAnthropicMessages([user('go'), restored(turn)]);

    expect(inMemory).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: blocks },
    ]);
    expect(replayed).toEqual(inMemory);
  });

  describe('a server call no result answers', () => {
    const serverToolUses = (messages: readonly Message[]) =>
      toAnthropicMessages(messages).flatMap((msg) =>
        Array.isArray(msg.content) ? msg.content.filter((block) => block.type === 'server_tool_use') : [],
      );

    it.each([
      ['in memory', (msg: Message) => msg],
      ['restored', restored],
    ])('is kept %s on the paused turn the request continues', (_label, prepare) => {
      // A `pause_turn` response can end on a server call the API has not run yet; re-sending the
      // turn as-is is how it continues.
      const messages = [
        user('go'),
        prepare(assistantTurn([{ type: 'text', text: 'Searching.' }, SEARCH_CALL])),
      ];

      expect(serverToolUses(messages)).toEqual([SEARCH_CALL]);
    });

    it.each([
      ['in memory', 'tool' as const, (msg: Message) => msg],
      ['restored', 'tool' as const, restored],
      ['in memory', 'assistant' as const, (msg: Message) => msg],
      ['restored', 'assistant' as const, restored],
    ])('is kept %s while only local tool results follow it, in a %s envelope', (_label, role, prepare) => {
      const messages: Message[] = [
        user('go'),
        prepare(
          assistantTurn([
            SEARCH_CALL,
            { type: 'tool_use', id: 'toolu_1', name: 'run_command', input: { command: 'ls' } },
          ]),
        ),
        { role, contents: [{ type: 'function_result', callId: 'toolu_1', result: 'ok' }] },
      ];

      expect(serverToolUses(messages)).toEqual([SEARCH_CALL]);
    });

    it.each([
      ['in memory', (msg: Message) => msg],
      ['restored', restored],
    ])('is dropped %s once its turn has closed', (_label, prepare) => {
      const messages = [user('go'), prepare(assistantTurn([SEARCH_CALL])), user('next')];

      expect(serverToolUses(messages)).toEqual([]);
    });
  });

  it('leaves an informational call from another provider on the local mapping', () => {
    // Only Anthropic server calls carry the `srvtoolu_` id prefix; an informational call another
    // provider reported keeps the mapping it has always had.
    const foreign: Message = {
      role: 'assistant',
      contents: [
        { type: 'function_call', callId: 'ws_1', name: 'web_search', arguments: {}, informationalOnly: true },
        { type: 'function_result', callId: 'ws_1', result: 'done' },
      ],
    };

    expect(toAnthropicMessages([user('go'), restored(foreign)])).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'ws_1', name: 'web_search', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'ws_1', content: 'done', is_error: false }],
      },
    ]);
  });
});
