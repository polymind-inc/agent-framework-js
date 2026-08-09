import type { AgentSession } from '../agent/session.js';
import { AgentFrameworkError, ConfigurationError, errorMessageOf, ToolInvocationError } from '../errors.js';
import type { Content } from '../types/content.js';
import type { Message } from '../types/message.js';
import type { JsonSchema, SchemaInput } from './json-schema.js';
import { resolveJsonSchema } from './json-schema.js';
import type { StandardSchemaV1 } from './standard-schema.js';

/**
 * Whether a tool call needs human approval before it runs.
 *
 * `'always_require'` interrupts the function-calling loop: the call is surfaced on
 * `response.userInputRequests` and only runs once a matching `approvalResponse` comes back in a
 * later `run()`. Enforcement needs the run to carry the session the request came from.
 */
export type ApprovalMode = 'never_require' | 'always_require';

/** The minimal shape every tool shares. Providers dispatch on {@link Tool.kind}. */
export interface Tool {
  /** Discriminator: `'function'` for local functions; provider packages define their own kinds. */
  readonly kind: string;
  readonly name: string;
  readonly description?: string;
}

/** Runtime information handed to a tool implementation. */
export interface ToolContext {
  /** The `callId` of the model's {@link FunctionCallContent}, for correlating logs and results. */
  callId: string;
  /** Cancels long-running work; propagated from the caller's `run({ signal })`. */
  signal?: AbortSignal;
  /**
   * The session of the run this call belongs to, when the call came through an agent.
   *
   * Present for the same reason Python's `FunctionInvocationContext.session` is: a tool that
   * delegates to another agent needs the caller's conversation state to hand down. `undefined`
   * when the tool was invoked through a bare {@link withFunctionInvocation} client, which has no
   * session.
   *
   * **Shared, mutable state.** Writing to it changes the caller's session; scope anything you keep
   * with {@link AgentSession.partition} rather than writing top-level keys.
   */
  session?: AgentSession;
  /**
   * Injects extra messages into the next model call.
   *
   * **Reserved and not implemented: this is always `undefined` today.** Do not branch on it — the
   * property exists only to keep the name reserved, and its shape may still change when the
   * feature is designed.
   *
   * The reference implementations do not expose injection through the tool context either; they
   * model it as an opt-in pipeline decorator between the function-calling loop and the provider
   * (.NET's `MessageInjectingChatClient`, Go's `MessageInjector`; Python has no equivalent).
   * Implementing it here would likewise mean a new chat-client layer plus session-scoped state,
   * not a callback on this object.
   */
  injectMessages?: (messages: Message[]) => void;
}

/**
 * A locally executable function the model can call.
 *
 * ## Security considerations
 *
 * - **Tools run without confirmation by default.** A tool is invoked as soon as the model asks for
 *   it unless it declares `approvalMode: 'always_require'`. Set that on anything destructive or
 *   irreversible; leaving it at the default means trusting every caller of the agent, and every
 *   document the model has read.
 * - **Tool arguments are model output, not user input.** They can be influenced by anything in the
 *   context window, including text retrieved from documents, web pages or previous tool results
 *   (prompt injection). Validate and authorize inside `execute`; the JSON Schema only constrains
 *   shape, never authority.
 * - **Least privilege.** Give each tool the narrowest capability that makes it useful: scope file
 *   paths, restrict hosts, and pass credentials for the caller rather than for the process.
 * - **Errors are returned to the model.** A thrown error becomes a `function_result` the model
 *   reads. Do not put secrets, credentials or internal endpoints in error messages, and keep
 *   `includeDetailedErrors` off in production.
 */
