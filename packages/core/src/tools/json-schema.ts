import { SchemaResolutionError } from '../errors.js';
import type { StandardSchemaV1 } from './standard-schema.js';
import { isStandardSchema } from './standard-schema.js';

/** A JSON Schema document. Kept intentionally loose: the framework passes it through to providers. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
  [key: string]: unknown;
}

/** Anything `tool({ parameters })` accepts. */
export type SchemaInput = StandardSchemaV1<unknown, unknown> | JsonSchema;

/** An object exposing a JSON Schema conversion method (Zod 4's `toJSONSchema`, or a custom `toJsonSchema`). */
interface JsonSchemaConvertible {
  toJSONSchema?: () => unknown;
  toJsonSchema?: () => unknown;
}

function looksLikeJsonSchema(value: object): boolean {
  const keys = [
    'type',
    'properties',
    'required',
    '$schema',
    '$ref',
    'anyOf',
    'oneOf',
    'allOf',
    'enum',
    'const',
  ];
  return keys.some((key) => key in value);
}

/**
 * Converts a tool's `parameters` declaration into a JSON Schema.
 *
 * Three forms are accepted, in this order:
 *
 * 1. an object exposing `toJSONSchema()` (Zod 4) or `toJsonSchema()` (any other library);
 * 2. a raw JSON Schema object;
 * 3. nothing else — a Standard Schema that cannot be converted throws, so the problem surfaces
 *    when the tool is declared rather than on the first model call.
 *
 * The root `$schema` keyword is removed because several providers reject it inside a function
 * parameter schema.
 *
 * @throws {SchemaResolutionError} When the value cannot be converted.
 */
export function resolveJsonSchema(parameters: SchemaInput): JsonSchema {
  if (typeof parameters !== 'object' || parameters === null) {
    throw new SchemaResolutionError(
      `Tool parameters must be a JSON Schema object or a schema exposing toJSONSchema()/toJsonSchema(), got ${typeof parameters}.`,
    );
  }

  const convertible = parameters as JsonSchemaConvertible;
  const convert =
    typeof convertible.toJSONSchema === 'function'
      ? convertible.toJSONSchema.bind(convertible)
      : typeof convertible.toJsonSchema === 'function'
        ? convertible.toJsonSchema.bind(convertible)
        : undefined;

  if (convert !== undefined) {
    const converted = convert();
    if (typeof converted !== 'object' || converted === null) {
      throw new SchemaResolutionError('toJSONSchema()/toJsonSchema() did not return an object.');
    }
    return stripRootSchemaKeyword(converted as JsonSchema);
  }

  if (isStandardSchema(parameters)) {
    throw new SchemaResolutionError(
      `The '${parameters['~standard'].vendor}' schema implements Standard Schema but exposes no JSON Schema conversion. ` +
        'Standard Schema does not define JSON Schema output; pass a raw JSON Schema object instead, ' +
        'or wrap the schema in an object with a toJsonSchema() method.',
    );
  }

  if (looksLikeJsonSchema(parameters)) {
    return stripRootSchemaKeyword(parameters as JsonSchema);
  }

  throw new SchemaResolutionError(
    'Tool parameters must be a JSON Schema object, or expose toJSONSchema()/toJsonSchema().',
  );
}

function stripRootSchemaKeyword(schema: JsonSchema): JsonSchema {
  if (!('$schema' in schema)) {
    return schema;
  }
  const { $schema: _dropped, ...rest } = schema;
  return rest;
}
