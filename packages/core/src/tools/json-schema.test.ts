import { describe, expect, it } from 'vitest';
import { type JsonSchema, validateJsonSchema } from './json-schema.js';

describe('validateJsonSchema', () => {
  it('supports local references, combinators, and conditional schemas', () => {
    const schema: JsonSchema = {
      $defs: {
        'payload/type': {
          type: 'object',
          properties: {
            kind: { const: 'ok' },
            mode: { enum: ['read', 'write'] },
          },
          required: ['kind', 'mode'],
        },
      },
      $ref: '#/$defs/payload~1type',
      allOf: [{ type: 'object' }],
      anyOf: [{ required: ['kind'] }, false],
      oneOf: [{ properties: { kind: { const: 'ok' } } }, { properties: { kind: { const: 'other' } } }],
      not: { required: ['forbidden'] },
      if: { required: ['flag'] },
      else: { required: ['fallback'] },
    };
    // biome-ignore lint/suspicious/noThenProperty: `then` is a JSON Schema conditional keyword.
    schema.then = { required: ['dependent'] };

    expect(validateJsonSchema({ kind: 'ok', mode: 'read', fallback: true }, schema)).toEqual([]);
    expect(validateJsonSchema({ kind: 'ok', mode: 'write', flag: true, dependent: true }, schema)).toEqual(
      [],
    );
  });

  it('reports reference, schema, type, const, enum, and combinator failures', () => {
    expect(validateJsonSchema('value', false as unknown as JsonSchema)).toEqual([
      '$: schema rejects every value',
    ]);
    expect(validateJsonSchema('value', [] as unknown as JsonSchema)).toEqual(['$: invalid JSON Schema']);
    expect(validateJsonSchema('value', { $ref: 'https://example.test/schema' })).toEqual([
      "$: unsupported or unresolved $ref 'https://example.test/schema'",
    ]);
    expect(validateJsonSchema('value', { $ref: '#/missing' })).toEqual([
      "$: unsupported or unresolved $ref '#/missing'",
    ]);
    expect(validateJsonSchema(1.5, { type: ['integer', null, 'string'] as unknown as string[] })).toEqual([
      '$: expected integer or string',
    ]);
    expect(validateJsonSchema({ a: 1 }, { const: { a: 2 }, enum: [{ a: 3 }] })).toEqual([
      '$: value does not match const',
      '$: value is not in enum',
    ]);
    expect(
      validateJsonSchema('x', { allOf: [{ type: 'number' }], anyOf: [false], oneOf: [true, true] }),
    ).toEqual([
      '$: expected number',
      '$: value does not match anyOf',
      '$: value must match exactly one oneOf schema',
    ]);
    expect(validateJsonSchema('x', { not: { type: 'string' } })).toEqual([
      '$: value matches forbidden schema',
    ]);
  });

  it('resolves a $ref whose pointer ends on an array index', () => {
    // JSON Pointer numeric segments index into arrays; `#/$defs/choice/anyOf/0` is a legal local
    // reference, and leaving it unresolved would fail validation closed on every call.
    const schema: JsonSchema = {
      $defs: { choice: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      $ref: '#/$defs/choice/anyOf/0',
    };

    expect(validateJsonSchema('ok', schema)).toEqual([]);
    expect(validateJsonSchema(1, schema)).toEqual(['$: expected string']);
  });

  it('resolves a $ref crossing an array index and then object keys', () => {
    const schema: JsonSchema = {
      type: 'object',
      prefixItems: [{ properties: { x: { type: 'integer' } } }],
      properties: { y: { $ref: '#/prefixItems/0/properties/x' } },
    };

    expect(validateJsonSchema({ y: 3 }, schema)).toEqual([]);
    expect(validateJsonSchema({ y: 'no' }, schema)).toEqual(['$.y: expected integer']);
  });

  it('fails closed on array segments that are not valid JSON Pointer indices', () => {
    // Only an unsigned base-10 integer without leading zeros indexes an array; anything else —
    // including an out-of-range index and the append token `-` — stays unresolved.
    const defs = { $defs: { choice: { anyOf: [{ type: 'string' }] } } };
    for (const pointer of [
      '#/$defs/choice/anyOf/01',
      '#/$defs/choice/anyOf/1',
      '#/$defs/choice/anyOf/-',
      '#/$defs/choice/anyOf/0x0',
    ]) {
      expect(validateJsonSchema('ok', { ...defs, $ref: pointer })).toEqual([
        `$: unsupported or unresolved $ref '${pointer}'`,
      ]);
    }
  });

  it('validates object properties, patterns, dependencies, and size', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { fixed: { type: 'string' } },
      required: ['fixed', 1] as unknown as string[],
      patternProperties: { '^n': { type: 'number' }, '[': { type: 'boolean' } },
      additionalProperties: false,
      minProperties: 6,
      maxProperties: 2,
      dependentRequired: { fixed: ['companion', 1], ignored: 'not-an-array' },
    };

    expect(validateJsonSchema({ fixed: 1, n1: 'bad', extra: true }, schema)).toEqual(
      expect.arrayContaining([
        '$.fixed: expected string',
        '$.n1: expected number',
        '$.extra: additional property is not allowed',
        '$: expected at least 6 properties',
        '$: expected at most 2 properties',
        "$.companion: property is required by 'fixed'",
      ]),
    );
    expect(validateJsonSchema({ arbitrary: 'bad' }, { additionalProperties: { type: 'number' } })).toEqual([
      '$.arbitrary: expected number',
    ]);
  });

  it('applies properties and every matching patternProperties schema to the same key', () => {
    const schema: JsonSchema = {
      properties: { named: { type: 'string' } },
      patternProperties: {
        '^name': { minLength: 5 },
        ed$: { pattern: '^other' },
      },
    };

    expect(validateJsonSchema({ named: 'x' }, schema)).toEqual([
      '$.named: string is shorter than 5',
      '$.named: string does not match pattern',
    ]);
  });

  it('fails closed on an invalid patternProperties pattern', () => {
    // Same contract as an invalid `pattern`: a pattern that cannot be compiled must report an
    // issue rather than silently letting the keys it would have constrained pass unchecked.
    expect(validateJsonSchema({ anything: 1 }, { patternProperties: { '[': { type: 'boolean' } } })).toEqual([
      '$: schema contains an invalid pattern',
    ]);
    // A valid pattern alongside the invalid one still applies.
    expect(
      validateJsonSchema(
        { n1: 'text' },
        { patternProperties: { '[': { type: 'boolean' }, '^n': { type: 'number' } } },
      ),
    ).toEqual(['$: schema contains an invalid pattern', '$.n1: expected number']);
  });

  it('validates tuple and homogeneous array constraints', () => {
    const issues = validateJsonSchema([1, 'bad', 1], {
      type: 'array',
      prefixItems: [{ type: 'string' }],
      items: { type: 'number' },
      minItems: 4,
      maxItems: 2,
      uniqueItems: true,
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        '$[0]: expected string',
        '$[1]: expected number',
        '$: expected at least 4 items',
        '$: expected at most 2 items',
        '$: items must be unique',
      ]),
    );
  });

  it('validates string and numeric constraints and terminates cyclic references', () => {
    expect(validateJsonSchema('a', { minLength: 2, maxLength: 0, pattern: '^z' })).toEqual([
      '$: string is shorter than 2',
      '$: string is longer than 0',
      '$: string does not match pattern',
    ]);
    expect(validateJsonSchema('a', { pattern: '[' })).toEqual(['$: schema contains an invalid pattern']);
    expect(
      validateJsonSchema(4, {
        minimum: 5,
        maximum: 3,
        exclusiveMinimum: 4,
        exclusiveMaximum: 4,
        multipleOf: 3,
      }),
    ).toEqual([
      '$: number is below minimum',
      '$: number is above maximum',
      '$: number is not above exclusiveMinimum',
      '$: number is not below exclusiveMaximum',
      '$: number is not a multipleOf 3',
    ]);
    expect(validateJsonSchema('ok', { $ref: '#', type: 'string' })).toEqual([]);
    expect(validateJsonSchema('ok', { allOf: [{ $ref: '#' }], type: 'string' })).toEqual([]);
    expect(validateJsonSchema(null, { type: ['null', 'boolean'] })).toEqual([]);
    // JSON numbers compare by mathematical value: negative zero is the same JSON value as zero.
    expect(validateJsonSchema(JSON.parse('-0'), { const: 0, enum: [0] })).toEqual([]);
  });
});