export interface FunctionTool<TInput = unknown, TOutput = unknown> extends Tool {
  readonly kind: 'function';
  readonly name: string;
  /** Shown to the model; this is what makes the tool discoverable, so be specific. */
  readonly description: string;
  /** A Standard Schema (Zod, Valibot, ArkType, …) or a raw JSON Schema object. */
  readonly parameters: SchemaInput;
  /** The JSON Schema `parameters` resolves to, computed once when the tool is declared. */
  readonly jsonSchema: JsonSchema;
  readonly approvalMode: ApprovalMode;
  /**
   * Caps how often this tool's body may run, across the **lifetime of this tool instance**.
   *
   * Not per run: the counter lives on the tool object and is never reset automatically, so a
   * module-level tool accumulates across every request in the process (Python's semantics and its
   * warning both apply). Use {@link resetInvocationCount} to clear it, or
   * `FunctionInvocationConfig.maxIterations` for a per-run bound.
   *
   * Once spent, further calls are refused *as results the model reads* rather than as a failed
   * run, so the model is told to stop reaching for the tool. Must be at least 1.
   */
  readonly maxInvocations?: number;
  /** Omit to declare the tool without an implementation (the caller handles the call). */
  readonly execute?: (input: TInput, ctx: ToolContext) => TOutput | Promise<TOutput>;
  readonly additionalProperties?: Record<string, unknown>;
}

/**
 * Any function tool, whatever its input and output types.
 *
 * The supertype of every {@link FunctionTool}: `never` / `unknown` sit at the variance-correct
 * extremes, so any concrete tool is assignable here, while `execute` cannot be called without
 * first narrowing — the layer that dispatches validates the arguments against the tool's own
 * schema before invoking it.
 */
export type AnyFunctionTool = FunctionTool<never, unknown>;

/** Resolves the argument type a tool's `execute` receives. */
export type ToolInputOf<TParams> =
  TParams extends StandardSchemaV1<unknown, infer Output> ? Output : Record<string, unknown>;

/** Configuration accepted by {@link tool}. */
export interface FunctionToolConfig<TParams extends SchemaInput, TOutput> {
  name: string;
  description: string;
  parameters: TParams;
  /** Defaults to `'never_require'`. */
  approvalMode?: ApprovalMode;
  maxInvocations?: number;
  execute?: (input: ToolInputOf<TParams>, ctx: ToolContext) => TOutput | Promise<TOutput>;
  additionalProperties?: Record<string, unknown>;
}

/**
 * Declares a function tool.
 *
 * ```ts
 * const getWeather = tool({
 *   name: 'get_weather',
 *   description: 'Get the current weather for a location',
 *   parameters: z.object({ location: z.string() }),
 *   execute: async ({ location }) => `${location} is sunny`,
 * });
 * ```
 *
 * The JSON Schema is resolved eagerly, so an unconvertible `parameters` value throws here rather
 * than on the first model call.
 *
 * ## Security considerations
 *
 * See {@link FunctionTool}. In short: the model chooses the arguments, tools run without
 * confirmation unless `approvalMode: 'always_require'` is set, and anything you throw is shown to
 * the model.
 *
 * @throws {SchemaResolutionError} When `parameters` cannot be converted to a JSON Schema.
 */
export function tool<TParams extends SchemaInput, TOutput = unknown>(
  config: FunctionToolConfig<TParams, TOutput>,
): FunctionTool<ToolInputOf<TParams>, TOutput> {
  if (config.maxInvocations !== undefined && config.maxInvocations < 1) {
    // Python raises the same way. A cap below 1 declares a tool the model can see and can never
    // use, which is a configuration mistake rather than a runtime state worth reporting.
    throw new ConfigurationError('maxInvocations must be at least 1.');
  }
  const declared: FunctionTool<ToolInputOf<TParams>, TOutput> = {
    kind: 'function',
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    jsonSchema: resolveJsonSchema(config.parameters),
    approvalMode: config.approvalMode ?? 'never_require',
    ...(config.maxInvocations === undefined ? {} : { maxInvocations: config.maxInvocations }),
    ...(config.execute === undefined ? {} : { execute: config.execute }),
    ...(config.additionalProperties === undefined
      ? {}
      : { additionalProperties: config.additionalProperties }),
  };
  return declared;
}

