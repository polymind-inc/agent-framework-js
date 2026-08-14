import type { AgentSession } from '../agent/session.js';
import {
  errorMessageOf,
  MiddlewareTerminated,
  ToolInvocationError,
  UserInputRequiredError,
} from '../errors.js';
import type { FunctionMiddleware, FunctionMiddlewareContext } from '../middleware/middleware.js';
import { runMiddlewareChain, terminateMiddleware } from '../middleware/middleware.js';
import { GEN_AI, GEN_AI_OPERATION } from '../observability/attributes.js';
import { capturesContent, recordSpanError, setAttr, spanName, withSpan } from '../observability/tracing.js';
import { isApprovalRequest } from '../tools/approval.js';
import { validateJsonSchema } from '../tools/json-schema.js';
import { formatSchemaIssues, isStandardSchema } from '../tools/standard-schema.js';
import type { AnyFunctionTool, ToolContext } from '../tools/tool.js';
import { claimInvocation, normalizeToolResult } from '../tools/tool.js';
import type {
  Content,
  FunctionApprovalRequestContent,
  FunctionCallContent,
  FunctionResultContent,
  UserInputRequestContent,
} from '../types/content.js';

/**
 * What a {@link UserInputRequiredError} carrying no requests reports back to the model.
 *
 * Verbatim from Python `_execute_single_function_call`, which answers the same case with
 * `Content.from_function_result(result=…, exception="UserInputRequiredException")`.
 */
const USER_INPUT_UNAVAILABLE_RESULT_TEXT = 'Tool requires user input but no request details were provided.';
/** What a rejected call reports back to the model. Matches Python's `_tools.py` wording. */
const REJECTED_RESULT_TEXT = 'Error: Tool call invocation was rejected by user.';

type InvocationStatus = 'completed' | 'not_found' | 'exception';

/** The outcome of one tool invocation. `R` is the type `result` carries at this stage. */
interface Invocation<R> {
  status: InvocationStatus;
  call: FunctionCallContent;
  /** Set exactly when `status` is `'completed'` and no approval was raised. */
  result?: R;
  error?: unknown;
  /** A middleware called `terminate()`: report this round, then stop calling the model. */
  terminated?: boolean;
  /** A middleware deferred the call to a human instead of producing a result. */
  approvalRequest?: FunctionApprovalRequestContent;
  /** A tool or nested agent stopped with requests only a human can answer. */
  userInputRequests?: UserInputRequestContent[];
  /**
   * Fixed model-facing text and `exception` marker for an exception this layer raised itself,
   * instead of the generic wording derived from a thrown tool error.
   */
  errorReport?: ExceptionReport;
}

/** Whatever the tool — or a middleware standing in for it — produced, before normalization. */
type InvocationResult = Invocation<unknown>;

/**
 * An invocation whose result has been normalized to what a `function_result` can carry.
 *
 * Normalization happens inside {@link invokeOne}, on purpose: it is the tool's exception boundary,
 * so a return value JSON cannot encode becomes the same result any other failing tool produces
 * instead of throwing out of the loop and failing the run.
 */
type SettledInvocation = Invocation<string | Content[]>;

/** The two strings an exception `function_result` carries: what the model reads, and the marker. */
interface ExceptionReport {
  /** Replaces the generic `Error: Function failed.` text. */
  result: string;
  /** Replaces the thrown error's message in `FunctionResultContent.exception`. */
  exception: string;
}

/**
 * Normalizes a completed invocation's result, turning a failure to do so into an exception result.
 *
 * Covers both invocation paths — the tool's own return value and anything a middleware put in
 * `ctx.result` in its place — because both land here before the round is reported.
 */
function settleResult(outcome: InvocationResult): SettledInvocation {
  const { result: raw, ...rest } = outcome;
  if (
    outcome.status !== 'completed' ||
    outcome.approvalRequest !== undefined ||
    outcome.userInputRequests !== undefined
  ) {
    return rest;
  }
  try {
    return { ...rest, result: normalizeToolResult(raw) };
  } catch (error) {
    return {
      ...rest,
      status: 'exception',
      error: new ToolInvocationError(
        outcome.call.name,
        `Function '${outcome.call.name}' returned a result that could not be encoded for the model.`,
        { cause: error },
      ),
    };
  }
}

