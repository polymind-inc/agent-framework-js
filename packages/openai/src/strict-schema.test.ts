import type { JsonSchema } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import { toStrictJsonSchema } from './strict-schema.js';
import { toResponsesTextFormat } from './to-openai.js';

/** A Standard Schema that also exposes a JSON Schema, as a schema library would. */
const standardSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate: (value: unknown) => ({ value }),
  },
  toJsonSchema: () => ({ type: 'object', properties: { name: { type: 'string' } } }),
};

/**
 * What a zod 4 object schema converts to, verbatim, minus the `$schema` keyword the framework
 * strips before a provider sees it: closed objects and a complete `required` list at every level.
 * Such a schema already satisfies strict mode, so the transform must be a no-op on it.
 */
const zodDerivedSchema: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
    hobbies: { type: 'array', items: { type: 'string' } },
    nested: {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    },
  },
  required: ['name', 'age', 'hobbies', 'nested'],
  additionalProperties: false,
};

/**
 * Every keyword the strict subset excludes, as `[keyword, node type, value]`. A list rather than an
 * object because one of the keywords is `then`, and an object literal carrying it is a thenable.
 */
const UNSUPPORTED: Array<[string, string, unknown]> = [
  ['$anchor', 'string', 'here'],
  ['$dynamicAnchor', 'string', 'here'],
  ['$dynamicRef', 'string', '#here'],
  ['$recursiveAnchor', 'string', true],
  ['$recursiveRef', 'string', '#'],
  ['allOf', 'string', [{ type: 'string' }]],
  ['contains', 'array', { type: 'string' }],
  ['contentEncoding', 'string', 'base64'],
  ['contentMediaType', 'string', 'text/plain'],
  ['contentSchema', 'string', { type: 'string' }],
  ['dependentRequired', 'object', { value: ['other'] }],
  ['dependentSchemas', 'object', { value: { type: 'string' } }],
  ['dependencies', 'object', { value: ['other'] }],
  ['else', 'string', { type: 'string' }],
  ['if', 'string', { type: 'string' }],
  ['maxContains', 'array', 2],
  ['maxProperties', 'object', 2],
  ['minContains', 'array', 1],
  ['minProperties', 'object', 1],
  ['not', 'string', { type: 'string' }],
  ['patternProperties', 'object', { '^x-': { type: 'string' } }],
  ['prefixItems', 'array', [{ type: 'string' }]],
  ['propertyNames', 'object', { type: 'string' }],
  ['then', 'string', { type: 'string' }],
  ['unevaluatedItems', 'array', false],
  ['unevaluatedProperties', 'object', false],
  ['uniqueItems', 'array', true],
];

