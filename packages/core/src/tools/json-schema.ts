import { SchemaResolutionError } from '../errors.js';
import { isRecord } from '../types/content.js';
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

/**
 * Validates a JSON value against the assertion keywords used by tool parameter schemas.
 *
 * Kept dependency-free so core stays runtime-agnostic. Unknown annotation and extension keywords
 * are ignored; unresolved or external references fail closed because executing a tool without
 * checking the referenced constraints would be unsafe.
 *
 * @internal
 */
export function validateJsonSchema(value: unknown, schema: JsonSchema): string[] {
  const issues: string[] = [];
  validateValue(value, schema, schema, '$', issues, new Set());
  return issues;
}

/**
 * Compiled `pattern` / `patternProperties` regexes, keyed by pattern source. `null` records a
 * pattern that failed to compile, so an invalid pattern is also detected once instead of throwing
 * on every value. Validation runs on every tool invocation while the schemas it sees are static
 * per tool, so the cache stays small and needs no eviction; the cap only guards against a
 * pathological caller generating schemas dynamically.
 */
const patternCache = new Map<string, RegExp | null>();
const PATTERN_CACHE_LIMIT = 5000;

function compilePattern(source: string): RegExp | null {
  const cached = patternCache.get(source);
  if (cached !== undefined) return cached;
  let regex: RegExp | null;
  try {
    regex = new RegExp(source, 'u');
  } catch {
    regex = null;
  }
  if (patternCache.size >= PATTERN_CACHE_LIMIT) patternCache.clear();
  patternCache.set(source, regex);
  return regex;
}

function schemaRecord(schema: unknown): Record<string, unknown> | undefined {
  return isRecord(schema) ? schema : undefined;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  // JSON Schema compares numbers by mathematical value, so -0 and 0 are equal. `Object.is`
  // deliberately distinguishes them and would reject a valid `const: 0` / `enum: [0]` call.
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  }
  const a = schemaRecord(left);
  const b = schemaRecord(right);
  if (a === undefined || b === undefined) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && jsonEqual(a[key], b[key]));
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
    case 'boolean':
      return typeof value === type;
    default:
      return false;
  }
}

/** A JSON Pointer array index: an unsigned base-10 integer with no leading zeros ("0" excepted). */
const ARRAY_INDEX_SEGMENT = /^(?:0|[1-9]\d*)$/;