/** What one invocation needs from the run around it. */
export interface InvocationEnv {
  signal: AbortSignal | undefined;
  middleware: readonly FunctionMiddleware[];
  session: AgentSession | undefined;
  /**
   * Calls a human has already approved on a previous turn.
   *
   * Surfaced to middleware as `ctx.metadata.approvalResponse` (Python sets the same key), so a
   * policy middleware knows not to ask for the approval it just received.
   */
  approvedCallIds?: ReadonlySet<string>;
}

/** The `metadata` key carrying a previously granted approval into a function middleware. */
export const APPROVAL_RESPONSE_METADATA_KEY = 'approvalResponse';

/** The result of executing one round of tool calls. */
export interface RoundOutcome {
  /** The `function_result` items to report to the model. */
  contents: Content[];
  /** Consecutive failing rounds so far, reset by a round without failures. */
  errorCount: number;
  /** Human-input requests raised by middleware or nested agents; sent to the caller, not the model. */
  approvals: UserInputRequestContent[];
  /** `true` when a middleware ended the loop. */
  terminated?: boolean;
}

export class FunctionInvocationLimitError extends ToolInvocationError {
  constructor(toolName: string, message: string, options?: ErrorOptions) {
    super(toolName, message, options);
    this.name = 'FunctionInvocationLimitError';
  }
}