/** Returns `true` when `value` is a {@link FunctionTool}. */
export function isFunctionTool(value: Tool): value is AnyFunctionTool {
  return value.kind === 'function';
}

/**
 * How many times each tool's body has run, for {@link FunctionTool.maxInvocations}.
 *
 * A `WeakMap` rather than a field: `FunctionTool` is a plain readonly object, and the count is
 * mutable bookkeeping that must not appear on the wire, in a serialized session, or in the
 * declaration sent to the model. Keying on the tool object also gives Python's scope exactly —
 * per tool *instance*, for as long as that instance lives.
 */
const invocationCounts = new WeakMap<AnyFunctionTool, number>();

/** How many times `tool`'s body has run (Python's `FunctionTool.invocation_count`). */
export function invocationCountOf(tool: AnyFunctionTool): number {
  return invocationCounts.get(tool) ?? 0;
}

/**
 * Clears `tool`'s invocation count.
 *
 * The counter is never reset automatically, so a long-lived tool with a `maxInvocations` cap needs
 * this to become usable again — for example at the start of each request when the tool is a
 * module-level singleton.
 */
export function resetInvocationCount(tool: AnyFunctionTool): void {
  invocationCounts.delete(tool);
}

/**
 * Records one invocation of `tool`, or throws when its budget is already spent.
 *
 * Called immediately before the body runs — after the model's arguments are parsed and validated,
 * matching Python, where `invoke` parses first and only then reaches the check in `__call__`. A
 * call the tool never received therefore cannot consume its budget, and neither can a middleware
 * that answers in the tool's place.
 *
 * @throws {ToolInvocationError} When `maxInvocations` has been reached.
 */
export function claimInvocation(tool: AnyFunctionTool): void {
  const limit = tool.maxInvocations;
  if (limit === undefined) {
    return;
  }
  const used = invocationCounts.get(tool) ?? 0;
  if (used >= limit) {
    throw new ToolInvocationError(
      tool.name,
      `Function '${tool.name}' has reached its maximum invocation limit, you can no longer use this tool.`,
    );
  }
  invocationCounts.set(tool, used + 1);
}

/**
 * Normalizes a tool's return value into the `result` of a `function_result` content item.
 *
 * - `string` is kept as-is;
 * - a `Content[]` is kept as-is so rich results (images, files) survive;
 * - `undefined` and `null` become the reference implementations' success placeholder;
 * - anything else is JSON-encoded.
 *
 * The declared return type is exact: a value JSON cannot represent is **refused**, not passed
 * through. `JSON.stringify` answers `undefined` for a symbol or a function and throws for a
 * `BigInt` or a cycle, and neither is a `string | Content[]`. Handing the `undefined` back
 * produced a `function_result` with no result at all — the model was told a tool succeeded and
 * shown nothing — and letting the `TypeError` out of an unguarded call site failed the whole run.
 *
 * Callers must invoke this inside a tool's exception boundary, where the throw becomes the same
 * `function_result` any other failing tool produces; `withFunctionInvocation` does exactly that.
 * Go behaves the same way: `json.Marshal` failing in `agenttool` is returned as the call's error.
 *
 * @throws {AgentFrameworkError} When `value` cannot be JSON-encoded.
 */
export function normalizeToolResult(value: unknown): string | Content[] {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return 'Success: Function completed.';
  }
  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'object' && item !== null && 'type' in item)
  ) {
    return value as Content[];
  }
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new AgentFrameworkError(
      `A tool returned a value that cannot be JSON-encoded: ${errorMessageOf(error)}`,
      { cause: error },
    );
  }
  if (encoded === undefined) {
    // Symbols and functions; also any value whose `toJSON` answers `undefined`.
    throw new AgentFrameworkError(
      `A tool returned a value of type '${typeof value}', which JSON cannot represent.`,
    );
  }
  return encoded;
}