describe('toStrictJsonSchema', () => {
  it('closes every object and completes required, recursing through the whole document', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        name: { type: ['string', 'null'] },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { value: { type: 'string' } },
          },
        },
        choice: {
          anyOf: [
            { type: 'object', properties: { a: { type: 'string' } } },
            { type: 'object', properties: { b: { type: 'string' } } },
          ],
        },
        either: {
          oneOf: [{ type: 'object', properties: { c: { type: 'string' } } }],
        },
      },
      required: ['name'],
      $defs: {
        details: { type: 'object', properties: { enabled: { type: 'boolean' } } },
      },
      definitions: {
        legacy: { type: 'object', properties: { old: { type: 'string' } } },
      },
    };

    expect(toStrictJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        name: { type: ['string', 'null'] },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
        choice: {
          anyOf: [
            {
              type: 'object',
              properties: { a: { type: 'string' } },
              required: ['a'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { b: { type: 'string' } },
              required: ['b'],
              additionalProperties: false,
            },
          ],
        },
        either: {
          oneOf: [
            {
              type: 'object',
              properties: { c: { type: 'string' } },
              required: ['c'],
              additionalProperties: false,
            },
          ],
        },
      },
      // The caller's own entry keeps its position; the rest follow in sorted order.
      required: ['name', 'choice', 'either', 'items'],
      additionalProperties: false,
      $defs: {
        details: {
          type: 'object',
          properties: { enabled: { type: 'boolean' } },
          required: ['enabled'],
          additionalProperties: false,
        },
      },
      definitions: {
        legacy: {
          type: 'object',
          properties: { old: { type: 'string' } },
          required: ['old'],
          additionalProperties: false,
        },
      },
    });
  });

  it('leaves the caller schema untouched and returns a fresh document every call', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        nested: { type: 'object', properties: { value: { type: 'string' } } },
      },
    };
    const before = structuredClone(schema);

    const first = toStrictJsonSchema(schema);
    expect(schema).toEqual(before);

    // Mutating a previous result must not leak into the next one.
    first.required = ['corrupted'];
    expect(toStrictJsonSchema(schema).required).toEqual(['name', 'nested']);
    expect(schema).toEqual(before);
  });

  it('normalises a single-element object type array at the root', () => {
    expect(toStrictJsonSchema({ type: ['object'], properties: { a: { type: 'string' } } }).type).toBe(
      'object',
    );
  });

  it('preserves the keywords strict mode supports', () => {
    const properties = {
      text: { type: 'string', minLength: 1, maxLength: 10, pattern: '^[a-z]+$', format: 'email' },
      number: { type: 'number', minimum: 1, maximum: 10, multipleOf: 2 },
      list: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
      choice: { type: 'string', enum: ['a', 'b'] },
      fixed: { const: 'x' },
      reference: { $ref: '#/$defs/details' },
    };
    const strict = toStrictJsonSchema({
      type: 'object',
      title: 'Payload',
      description: 'A payload',
      properties,
      $defs: { details: { type: 'object', properties: { enabled: { type: 'boolean' } } } },
    });

    expect(strict.properties).toEqual(properties);
    expect(strict.title).toBe('Payload');
    expect(strict.description).toBe('A payload');
  });

  it('moves default into the description', () => {
    const strict = toStrictJsonSchema({
      type: 'object',
      properties: {
        described: { type: 'string', description: 'A value', default: 'fallback' },
        bare: { type: 'integer', default: 7 },
        nulled: { type: 'string', description: null, default: 'x' },
      },
    });

    expect(strict.properties).toEqual({
      described: { type: 'string', description: 'A value (Default value: "fallback")' },
      bare: { type: 'integer', description: 'Default value: 7' },
      nulled: { type: 'string', description: 'Default value: "x"' },
    });
  });

  it('rejects a default whose description is not a string', () => {
    expect(() =>
      toStrictJsonSchema({
        type: 'object',
        properties: { value: { type: 'string', description: 42, default: 'x' } },
      }),
    ).toThrow('strict JSON schema at properties/value: description must be a string');
  });

  describe('rejects the keywords strict mode does not support', () => {
    // The framework refuses locally instead of letting the service answer with an opaque 400, and
    // never drops the keyword: silently ignoring it would change what the caller declared.
    for (const [keyword, type, value] of UNSUPPORTED) {
      it(keyword, () => {
        expect(() =>
          toStrictJsonSchema({
            type: 'object',
            properties: { value: { type, [keyword]: value } },
          }),
        ).toThrow(`strict JSON schema at properties/value: unsupported keyword "${keyword}"`);
      });
    }

    it('covers every excluded keyword', () => {
      expect(UNSUPPORTED).toHaveLength(27);
    });
  });

  for (const value of [true, false]) {
    it(`rejects a boolean subschema (${value})`, () => {
      expect(() => toStrictJsonSchema({ type: 'object', properties: { value } })).toThrow(
        'strict JSON schema at properties/value: boolean schemas are not supported',
      );
    });
  }

  it('rejects a non-schema subschema value', () => {
    expect(() => toStrictJsonSchema({ type: 'object', properties: { value: 'string' } })).toThrow(
      'strict JSON schema at properties/value: schema must be an object or boolean',
    );
  });

  it('rejects an explicitly open object with its path', () => {
    expect(() =>
      toStrictJsonSchema({
        type: 'object',
        properties: {
          tags: { type: 'object', additionalProperties: { type: 'string' } },
        },
      }),
    ).toThrow('strict JSON schema at properties/tags: additionalProperties must be false');

    expect(() =>
      toStrictJsonSchema({
        type: 'object',
        properties: {
          extras: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true },
        },
      }),
    ).toThrow('strict JSON schema at properties/extras: additionalProperties must be false');
  });

  it('rejects an implicitly open object', () => {
    expect(() => toStrictJsonSchema({ type: 'object' })).toThrow(
      'strict JSON schema at <root>: object schema must declare properties or set additionalProperties to false',
    );
    expect(() => toStrictJsonSchema({ type: 'object', properties: { nested: { type: 'object' } } })).toThrow(
      'strict JSON schema at properties/nested: object schema must declare properties or set additionalProperties to false',
    );
  });

  it('rejects an object whose declared properties are empty', () => {
    expect(() => toStrictJsonSchema({ type: 'object', properties: {} })).toThrow(
      'strict JSON schema at <root>: object schema must declare properties or set additionalProperties to false',
    );
  });

  it('accepts an empty object that closed itself explicitly', () => {
    expect(toStrictJsonSchema({ type: 'object', properties: {}, additionalProperties: false })).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
      required: [],
    });
  });

  for (const [label, schema] of Object.entries({
    string: { type: 'string' },
    array: { type: 'array', items: { type: 'string' } },
    unconstrained: { properties: { a: { type: 'string' } } },
    union: { type: ['object', 'null'], properties: { a: { type: 'string' } } },
  })) {
    it(`rejects a non-object root: ${label}`, () => {
      expect(() => toStrictJsonSchema(schema as JsonSchema)).toThrow(
        'strict JSON schema at <root>: root schema must have type object',
      );
    });
  }

  it('rejects a root that is not an object at all', () => {
    expect(() => toStrictJsonSchema([{ type: 'object' }] as unknown as JsonSchema)).toThrow(
      'strict JSON schema at <root>: root schema must have type object',
    );
  });

  it('rejects a union at the root', () => {
    expect(() =>
      toStrictJsonSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
        anyOf: [{ type: 'object', properties: { b: { type: 'string' } } }],
      }),
    ).toThrow('strict JSON schema at <root>: root schema must not use anyOf');
  });

  it('rejects a required property that is not declared', () => {
    expect(() =>
      toStrictJsonSchema({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name', 'ghost'],
      }),
    ).toThrow('strict JSON schema at <root>: required property "ghost" is not declared in properties');
  });

  it('rejects a malformed properties, required, union or definition container', () => {
    expect(() => toStrictJsonSchema({ type: 'object', properties: [] as never })).toThrow(
      'strict JSON schema at <root>: properties must be an object',
    );
    expect(() =>
      toStrictJsonSchema({ type: 'object', properties: { a: { type: 'string' } }, required: 'a' as never }),
    ).toThrow('strict JSON schema at <root>: required must be an array of property names');
    expect(() =>
      toStrictJsonSchema({ type: 'object', properties: { a: { type: 'string' } }, required: [1] as never }),
    ).toThrow('strict JSON schema at <root>: required must contain only property names');
    expect(() => toStrictJsonSchema({ type: 'object', properties: { a: { anyOf: {} } } })).toThrow(
      'strict JSON schema at properties/a/anyOf: must be an array of schemas',
    );
    expect(() =>
      toStrictJsonSchema({ type: 'object', properties: { a: { type: 'string' } }, $defs: [] }),
    ).toThrow('strict JSON schema at $defs: must be an object of schemas');
  });

  it('names the failing union branch by index', () => {
    expect(() =>
      toStrictJsonSchema({
        type: 'object',
        properties: {
          choice: {
            anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object' }],
          },
        },
      }),
    ).toThrow(
      'strict JSON schema at properties/choice/anyOf/[1]: object schema must declare properties or set additionalProperties to false',
    );
  });

  it('rejects a schema JSON cannot serialize', () => {
    const schema: JsonSchema = { type: 'object', properties: { a: { type: 'string' } } };
    schema.self = schema;
    expect(() => toStrictJsonSchema(schema)).toThrow(
      /strict JSON schema at <root>: schema is not JSON-serializable/,
    );
  });

  it('keeps an optional nullable property required, as strict mode demands', () => {
    // Strict mode has no notion of an optional property: "absent" is expressed by a nullable type,
    // and the name still has to appear in `required`.
    expect(
      toStrictJsonSchema({
        type: 'object',
        properties: { name: { type: ['string', 'null'] }, email: { type: ['string', 'null'] } },
        required: ['name'],
      }).required,
    ).toEqual(['name', 'email']);
  });

  it('leaves a zod-derived schema that already satisfies strict mode unchanged', () => {
    expect(toStrictJsonSchema(zodDerivedSchema)).toEqual(zodDerivedSchema);
  });
});