function parseArguments(
  call: FunctionCallContent,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (typeof call.arguments !== 'string') {
    return { ok: true, value: call.arguments };
  }
  const trimmed = call.arguments.trim();
  if (trimmed === '') {
    return { ok: true, value: {} };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch (error) {
    return { ok: false, message: `Invalid JSON arguments: ${errorMessageOf(error)}` };
  }
}

async function invokeOne(
  call: FunctionCallContent,
  tools: Map<string, AnyFunctionTool>,
  env: InvocationEnv,
): Promise<SettledInvocation> {
  const target = tools.get(call.name);
  if (target === undefined || target.execute === undefined) {
    // An unknown tool never ran, so there is nothing to trace — and nothing for a middleware to
    // wrap either, matching Python, where the pipeline only runs for a resolved tool.
    return { status: 'not_found', call };
  }
  return withSpan(
    spanName(GEN_AI_OPERATION.executeTool, call.name),
    {
      [GEN_AI.operation]: GEN_AI_OPERATION.executeTool,
      [GEN_AI.toolName]: call.name,
      [GEN_AI.toolCallId]: call.callId,
      [GEN_AI.toolType]: 'function',
      ...(target.description === '' ? {} : { [GEN_AI.toolDescription]: target.description }),
    },
    async (span) => {
      if (capturesContent(span)) {
        setAttr(span, GEN_AI.toolArguments, stringifyForSpan(call.arguments));
      }
      // Middleware runs inside the span: a middleware that answers for the tool still produced the
      // result the model sees, and one that only observes should be attributed to the call it wraps.
      let result: InvocationResult;
      try {
        result =
          env.middleware.length === 0
            ? await executeOne(call, target, env)
            : await executeWithMiddleware(call, target, env);
      } catch (error) {
        if (!(error instanceof UserInputRequiredError)) {
          throw error;
        }
        if (error.contents.length === 0) {
          // Nothing a human could settle came with the error, so there is no request to hand the
          // caller — but the run must not die either. Python answers this case with an ordinary
          // exception `function_result` and returns `False` for "terminate", so the loop reports it
          // to the model and carries on; `had_errors` (`content.exception is not None`) then counts
          // the round against the consecutive-error budget exactly like any other tool failure.
          result = {
            status: 'exception',
            call,
            error,
            errorReport: {
              result: USER_INPUT_UNAVAILABLE_RESULT_TEXT,
              // Python writes the exception *type* here rather than its message; the message is
              // still reachable through `includeDetailedErrors`, as for every other failure.
              exception: error.name,
            },
          };
        } else {
          // Python binds requests from an agent tool back to the outer tool call before surfacing
          // them. Keep any sub-agent request id, synthesize one for kinds (OAuth) that lack it, and
          // retain the inner payload so the caller can render the actual approval or consent.
          const userInputRequests = error.contents.map(
            (request): UserInputRequestContent => ({
              ...request,
              callId: call.callId,
              ...(request.id === undefined || request.id === '' ? { id: call.callId } : {}),
              userInputRequest: true,
            }),
          );
          result = { status: 'completed', call, userInputRequests };
        }
      }
      // Normalized here, still inside the boundary, so an unencodable return value is reported to
      // the model rather than thrown out of the round.
      const settled = settleResult(result);
      if (settled.status === 'exception') {
        // Reported to the model as a result rather than thrown, so the span records it explicitly.
        recordSpanError(span, settled.error);
      } else if (settled.userInputRequests === undefined && capturesContent(span)) {
        setAttr(span, GEN_AI.toolResult, stringifyForSpan(settled.result));
      }
      return settled;
    },
  );
}

/**
 * Runs one tool invocation through the function middleware chain.
 *
 * Arguments are parsed and validated *before* the chain, so a middleware inspects what the tool
 * would actually receive rather than the model's raw JSON (Python `FunctionInvocationContext`
 * carries the validated arguments). Everything the chain leaves in the context is then read back:
 *
 * - a `result` with no `error` is what the model is told, whether the tool ran or a middleware
 *   answered for it;
 * - an `error` that no middleware cleared becomes the failure result, so recovery is possible by
 *   assigning `ctx.result`;
 * - a `function_approval_request` is surfaced to the caller instead of the model, which is how
 *   {@link toolApprovalMiddleware} sends a call to a human;
 * - `terminate()` stops the loop after this round.
 */
async function executeWithMiddleware(
  call: FunctionCallContent,
  target: AnyFunctionTool,
  env: InvocationEnv,
): Promise<InvocationResult> {
  const args = await resolveArguments(call, target);
  if (!args.ok) {
    return { status: 'exception', call, error: args.error };
  }

  const ctx: FunctionMiddlewareContext = {
    tool: target,
    callId: call.callId,
    arguments: args.value,
    metadata:
      env.approvedCallIds?.has(call.callId) === true ? { [APPROVAL_RESPONSE_METADATA_KEY]: true } : {},
    terminate(result?: unknown): never {
      if (result !== undefined) {
        ctx.result = result;
      }
      terminateMiddleware();
    },
    ...(env.session === undefined ? {} : { session: env.session }),
    ...(env.signal === undefined ? {} : { signal: env.signal }),
  };

  let terminated = false;
  const final = async (): Promise<void> => {
    const outcome = await runTool(call, target, ctx.arguments, env);
    if (outcome.status === 'exception') {
      ctx.error = outcome.error;
    } else {
      ctx.result = outcome.result;
    }
  };

  try {
    await runMiddlewareChain(env.middleware, ctx, final);
  } catch (error) {
    if (!(error instanceof MiddlewareTerminated)) {
      throw error;
    }
    terminated = true;
  }

  const terminationFlag = terminated ? { terminated: true } : {};
  if (typeof ctx.result === 'object' && ctx.result !== null && isApprovalRequest(ctx.result as Content)) {
    return {
      status: 'completed',
      call,
      approvalRequest: ctx.result as FunctionApprovalRequestContent,
      ...terminationFlag,
    };
  }
  if (ctx.error !== undefined && ctx.result === undefined) {
    return { status: 'exception', call, error: ctx.error, ...terminationFlag };
  }
  return { status: 'completed', call, result: ctx.result, ...terminationFlag };
}

/**
 * Renders a value for a span attribute.
 *
 * Never throws and never yields a non-string: telemetry is an observer, and a value it cannot
 * render must not be able to fail the run it is describing.
 */
function stringifyForSpan(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? `[unserializable ${typeof value}]`;
  } catch {
    return '[unserializable]';
  }
}

async function executeOne(
  call: FunctionCallContent,
  target: AnyFunctionTool,
  env: InvocationEnv,
): Promise<InvocationResult> {
  const args = await resolveArguments(call, target);
  if (!args.ok) {
    return { status: 'exception', call, error: args.error };
  }
  return runTool(call, target, args.value, env);
}