function resolveLocalReference(root: JsonSchema, reference: string): unknown {
  if (reference === '#') return root;
  if (!reference.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const encoded of reference.slice(2).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      // A pointer can legally cross an array (`#/anyOf/0`); any segment that is not a valid
      // index — including the append token `-` — leaves the reference unresolved.
      if (!ARRAY_INDEX_SEGMENT.test(key)) return undefined;
      const index = Number(key);
      if (index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    const record = schemaRecord(current);
    if (record === undefined || !Object.hasOwn(record, key)) return undefined;
    current = record[key];
  }
  return current;
}

function subIssues(
  value: unknown,
  schema: unknown,
  root: JsonSchema,
  path: string,
  activeReferences: Set<string>,
): string[] {
  const issues: string[] = [];
  validateValue(value, schema, root, path, issues, new Set(activeReferences));
  return issues;
}

function validateValue(
  value: unknown,
  schema: unknown,
  root: JsonSchema,
  path: string,
  issues: string[],
  activeReferences: Set<string>,
): void {
  if (schema === true) return;
  if (schema === false) {
    issues.push(`${path}: schema rejects every value`);
    return;
  }
  const rule = schemaRecord(schema);
  if (rule === undefined) {
    issues.push(`${path}: invalid JSON Schema`);
    return;
  }

  if (typeof rule.$ref === 'string') {
    const referenced = resolveLocalReference(root, rule.$ref);
    if (referenced === undefined) {
      issues.push(`${path}: unsupported or unresolved $ref '${rule.$ref}'`);
      return;
    }
    const referenceKey = `${path}:${rule.$ref}`;
    if (!activeReferences.has(referenceKey)) {
      activeReferences.add(referenceKey);
      validateValue(value, referenced, root, path, issues, activeReferences);
      activeReferences.delete(referenceKey);
    }
  }

  const declaredTypes =
    typeof rule.type === 'string'
      ? [rule.type]
      : Array.isArray(rule.type)
        ? rule.type.filter((item): item is string => typeof item === 'string')
        : [];
  if (declaredTypes.length > 0 && !declaredTypes.some((type) => typeMatches(value, type))) {
    issues.push(`${path}: expected ${declaredTypes.join(' or ')}`);
    return;
  }

  if ('const' in rule && !jsonEqual(value, rule.const)) issues.push(`${path}: value does not match const`);
  if (Array.isArray(rule.enum) && !rule.enum.some((candidate) => jsonEqual(value, candidate))) {
    issues.push(`${path}: value is not in enum`);
  }

  const checkCombinator = (key: 'allOf' | 'anyOf' | 'oneOf'): void => {
    const choices = rule[key];
    if (!Array.isArray(choices)) return;
    const results = choices.map((choice) => subIssues(value, choice, root, path, activeReferences));
    const matches = results.filter((result) => result.length === 0).length;
    if (key === 'allOf') {
      for (const result of results) issues.push(...result);
    } else if (key === 'anyOf' && matches === 0) {
      issues.push(`${path}: value does not match anyOf`);
    } else if (key === 'oneOf' && matches !== 1) {
      issues.push(`${path}: value must match exactly one oneOf schema`);
    }
  };
  checkCombinator('allOf');
  checkCombinator('anyOf');
  checkCombinator('oneOf');
  if ('not' in rule && subIssues(value, rule.not, root, path, activeReferences).length === 0) {
    issues.push(`${path}: value matches forbidden schema`);
  }
  if ('if' in rule) {
    const branch =
      subIssues(value, rule.if, root, path, activeReferences).length === 0 ? rule.then : rule.else;
    if (branch !== undefined) validateValue(value, branch, root, path, issues, activeReferences);
  }

  if (isRecord(value)) {
    validateObject(value, rule, root, path, issues, activeReferences);
  }
  if (Array.isArray(value)) validateArray(value, rule, root, path, issues, activeReferences);
  if (typeof value === 'string') validateString(value, rule, path, issues);
  if (typeof value === 'number') validateNumber(value, rule, path, issues);
}

function validateObject(
  value: Record<string, unknown>,
  rule: Record<string, unknown>,
  root: JsonSchema,
  path: string,
  issues: string[],
  activeReferences: Set<string>,
): void {
  const properties = schemaRecord(rule.properties) ?? {};
  const required = Array.isArray(rule.required)
    ? rule.required.filter((item): item is string => typeof item === 'string')
    : [];
  for (const key of required) {
    if (!Object.hasOwn(value, key)) issues.push(`${path}.${key}: required property is missing`);
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, key)) {
      validateValue(value[key], childSchema, root, `${path}.${key}`, issues, activeReferences);
    }
  }
  const patterns = schemaRecord(rule.patternProperties) ?? {};
  // Compile each pattern once for the whole object. A pattern that does not compile fails closed
  // with the same issue an invalid `pattern` keyword reports: skipping it would silently leave the
  // keys it was meant to constrain unchecked.
  const compiledPatterns: [RegExp, unknown][] = [];
  for (const [pattern, childSchema] of Object.entries(patterns)) {
    const regex = compilePattern(pattern);
    if (regex === null) {
      issues.push(`${path}: schema contains an invalid pattern`);
    } else {
      compiledPatterns.push([regex, childSchema]);
    }
  }
  for (const [key, child] of Object.entries(value)) {
    const declaredProperty = Object.hasOwn(properties, key);
    const matchingPatterns = compiledPatterns.filter(([regex]) => regex.test(key));
    if (matchingPatterns.length > 0) {
      // `properties` and every matching `patternProperties` schema are cumulative in JSON Schema;
      // declaring a key explicitly must not let it bypass its matching patterns.
      for (const [, childSchema] of matchingPatterns) {
        validateValue(child, childSchema, root, `${path}.${key}`, issues, activeReferences);
      }
    } else if (!declaredProperty && rule.additionalProperties === false) {
      issues.push(`${path}.${key}: additional property is not allowed`);
    } else if (
      !declaredProperty &&
      (schemaRecord(rule.additionalProperties) !== undefined ||
        typeof rule.additionalProperties === 'boolean')
    ) {
      validateValue(child, rule.additionalProperties, root, `${path}.${key}`, issues, activeReferences);
    }
  }
  const count = Object.keys(value).length;
  if (typeof rule.minProperties === 'number' && count < rule.minProperties) {
    issues.push(`${path}: expected at least ${rule.minProperties} properties`);
  }
  if (typeof rule.maxProperties === 'number' && count > rule.maxProperties) {
    issues.push(`${path}: expected at most ${rule.maxProperties} properties`);
  }
  const dependentRequired = schemaRecord(rule.dependentRequired);
  if (dependentRequired !== undefined) {
    for (const [key, dependencies] of Object.entries(dependentRequired)) {
      if (!Object.hasOwn(value, key) || !Array.isArray(dependencies)) continue;
      for (const dependency of dependencies) {
        if (typeof dependency === 'string' && !Object.hasOwn(value, dependency)) {
          issues.push(`${path}.${dependency}: property is required by '${key}'`);
        }
      }
    }
  }
}