describe('toResponsesTextFormat strict handling', () => {
  it('transforms a default-strict raw schema', () => {
    expect(toResponsesTextFormat({ type: 'object', properties: { name: { type: 'string' } } })).toEqual({
      type: 'json_schema',
      name: 'response',
      schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      strict: true,
    });
  });

  it('takes the same path for an explicit strict named format and a Standard Schema', () => {
    const expected = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    };
    expect(
      toResponsesTextFormat({
        name: 'person',
        schema: { type: 'object', properties: { name: { type: 'string' } } },
        strict: true,
      }),
    ).toEqual({ type: 'json_schema', name: 'person', schema: expected, strict: true });
    expect(toResponsesTextFormat(standardSchema as never)).toEqual({
      type: 'json_schema',
      name: 'response',
      schema: expected,
      strict: true,
    });
  });

  it('passes a non-strict schema through structurally unchanged', () => {
    // Deliberately a shape the strict transform would rewrite *and* one it would reject, so the
    // assertion fails if the transform ever runs here.
    const schema: JsonSchema = {
      type: 'object',
      properties: { tags: { type: 'object', additionalProperties: { type: 'string' } } },
    };
    expect(toResponsesTextFormat({ name: 'loose', schema, strict: false })).toEqual({
      type: 'json_schema',
      name: 'loose',
      schema,
      strict: false,
    });
  });

  it('keeps a zod-derived schema at its original wire meaning', () => {
    const before = structuredClone(zodDerivedSchema);
    expect(toResponsesTextFormat({ name: 'person', schema: zodDerivedSchema }).schema).toEqual(before);
    expect(zodDerivedSchema).toEqual(before);
  });

  it('uses a string root title as the format name, and an explicit name wins', () => {
    const schema: JsonSchema = {
      type: 'object',
      title: 'Person',
      properties: { name: { type: 'string' } },
    };
    expect(toResponsesTextFormat(schema).name).toBe('Person');
    expect(toResponsesTextFormat({ schema }).name).toBe('Person');
    expect(toResponsesTextFormat({ name: 'explicit', schema }).name).toBe('explicit');
    // The title stays on the schema: it is a legal annotation, not a framework-only field.
    expect((toResponsesTextFormat(schema).schema as JsonSchema).title).toBe('Person');
  });

  it('falls back to "response" when the title is missing or not a string', () => {
    expect(toResponsesTextFormat({ type: 'object', properties: { a: { type: 'string' } } }).name).toBe(
      'response',
    );
    expect(
      toResponsesTextFormat({ type: 'object', title: 7, properties: { a: { type: 'string' } } }).name,
    ).toBe('response');
    expect(
      toResponsesTextFormat({ type: 'object', title: '', properties: { a: { type: 'string' } } }).name,
    ).toBe('response');
  });

  it('reports an untransformable strict schema with its path', () => {
    expect(() =>
      toResponsesTextFormat({
        type: 'object',
        properties: { tags: { type: 'object', additionalProperties: { type: 'string' } } },
      }),
    ).toThrow('strict JSON schema at properties/tags: additionalProperties must be false');
  });
});
