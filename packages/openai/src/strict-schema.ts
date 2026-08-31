import type { JsonSchema } from '@polymind-inc/agent-framework-core';
import { ChatClientError } from '@polymind-inc/agent-framework-core';
import { isRecord } from '@polymind-inc/agent-framework-core/internal';

/**
 * JSON Schema keywords the OpenAI strict structured-output decoder does not accept.
 *
 * A schema using any of them cannot be represented in strict mode, and the service rejects the
 * whole request. Dropping the keyword would silently widen or narrow what the caller declared, so
 * the transform refuses instead and names the offending path.
 */
const UNSUPPORTED_KEYWORDS = [
  '$anchor',
  '$dynamicAnchor',
  '$dynamicRef',
  '$recursiveAnchor',
  '$recursiveRef',
  'allOf',
  'contains',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  'dependentRequired',
  'dependentSchemas',
  'dependencies',
  'else',
  'if',
  'maxContains',
  'maxProperties',
  'minContains',
  'minProperties',
  'not',
  'patternProperties',
  'prefixItems',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
  'uniqueItems',
] as const;

/** Keywords holding an array of subschemas. */
const SUBSCHEMA_LISTS = ['anyOf', 'oneOf'] as const;

/** Keywords holding a named map of subschemas. */
const DEFINITION_MAPS = ['$defs', 'definitions'] as const;

function strictSchemaError(path: readonly string[], message: string): ChatClientError {
  const location = path.length > 0 ? path.join('/') : '<root>';
  return new ChatClientError(`strict JSON schema at ${location}: ${message}`);
}

function childPath(path: readonly string[], ...elements: string[]): string[] {
  return [...path, ...elements];
}

function hasType(schema: Record<string, unknown>, want: string): boolean {
  const type = schema.type;
  if (typeof type === 'string') {
    return type === want;
  }
  return Array.isArray(type) && type.includes(want);
}

/**
 * Reads a node's `properties`, distinguishing "absent" from "declared but empty".
 *
 * @throws {ChatClientError} When `properties` is present but not an object.
 */
function readProperties(
  schema: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(schema, 'properties')) {
    return undefined;
  }
  const properties = schema.properties;
  if (!isRecord(properties)) {
    throw strictSchemaError(path, 'properties must be an object');
  }
  return properties;
}

/**
 * Checks `required` against the declared properties before anything is rewritten.
 *
 * A name that is required but never declared cannot be satisfied once the object is closed, so the
 * transform reports it instead of emitting a schema the service would reject.
 *
 * @throws {ChatClientError} When `required` is malformed or names an undeclared property.
 */
function validateRequired(
  schema: Record<string, unknown>,
  properties: Record<string, unknown> | undefined,
  path: readonly string[],
): void {
  if (!Object.hasOwn(schema, 'required')) {
    return;
  }
  const required = schema.required;
  if (!Array.isArray(required)) {
    throw strictSchemaError(path, 'required must be an array of property names');
  }
  for (const name of required) {
    if (typeof name !== 'string') {
      throw strictSchemaError(path, 'required must contain only property names');
    }
    if (properties === undefined || !Object.hasOwn(properties, name)) {
      throw strictSchemaError(path, `required property "${name}" is not declared in properties`);
    }
  }
}

/**
 * Fills `required` with every declared property.
 *
 * Names the caller already listed keep their order and the rest follow sorted, so the same input
 * always produces the same wire payload.
 */
function completeRequired(existing: unknown, properties: Record<string, unknown>): string[] {
  const required: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(existing)) {
    // `validateRequired` already established that every entry is a declared property name.
    for (const name of existing as string[]) {
      if (!seen.has(name)) {
        required.push(name);
        seen.add(name);
      }
    }
  }
  const missing = Object.keys(properties).filter((name) => !seen.has(name));
  missing.sort();
  required.push(...missing);
  return required;
}

/**
 * Rewrites `default` into the node's description.
 *
 * Strict mode has no `default`, and a model that never sees the fallback cannot honour it, so the
 * value is preserved as prose rather than dropped. Every value here has already been through the
 * JSON clone, so re-encoding it always succeeds.
 *
 * @throws {ChatClientError} When the node's `description` is present but not a string.
 */
function moveDefaultIntoDescription(schema: Record<string, unknown>, path: readonly string[]): void {
  if (!Object.hasOwn(schema, 'default')) {
    return;
  }
  const defaultDescription = `Default value: ${JSON.stringify(schema.default)}`;
  const description = schema.description;
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string') {
      throw strictSchemaError(path, 'description must be a string');
    }
    schema.description = `${description} (${defaultDescription})`;
  } else {
    schema.description = defaultDescription;
  }
  delete schema.default;
}

/**
 * Transforms one subschema value in place.
 *
 * @throws {ChatClientError} When the value is not a strict-compatible schema object.
 */
