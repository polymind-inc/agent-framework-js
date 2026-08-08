import { describe, expect, it } from 'vitest';
import { textContent } from './content.js';
import type { Message } from './message.js';
import { message, normalizeInput, textOf, textOfMessages } from './message.js';
import { agentResponse } from './response.js';

describe('normalizeInput', () => {
  it('returns an empty list for undefined', () => {
    expect(normalizeInput(undefined)).toEqual([]);
  });

  it('wraps a bare string as a single user message', () => {
    expect(normalizeInput('hello')).toEqual([{ role: 'user', contents: [{ type: 'text', text: 'hello' }] }]);
  });

  it('wraps a bare content item as a single user message', () => {
    expect(normalizeInput({ type: 'uri', uri: 'https://example.com' })).toEqual([
      { role: 'user', contents: [{ type: 'uri', uri: 'https://example.com' }] },
    ]);
  });

  it('passes explicit messages through untouched', () => {
    const msg: Message = { role: 'assistant', contents: [textContent('hi')] };
    expect(normalizeInput(msg)[0]).toBe(msg);
  });

  it('groups loose items around explicit messages, preserving order', () => {
    const explicit: Message = { role: 'assistant', contents: [textContent('mid')] };
    const result = normalizeInput(['a', { type: 'uri', uri: 'https://example.com' }, explicit, 'b']);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      role: 'user',
      contents: [
        { type: 'text', text: 'a' },
        { type: 'uri', uri: 'https://example.com' },
      ],
    });
    expect(result[1]).toBe(explicit);
    expect(result[2]).toEqual({ role: 'user', contents: [{ type: 'text', text: 'b' }] });
  });
});

describe('message', () => {
  it('wraps a string and mixed content arrays', () => {
    expect(message('user', 'hi')).toEqual({ role: 'user', contents: [{ type: 'text', text: 'hi' }] });
    expect(message('user', ['hi', { type: 'uri', uri: 'https://example.com' }])).toEqual({
      role: 'user',
      contents: [
        { type: 'text', text: 'hi' },
        { type: 'uri', uri: 'https://example.com' },
      ],
    });
  });
});

describe('textOf', () => {
  it('concatenates the text of a message', () => {
    expect(textOf({ role: 'user', contents: [textContent('a'), textContent('b')] })).toBe('ab');
  });

  it('accepts an AgentResponse too', () => {
    const response = agentResponse({
      messages: [
        { role: 'assistant', contents: [textContent('hello')] },
        { role: 'assistant', contents: [textContent('world')] },
      ],
    });
    expect(textOf(response)).toBe('hello\nworld');
  });
});

describe('textOfMessages', () => {
  it('joins message texts with a newline', () => {
    expect(
      textOfMessages([
        { role: 'user', contents: [textContent('a')] },
        { role: 'assistant', contents: [textContent('b')] },
      ]),
    ).toBe('a\nb');
  });

  it('skips empty messages instead of separating them', () => {
    expect(
      textOfMessages([
        { role: 'assistant', contents: [textContent('foo')] },
        { role: 'assistant', contents: [] },
        { role: 'assistant', contents: [{ type: 'function_call', callId: 'c1', name: 'f', arguments: '{}' }] },
        { role: 'assistant', contents: [textContent('Bar')] },
      ]),
    ).toBe('foo\nBar');
  });

  it('concatenates contents inside one message without a separator', () => {
    expect(
      textOfMessages([{ role: 'assistant', contents: [textContent('foo'), textContent('Bar')] }]),
    ).toBe('fooBar');
  });
});