/** Parses the model's argument JSON and validates it against the tool's schema. */
async function resolveArguments(
  call: FunctionCallContent,
  target: AnyFunctionTool,
): Promise<{ ok: true; value: unknown } | { ok: false; error: ToolInvocationError }> {
  const parsed = parseArguments(call);
  if (!parsed.ok) {
    return { ok: false, error: new ToolInvocationError(call.name, parsed.message) };
  }

  if (isStandardSchema(target.parameters)) {
    const validation = await target.parameters['~standard'].validate(parsed.value);
    if (validation.issues !== undefined) {
      // Validation failures are reported to the model as a function_result so it can retry with
      // corrected arguments; the tool body never runs (all three reference implementations).
      return {
        ok: false,
        error: new ToolInvocationError(
          call.name,
          `Invalid arguments: ${formatSchemaIssues(validation.issues)}`,
        ),
      };
    }
    return { ok: true, value: validation.value };
  }
  const issues = validateJsonSchema(parsed.value, target.jsonSchema);
  if (issues.length > 0) {
    return {
      ok: false,
      error: new ToolInvocationError(call.name, `Invalid arguments: ${issues.join('; ')}`),
    };
  }
  return { ok: true, value: parsed.value };
}

/**
 * Runs the tool body. A thrown error becomes a result the model reads, never a failed run.
 *
 * The one exception is {@link UserInputRequiredError}: a sub-agent that stopped for a human has no
 * result the model could act on, so it crosses this inner boundary unchanged. {@link invokeOne}
 * converts its contents into the round's user-input requests — or, when it carries none, into an
 * ordinary exception result — matching Python's `_execute_single_function_call`; every other error
 * is still reported to the model. Neither path fails the run.
 */
async function runTool(
  call: FunctionCallContent,
  target: AnyFunctionTool,
  input: unknown,
  env: InvocationEnv,
): Promise<InvocationResult> {
  if (target.execute === undefined) {
    return { status: 'not_found', call };
  }
  const ctx: ToolContext = {
    callId: call.callId,
    ...(env.signal === undefined ? {} : { signal: env.signal }),
    ...(env.session === undefined ? {} : { session: env.session }),
  };
  try {
    // Inside the try: a spent budget is reported to the model as a result, the same as any other
    // refusal, rather than failing the run.
    claimInvocation(target);
    // `input` was validated against this tool's own schema in resolveArguments; the heterogeneous
    // tool map cannot carry that link in its types, so it is re-attached here.
    const execute = target.execute as (input: unknown, ctx: ToolContext) => unknown;
    return { status: 'completed', call, result: await execute(input, ctx) };
  } catch (error) {
    if (error instanceof UserInputRequiredError) {
      throw error;
    }
    return { status: 'exception', call, error };
  }
}

/**
 * The metadata a generated `function_result` inherits from the call it answers.
 *
 * Python passes `additional_properties=function_call_content.additional_properties` at every site
 * that builds a result for a call it executed — success (`_tools.py:1553`), tool not found
 * (`:1475`), argument parsing failure (`:1527`), a thrown tool body
 * (`_function_execution_error_result`, `:1422`) and a middleware-terminated result (`:1616`) — plus
 * the rejected-approval result (`:2439`). Provider-specific routing lives there: a hosted MCP call
 * carries its `serverLabel`, and Python's own approval bookkeeping reads it back off the call
 * (`_sessions.py` `_approval_controls_to_keep`). Dropping it means the result can no longer be
 * attributed to the server that produced the call.
 */
function inheritedProperties(call: FunctionCallContent): Pick<FunctionResultContent, 'additionalProperties'> {
  return call.additionalProperties === undefined ? {} : { additionalProperties: call.additionalProperties };
}

/** Builds the model-facing result for a call the user rejected. */
export function rejectedResultContent(
  call: FunctionCallContent,
  reason: string | undefined,
): FunctionResultContent {
  return {
    type: 'function_result',
    callId: call.callId,
    result: reason === undefined ? REJECTED_RESULT_TEXT : `${REJECTED_RESULT_TEXT} ${reason}`,
    ...inheritedProperties(call),
  };
}

