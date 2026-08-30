import { describe, expect, it } from 'vitest';
import { ProtocolError } from './errors.js';
import { conversationIdOf, parseCreateRequest, parseStartingAfter } from './validation.js';

// The schema pass mirrors Python's generated `validate_create_response_payload`: every mistyped
// field is reported together on one 400, as `$`-rooted JSON paths, before any semantic check
// runs. These tests feed one wrong field at a time and assert the reported path.

/** The field-level details of the schema-validation 400 for `body`. */
function detailParams(body: unknown): string[] {
  try {
    parseCreateRequest(body);
  } catch (error) {
    if (error instanceof ProtocolError && error.details !== undefined) {
      return error.details.map((detail) => detail.param ?? '');
    }
    throw error;
  }
  return [];
}

describe('schema validation paths', () => {
  it.each([
    [{ stream: 'yes' }, '$.stream'],
    [{ background: 0 }, '$.background'],
    [{ model: 42 }, '$.model'],
    [{ instructions: [] }, '$.instructions'],
    [{ temperature: 'hot' }, '$.temperature'],
    [{ max_output_tokens: '100' }, '$.max_output_tokens'],
    [{ stream_options: [] }, '$.stream_options'],
    [{ text: 'plain' }, '$.text'],
    [{ input: 42 }, '$.input'],
    [{ input: [42] }, '$.input[0]'],
    // No `type` means the item is held to the message shape, so the missing field is named.
    [{ input: [{ role: 'user' }] }, '$.input[0].content'],
    [{ conversation: 42 }, '$.conversation'],
    [{ conversation: { id: 42 } }, '$.conversation.id'],
    [{ metadata: [] }, '$.metadata'],
    [{ metadata: { note: 42 } }, "$.metadata['note']"],
    [{ tools: {} }, '$.tools'],
    [{ tools: [42] }, '$.tools[0]'],
    [{ include: {} }, '$.include'],
    [{ include: [42] }, '$.include[0]'],
    [{ agent_reference: 42 }, '$.agent_reference'],
    [{ agent_reference: {} }, '$.agent_reference.name'],
    [{ agent_reference: { name: 'a', version: 2 } }, '$.agent_reference.version'],
  ])('reports %j at %s', (body, param) => {
    expect(detailParams(body)).toContain(param);
  });

  it('reports every problem together rather than stopping at the first', () => {
    expect(detailParams({ stream: 'yes', model: 42, input: [{}] })).toEqual([
      '$.stream',
      '$.model',
      '$.input[0].role',
      '$.input[0].content',
    ]);
  });

  it('accepts each field in its documented shape', () => {
    const request = parseCreateRequest({
      stream: true,
      stream_options: { include_obfuscation: false },
      model: 'gpt-4o',
      temperature: 0.2,
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      conversation: { id: 'conv_1' },
      metadata: { note: 'ok' },
      tools: [{ type: 'function' }],
      include: ['message.output_text.logprobs'],
      agent_reference: { name: 'assistant', version: '1' },
    });
    expect(request.model).toBe('gpt-4o');
  });
});

describe('input items without an explicit type', () => {
  it('defaults a missing discriminator to message and normalizes the item', () => {
    const request = parseCreateRequest({ input: [{ role: 'user', content: 'hello' }] });

    expect(request.input).toEqual([{ type: 'message', role: 'user', content: 'hello' }]);
  });

  it('keeps every caller-supplied field on the normalized item', () => {
    const request = parseCreateRequest({
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hi' }], id: 'msg_x', phase: 'commentary' },
      ],
    });

    expect(request.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
        id: 'msg_x',
        phase: 'commentary',
      },
    ]);
  });

  it('leaves the caller-owned request and item objects untouched', () => {
    const item = { role: 'user', content: 'hello' };
    const body = { input: [item] };

    const request = parseCreateRequest(body);

    expect(Object.hasOwn(item, 'type')).toBe(false);
    expect(item).toEqual({ role: 'user', content: 'hello' });
    expect(body.input[0]).toBe(item);
    expect(request.input).not.toBe(body.input);
  });

  it('preserves an explicit valid discriminator', () => {
    // `item_reference` is how a caller points at a stored item; it must survive untouched, and an
    // explicit `message` must not be rewritten either.
    const request = parseCreateRequest({
      input: [
        { type: 'item_reference', id: 'x' },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    });

    expect(request.input).toEqual([
      { type: 'item_reference', id: 'x' },
      { type: 'message', role: 'user', content: 'hi' },
    ]);
  });

  it('returns the very same request when no item needed the default', () => {
    const body = { input: [{ type: 'item_reference', id: 'x' }] };

    expect(parseCreateRequest(body).input).toBe(body.input);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a number', 42],
    ['an object', {}],
    ['an array', ['message']],
  ])('rejects a type of %s rather than taking the default for it', (_label, type) => {
    expect(detailParams({ input: [{ type, role: 'user', content: 'hi' }] })).toEqual(['$.input[0]']);
  });

  it('still refuses an id-only object, which needs an explicit item_reference', () => {
    expect(detailParams({ input: [{ id: 'x' }] })).toEqual(['$.input[0].role', '$.input[0].content']);
  });

  it.each([
    [{ content: 'hi' }, ['$.input[0].role']],
    [{ role: 42, content: 'hi' }, ['$.input[0].role']],
    [{ role: 'user' }, ['$.input[0].content']],
    [{ role: 'user', content: 42 }, ['$.input[0].content']],
  ])('reports field-level paths for the defaulted message %j', (item, params) => {
    expect(detailParams({ input: [item] })).toEqual(params);
  });
});

describe('metadata limits', () => {
  it('rejects more than 16 pairs', () => {
    const metadata = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']));
    expect(() => parseCreateRequest({ metadata })).toThrow(/at most 16 key-value pairs/);
  });

  it('accepts exactly 16 pairs', () => {
    const metadata = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v']));
    expect(parseCreateRequest({ metadata }).metadata).toEqual(metadata);
  });

  it('rejects a key longer than 64 characters without echoing all of it', () => {
    expect(() => parseCreateRequest({ metadata: { ['k'.repeat(65)]: 'v' } })).toThrow(
      /exceeds maximum length of 64/,
    );
  });

  it('rejects a value longer than 512 characters', () => {
    expect(() => parseCreateRequest({ metadata: { note: 'v'.repeat(513) } })).toThrow(
      /exceeds maximum length of 512/,
    );
  });
});

describe('conversation id shapes', () => {
  it('treats an empty conversation id as absent in both wire shapes', () => {
    expect(conversationIdOf({ conversation: '' })).toBeUndefined();
    expect(conversationIdOf({ conversation: { id: '' } })).toBeUndefined();
    // And parsing accepts it: an absent id is not a malformed one.
    expect(parseCreateRequest({ conversation: '' }).conversation).toBe('');
  });
});

describe('starting_after cursor', () => {
  it('clamps a cursor beyond safe-integer range to the same replay effect as Python', () => {
    // Python's int() is arbitrary-precision: a huge positive cursor replays nothing, a huge
    // negative one replays everything.
    expect(parseStartingAfter('99999999999999999999')).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseStartingAfter('-99999999999999999999')).toBe(-1);
  });
});
