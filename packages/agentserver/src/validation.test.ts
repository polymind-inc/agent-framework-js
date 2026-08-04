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
    [{ input: [{ role: 'user' }] }, '$.input[0]'],
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
      '$.input[0]',
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