function validateArray(
  value: unknown[],
  rule: Record<string, unknown>,
  root: JsonSchema,
  path: string,
  issues: string[],
  activeReferences: Set<string>,
): void {
  const prefixItems = Array.isArray(rule.prefixItems) ? rule.prefixItems : [];
  for (let index = 0; index < Math.min(value.length, prefixItems.length); index += 1) {
    validateValue(value[index], prefixItems[index], root, `${path}[${index}]`, issues, activeReferences);
  }
  if (rule.items !== undefined) {
    for (let index = prefixItems.length; index < value.length; index += 1) {
      validateValue(value[index], rule.items, root, `${path}[${index}]`, issues, activeReferences);
    }
  }
  if (typeof rule.minItems === 'number' && value.length < rule.minItems) {
    issues.push(`${path}: expected at least ${rule.minItems} items`);
  }
  if (typeof rule.maxItems === 'number' && value.length > rule.maxItems) {
    issues.push(`${path}: expected at most ${rule.maxItems} items`);
  }
  if (
    rule.uniqueItems === true &&
    value.some((item, index) => value.slice(0, index).some((other) => jsonEqual(item, other)))
  ) {
    issues.push(`${path}: items must be unique`);
  }
}

function validateString(value: string, rule: Record<string, unknown>, path: string, issues: string[]): void {
  const length = [...value].length;
  if (typeof rule.minLength === 'number' && length < rule.minLength) {
    issues.push(`${path}: string is shorter than ${rule.minLength}`);
  }
  if (typeof rule.maxLength === 'number' && length > rule.maxLength) {
    issues.push(`${path}: string is longer than ${rule.maxLength}`);
  }
  if (typeof rule.pattern === 'string') {
    const regex = compilePattern(rule.pattern);
    if (regex === null) {
      issues.push(`${path}: schema contains an invalid pattern`);
    } else if (!regex.test(value)) {
      issues.push(`${path}: string does not match pattern`);
    }
  }
}

function validateNumber(value: number, rule: Record<string, unknown>, path: string, issues: string[]): void {
  if (typeof rule.minimum === 'number' && value < rule.minimum)
    issues.push(`${path}: number is below minimum`);
  if (typeof rule.maximum === 'number' && value > rule.maximum)
    issues.push(`${path}: number is above maximum`);
  if (typeof rule.exclusiveMinimum === 'number' && value <= rule.exclusiveMinimum) {
    issues.push(`${path}: number is not above exclusiveMinimum`);
  }
  if (typeof rule.exclusiveMaximum === 'number' && value >= rule.exclusiveMaximum) {
    issues.push(`${path}: number is not below exclusiveMaximum`);
  }
  if (typeof rule.multipleOf === 'number' && rule.multipleOf > 0) {
    const quotient = value / rule.multipleOf;
    if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * 10) {
      issues.push(`${path}: number is not a multipleOf ${rule.multipleOf}`);
    }
  }
}