function toResultContent(result: SettledInvocation, includeDetailedErrors: boolean): FunctionResultContent {
  const inherited = inheritedProperties(result.call);
  if (result.status === 'completed') {
    // Already normalized by `settleResult`; the fallback is the same placeholder it would produce.
    const normalized = result.result ?? 'Success: Function completed.';
    return {
      type: 'function_result',
      callId: result.call.callId,
      result: normalized,
      // Rich output is carried in both shapes: `result` for providers that take text, `items` for
      // providers that can render image or file parts in a tool result (Python
      // `from_function_result`).
      ...(Array.isArray(normalized) ? { items: normalized } : {}),
      ...inherited,
    };
  }
  if (result.status === 'not_found') {
    const text = `Error: Requested function "${result.call.name}" not found.`;
    return {
      type: 'function_result',
      callId: result.call.callId,
      result: text,
      exception: text,
      ...inherited,
    };
  }
  const detail = includeDetailedErrors ? ` Exception: ${errorMessageOf(result.error)}` : '';
  const report = result.errorReport;
  return {
    type: 'function_result',
    callId: result.call.callId,
    result: `${report?.result ?? 'Error: Function failed.'}${detail}`,
    exception: report?.exception ?? errorMessageOf(result.error),
    ...inherited,
  };
}

/** Configuration captured by the outer function-calling loop for each tool round. */
export interface InvocationRoundConfig {
  allowConcurrentInvocations: boolean;
  includeDetailedErrors: boolean;
  maxConsecutiveErrors: number;
}

/** Executes one round of calls and returns the contents the outer loop reports or surfaces. */
export async function runInvocationRound(
  calls: FunctionCallContent[],
  tools: Map<string, AnyFunctionTool>,
  errorCount: number,
  env: InvocationEnv,
  config: InvocationRoundConfig,
): Promise<RoundOutcome> {
  // Once the error budget is exhausted the next failure is fatal rather than another retry
  // (Go `captureCurrentIterationErrors`).
  const captureErrors = errorCount < config.maxConsecutiveErrors;
  let results: SettledInvocation[];
  if (config.allowConcurrentInvocations && calls.length > 1) {
    results = await Promise.all(calls.map((call) => invokeOne(call, tools, env)));
  } else {
    results = [];
    for (const call of calls) {
      const result = await invokeOne(call, tools, env);
      if (!captureErrors && result.status === 'exception') {
        throw result.error;
      }
      results.push(result);
    }
  }

  // A middleware that deferred its call to a human produced an approval request rather than a
  // result: it goes to the caller, not to the model, and the loop stops (Python
  // `_execute_single_function_call` returns the content and flags termination).
  const approvals = results.flatMap((result): UserInputRequestContent[] => [
    ...(result.approvalRequest === undefined ? [] : [result.approvalRequest]),
    ...(result.userInputRequests ?? []),
  ]);
  const contents = results
    .filter((result) => result.approvalRequest === undefined && result.userInputRequests === undefined)
    .map((result) => toResultContent(result, config.includeDetailedErrors));
  const terminated = results.some((result) => result.terminated === true) || approvals.length > 0;
  const stop = terminated ? { terminated: true, approvals } : { approvals };

  // Only failed executions count toward the error budget. An unknown tool reports an exception
  // message to the model but never aborts the run (Go counts only results with a non-nil Error).
  if (!results.some((result) => result.status === 'exception')) {
    return { contents, errorCount: 0, ...stop };
  }

  const nextErrorCount = errorCount + 1;
  if (nextErrorCount > config.maxConsecutiveErrors) {
    const causes = results.filter((result) => result.status === 'exception').map((result) => result.error);
    const names = [...new Set(calls.map((call) => call.name))].join(', ');
    throw new FunctionInvocationLimitError(
      names,
      `Tool invocation failed ${nextErrorCount} times in a row (maxConsecutiveErrors=${config.maxConsecutiveErrors}).`,
      causes.length === 1 ? { cause: causes[0] } : { cause: causes },
    );
  }
  return { contents, errorCount: nextErrorCount, ...stop };
}
