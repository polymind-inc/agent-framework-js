/**
 * The [Standard Schema v1](https://standardschema.dev) interface, declared locally.
 *
 * `@polymind-inc/agent-framework-core` has no runtime dependencies, so it never imports Zod, Valibot or
 * ArkType — it only accepts any object that implements this shape. Every Standard Schema
 * implementation is structurally compatible.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaProps<Input, Output>;
}

/** The `~standard` property of a {@link StandardSchemaV1}. */
export interface StandardSchemaProps<Input = unknown, Output = Input> {
  readonly version: 1;
  /** The schema library that produced this schema, for example `'zod'`. */
  readonly vendor: string;
  readonly validate: (value: unknown) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  /** Phantom types; present only at compile time. */
  readonly types?: StandardSchemaTypes<Input, Output> | undefined;
}

/** Compile-time-only input/output carriers. */
export interface StandardSchemaTypes<Input, Output> {
  readonly input: Input;
  readonly output: Output;
}

/** The outcome of {@link StandardSchemaProps.validate}. */
export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly value?: undefined; readonly issues: ReadonlyArray<StandardSchemaIssue> };

/** A single validation failure. */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | StandardSchemaPathSegment> | undefined;
}

/** One step of a {@link StandardSchemaIssue} path. */
export interface StandardSchemaPathSegment {
  readonly key: PropertyKey;
}

/** The validated output type of a {@link StandardSchemaV1}. */
export type InferOutput<T> = T extends StandardSchemaV1<unknown, infer Output> ? Output : never;

/** The input type accepted by a {@link StandardSchemaV1}. */
export type InferInput<T> = T extends StandardSchemaV1<infer Input, unknown> ? Input : never;

/** Returns `true` when `value` implements {@link StandardSchemaV1}. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const props = (value as { '~standard'?: unknown })['~standard'];
  return (
    typeof props === 'object' &&
    props !== null &&
    typeof (props as StandardSchemaProps).validate === 'function'
  );
}

/** Renders {@link StandardSchemaIssue}s as a single human- and model-readable message. */
export function formatSchemaIssues(issues: ReadonlyArray<StandardSchemaIssue>): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) => (typeof segment === 'object' ? String(segment.key) : String(segment)))
        .join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}