function transformNode(value: unknown, path: readonly string[]): void {
  if (typeof value === 'boolean') {
    // `true` / `false` as a schema has no `properties` to close and no way to spell the closure.
    throw strictSchemaError(path, 'boolean schemas are not supported');
  }
  if (!isRecord(value)) {
    throw strictSchemaError(path, 'schema must be an object or boolean');
  }
  transformObject(value, path);
}

/**
 * Applies the strict contract to one schema node and recurses into every subschema it carries.
 *
 * @throws {ChatClientError} When the node cannot be represented in strict mode.
 */
function transformObject(schema: Record<string, unknown>, path: readonly string[]): void {
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) {
      throw strictSchemaError(path, `unsupported keyword "${keyword}"`);
    }
  }

  const properties = readProperties(schema, path);
  validateRequired(schema, properties, path);

  const hasAdditionalProperties = Object.hasOwn(schema, 'additionalProperties');
  if (hasAdditionalProperties && schema.additionalProperties !== false) {
    // An explicitly open object — `true`, or a schema describing the extra keys — is a shape strict
    // mode cannot express. Forcing it closed would drop data the caller asked for, so it fails.
    throw strictSchemaError(path, 'additionalProperties must be false');
  }
  if (
    hasType(schema, 'object') &&
    (properties === undefined || Object.keys(properties).length === 0) &&
    !hasAdditionalProperties
  ) {
    // An object that declares nothing is only meaningful if it accepts arbitrary keys, which strict
    // mode forbids; closing it would send a schema that can never match anything.
    throw strictSchemaError(
      path,
      'object schema must declare properties or set additionalProperties to false',
    );
  }

  for (const [name, property] of Object.entries(properties ?? {})) {
    transformNode(property, childPath(path, 'properties', name));
  }
  if (Object.hasOwn(schema, 'items')) {
    transformNode(schema.items, childPath(path, 'items'));
  }
  for (const keyword of SUBSCHEMA_LISTS) {
    if (!Object.hasOwn(schema, keyword)) {
      continue;
    }
    const subschemas = schema[keyword];
    if (!Array.isArray(subschemas)) {
      throw strictSchemaError(childPath(path, keyword), 'must be an array of schemas');
    }
    subschemas.forEach((subschema, index) => {
      transformNode(subschema, childPath(path, keyword, `[${index}]`));
    });
  }
  for (const keyword of DEFINITION_MAPS) {
    if (!Object.hasOwn(schema, keyword)) {
      continue;
    }
    const definitions = schema[keyword];
    if (!isRecord(definitions)) {
      throw strictSchemaError(childPath(path, keyword), 'must be an object of schemas');
    }
    for (const [name, definition] of Object.entries(definitions)) {
      transformNode(definition, childPath(path, keyword, name));
    }
  }

  if (properties !== undefined) {
    if (!hasAdditionalProperties) {
      schema.additionalProperties = false;
    }
    schema.required = completeRequired(schema.required, properties);
  }

  moveDefaultIntoDescription(schema, path);
}

/**
 * Validates the root of a strict schema and normalises a single-element `type` array.
 *
 * @throws {ChatClientError} When the root is not a plain object schema.
 */
function validateRoot(schema: Record<string, unknown>): void {
  const type = schema.type;
  if (typeof type === 'string') {
    if (type !== 'object') {
      throw strictSchemaError([], 'root schema must have type object');
    }
  } else if (Array.isArray(type)) {
    if (type.length !== 1 || type[0] !== 'object') {
      throw strictSchemaError([], 'root schema must have type object');
    }
    schema.type = 'object';
  } else {
    throw strictSchemaError([], 'root schema must have type object');
  }
  if (Object.hasOwn(schema, 'anyOf')) {
    // A root union contradicts the required object root, and the service reports the combination
    // only as an opaque 400.
    throw strictSchemaError([], 'root schema must not use anyOf');
  }
}

/**
 * Rewrites a JSON Schema into the closed form the OpenAI strict structured-output decoder accepts.
 *
 * Strict mode requires an object root, `additionalProperties: false` on every object with declared
 * properties, and a `required` list naming all of them; a schema that merely omits those keywords
 * is rejected by the service with an opaque error. The transform therefore adds what is missing and
 * refuses — naming the schema path — anything it cannot express, such as an explicitly open object
 * or a keyword outside the strict subset. Adding the keywords is safe because a model that must
 * emit every property can still express "absent" through a nullable type; silently closing an
 * object the caller deliberately opened would not be.
 *
 * Works on a deep clone, so the caller's schema object is never modified. The clone goes through
 * JSON, which also drops anything the wire could not carry.
 *
 * @throws {ChatClientError} When the schema cannot be represented in strict mode.
 */
export function toStrictJsonSchema(schema: JsonSchema): JsonSchema {
  let clone: unknown;
  try {
    clone = JSON.parse(JSON.stringify(schema)) as unknown;
  } catch (error) {
    throw strictSchemaError([], `schema is not JSON-serializable: ${String(error)}`);
  }
  if (!isRecord(clone)) {
    throw strictSchemaError([], 'root schema must have type object');
  }
  validateRoot(clone);
  transformObject(clone, []);
  return clone as JsonSchema;
}
