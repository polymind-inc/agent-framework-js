import type { AgentSession } from '../agent/session.js';
import {
  ConfigurationError,
  MiddlewareTerminated,
  ToolInvocationError,
  throwIfAborted,
  UserInputRequiredError,
} from '../errors.js';
import type { FunctionMiddleware, FunctionMiddlewareContext } from '../middleware/middleware.js';
import { runMiddlewareChain, terminateMiddleware } from '../middleware/middleware.js';
import { readRunScope, stripRunScope } from '../middleware/run-scope.js';
import { GEN_AI, GEN_AI_OPERATION } from '../observability/attributes.js';
import { captureMessageContent } from '../observability/settings.js';
import { recordSpanError, setAttr, spanName, withSpan } from '../observability/tracing.js';
import { createResponseStream } from '../streaming/response-stream.js';
import {
  approvalReason,
  functionApprovalRequestContent,
  isApprovalRequest,
  isApprovalResponse,
  isHostedApproval,
} from '../tools/approval.js';
import { formatSchemaIssues, isStandardSchema } from '../tools/standard-schema.js';
import type { AnyFunctionTool, Tool, ToolContext } from '../tools/tool.js';
import { claimInvocation, isFunctionTool, normalizeToolResult } from '../tools/tool.js';
import type {
  Content,
  FunctionApprovalRequestContent,
  FunctionCallContent,
  FunctionResultContent,
  UserInputRequestContent,
} from '../types/content.js';
import type { Message } from '../types/message.js';
import type { ChatResponseUpdate } from '../types/response.js';
import { chatResponseToUpdates, chatResponseUpdate, mergeChatUpdates } from '../types/response.js';
import type { ChatClient, ChatOptions, ChatResponseStream } from './chat-client.js';

/** Tuning for the automatic function-calling loop. */
export interface FunctionInvocationConfig {
  /** Set to `false` to pass calls straight through to the caller. Default `true`. */
  enabled?: boolean;
  /**
   * Maximum number of tool rounds per run. Must be a positive safe integer. Default `40`,
   * matching .NET and Go.
   *
   * On hitting the limit the loop makes one final model call with the function tools removed, so
   * the run always ends with an assistant message rather than an unanswered tool call.
   */
  maxIterations?: number;
  /**
   * Consecutive failing rounds tolerated before the aggregated error is thrown to the caller.
   * Must be a non-negative safe integer. Default `3`. A round without failures resets the
   * counter; unknown-tool ("not found") results are reported to the model but do not count as
   * failures.
   */
  maxConsecutiveErrors?: number;
  /** Stop the loop when the model calls an unknown tool instead of returning an error result. Default `false`. */
  terminateOnUnknownCalls?: boolean;
  /** Tools that can be executed but are not advertised to the model. */
  additionalTools?: AnyFunctionTool[];
  /**
   * Include the underlying error message in the `function_result` sent back to the model.
   * Default `false` — error text reaches the model, so keep this off in production.
   */
  includeDetailedErrors?: boolean;
  /** Run the calls of one model response in parallel. Default `false` (serial), matching all three reference implementations. */
  allowConcurrentInvocations?: boolean;
  /**
   * Function middleware wrapping every tool invocation, outermost first.
   *
   * Per-run middleware is added to these by the agent layer; see `Agent`'s `middleware` option.
   */
  middleware?: readonly FunctionMiddleware[];
}

const DEFAULT_MAX_ITERATIONS = 40;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;
/** What a rejected call reports back to the model. Matches Python's `_tools.py` wording. */
const REJECTED_RESULT_TEXT = 'Error: Tool call invocation was rejected by user.';
/**
 * What a {@link UserInputRequiredError} carrying no requests reports back to the model.
 *
 * Verbatim from Python `_execute_single_function_call`, which answers the same case with
 * `Content.from_function_result(result=…, exception="UserInputRequiredException")`.
 */
const USER_INPUT_UNAVAILABLE_RESULT_TEXT = 'Tool requires user input but no request details were provided.';

/** Validates a numeric loop limit at the configuration boundary. */
function loopLimit(name: 'maxIterations' | 'maxConsecutiveErrors', value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ConfigurationError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

/** A `function_call` this layer is expected to act on, rather than one the provider already ran. */
function isPendingCall(content: Content): content is FunctionCallContent {
  return content.type === 'function_call' && content.informationalOnly !== true;
}

function buildToolMap(
  tools: Tool[] | undefined,
  additionalTools: AnyFunctionTool[],
): Map<string, AnyFunctionTool> {
  const map = new Map<string, AnyFunctionTool>();
  for (const candidate of [...(tools ?? []), ...additionalTools]) {
    if (isFunctionTool(candidate) && !map.has(candidate.name)) {
      map.set(candidate.name, candidate);
    }
  }
  return map;
}

/**
 * Drops function tools for the final, over-budget model call.
 *
 * Mirrors Go `prepareOptionsForLastIteration`: without declarations the model cannot request more
 * local calls, so the run terminates with prose.
 */
function withoutFunctionTools<TOptions extends ChatOptions>(options: TOptions): TOptions {
  const remaining = (options.tools ?? []).filter((candidate) => !isFunctionTool(candidate));
  if (remaining.length === (options.tools ?? []).length) {
    return options;
  }
  const next = { ...options, tools: remaining } as TOptions;
  if (remaining.length === 0) {
    delete next.tools;
    next.toolChoice = 'auto';
  }
  return next;
}

/**
 * The options the next round runs with (Go `updateOptionsForNextIteration`).
 *
 * Three things change between rounds:
 *
 * - a `required` tool choice relaxes to `auto`, or the loop never terminates;
 * - the `continuationToken` is dropped. It resumes a *background* operation, which the provider
 *   answers by fetching the existing response rather than posting a new one. Carried into round
 *   two, the provider would keep re-fetching the response that asked for the tools instead of
 *   receiving their results, and the loop would spin to `maxIterations` empty-handed;
 * - a service-managed `conversationId` advances to the id of the round that just finished, so the
 *   next request continues from the newest turn rather than from the first one (Python
 *   `_tools.py`, Go `responses.go` `SetServiceID`).
 *
 * @param roundConversationId - The `conversationId` of the response this round produced.
 */
function optionsForNextIteration<TOptions extends ChatOptions>(
  options: TOptions,
  roundConversationId?: string,
): TOptions {
  const next = { ...options } as TOptions;

  const choice = options.toolChoice;
  if (choice === 'required' || (typeof choice === 'object' && choice !== null)) {
    next.toolChoice = 'auto';
  }
  if (next.continuationToken !== undefined) {
    delete next.continuationToken;
  }

  const current = options.conversationId;
  if (
    // Only a request that *already* uses service-side storage chains: adopting an id here would
    // silently move a framework-managed transcript to the provider.
    current !== undefined &&
    current !== '' &&
    // A `conv_…` conversation object is stable across responses; only a response chain advances
    // (Go `keepConversationID`).
    !current.startsWith('conv_') &&
    roundConversationId !== undefined &&
    roundConversationId !== '' &&
    roundConversationId !== current
  ) {
    next.conversationId = roundConversationId;
  }
  return next;
}

/**
 * Collects the calls this layer must execute.
 *
 * Calls the provider already answered inside the same response (`function_result` with the same
 * `callId`) are skipped, matching Go `markServerHandledFunctionCalls`. Content objects are never
 * mutated: the caller's messages and any previously returned response stay immutable.
 */
function collectExecutableCalls(messages: Message[]): FunctionCallContent[] {
  const answered = new Set<string>();
  for (const msg of messages) {
    for (const content of msg.contents) {
      if (content.type === 'function_result') {
        answered.add(content.callId);
      }
    }
  }
  const calls: FunctionCallContent[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    for (const content of msg.contents) {
      if (content.type !== 'function_call' || content.informationalOnly === true) {
        continue;
      }
      if (answered.has(content.callId)) {
        continue;
      }
      // One execution per call id. A `callId` is what a result is bound to, so a repeated id can
      // only ever be answered once — but without this, a transcript carrying the same call N times
      // (a caller replaying history, or one deliberately padding the input) executes the tool N
      // times for a single answerable call, which is amplification the caller controls.
      if (seen.has(content.callId)) {
        continue;
      }
      seen.add(content.callId);
      calls.push(content);
    }
  }
  return calls;
}

type InvocationStatus = 'completed' | 'not_found' | 'exception';

interface InvocationResult {
  status: InvocationStatus;
  call: FunctionCallContent;
  /** Whatever the tool — or a middleware standing in for it — produced, before normalization. */
  result?: unknown;
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

/** The two strings an exception `function_result` carries: what the model reads, and the marker. */
interface ExceptionReport {
  /** Replaces the generic `Error: Function failed.` text. */
  result: string;
  /** Replaces the thrown error's message in `FunctionResultContent.exception`. */
  exception: string;
}

/**
 * An invocation whose result has been normalized to what a `function_result` can carry.
 *
 * Normalization happens inside {@link invokeOne}, on purpose: it is the tool's exception boundary,
 * so a return value JSON cannot encode becomes the same result any other failing tool produces
 * instead of throwing out of the loop and failing the run.
 */
interface SettledInvocation {
  status: InvocationStatus;
  call: FunctionCallContent;
  /** Set exactly when `status` is `'completed'` and no approval was raised. */
  result?: string | Content[];
  error?: unknown;
  terminated?: boolean;
  approvalRequest?: FunctionApprovalRequestContent;
  userInputRequests?: UserInputRequestContent[];
  errorReport?: ExceptionReport;
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
interface InvocationEnv {
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
interface RoundOutcome {
  /** The `function_result` items to report to the model. */
  contents: Content[];
  /** Consecutive failing rounds so far, reset by a round without failures. */
  errorCount: number;
  /** Human-input requests raised by middleware or nested agents; sent to the caller, not the model. */
  approvals: UserInputRequestContent[];
  /** `true` when a middleware ended the loop. */
  terminated?: boolean;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      if (captureMessageContent()) {
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
      } else if (settled.userInputRequests === undefined && captureMessageContent()) {
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

/**
 * Wraps a {@link ChatClient} so that tool calls are executed automatically.
 *
 * Implements the function-calling loop of the Python reference implementation
 * (microsoft/agent-framework), mirrored by .NET `FunctionInvokingChatClient` and Go `toolautocall`:
 *
 * - the model is called repeatedly until it stops requesting tools;
 * - every actionable call produces exactly one `function_result`, carrying the call's own
 *   `additionalProperties` so a result stays attributable to the server that asked for it;
 * - unknown tools return an error result (or stop the loop with `terminateOnUnknownCalls`);
 * - a tool declared without `execute` stops the loop so the caller can handle the call;
 * - a tool's `maxInvocations` budget is claimed here, and a spent budget is reported to the model as
 *   a result rather than failing the run;
 * - after `maxIterations` rounds, one final call is made with the function tools removed;
 * - `maxConsecutiveErrors` failing rounds in a row abort the run with the aggregated error.
 *
 * Streaming behaves identically: every inner update is forwarded as it arrives and the generated
 * `function_result` messages are emitted between rounds, so a streamed run and an awaited run
 * produce the same transcript.
 *
 * Beyond the plain loop this layer also owns:
 *
 * - **Approvals.** A round containing a call whose tool declares `approvalMode: 'always_require'`
 *   is held back in full and released to the caller as `function_approval_request` items; the
 *   decisions come back on a later turn, where approved calls are executed and rejections become a
 *   refusal `function_result` the model reads. A round is never split — see `releaseAsApprovals`.
 *   Approvals a provider raised for its own hosted tools are passed straight through.
 * - **Function middleware.** Every invocation runs through `config.middleware` plus whatever the
 *   agent layer attached for the run. A middleware can answer for the tool, recover from its error,
 *   defer the call to a human, or `terminate()` the loop after the round.
 * - **Continuation tokens.** Dropped between rounds, so round two posts the tool results instead of
 *   re-fetching the background response that asked for the tools (`optionsForNextIteration`).
 * - **Service-managed transcripts.** When `conversationId` is set, the next round carries only the
 *   tool results and the id advances to the round that just finished.
 *
 * Message injection from inside a tool is **not** implemented; see {@link ToolContext.injectMessages}.
 *
 * ## Security considerations
 *
 * This layer executes tools with no human in the loop unless they declare
 * `approvalMode: 'always_require'`. See {@link FunctionTool} before declaring tools with side
 * effects, and keep `includeDetailedErrors` off in production — it copies the thrown error's text
 * into the `function_result` the model reads.
 */
export function withFunctionInvocation<TOptions extends ChatOptions>(
  client: ChatClient<TOptions>,
  config: FunctionInvocationConfig = {},
): ChatClient<TOptions> {
  const enabled = config.enabled ?? true;
  const maxIterations = loopLimit('maxIterations', config.maxIterations ?? DEFAULT_MAX_ITERATIONS, 1);
  const maxConsecutiveErrors = loopLimit(
    'maxConsecutiveErrors',
    config.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS,
    0,
  );
  const terminateOnUnknownCalls = config.terminateOnUnknownCalls ?? false;
  const includeDetailedErrors = config.includeDetailedErrors ?? false;
  const allowConcurrentInvocations = config.allowConcurrentInvocations ?? false;
  const additionalTools = config.additionalTools ?? [];
  const configMiddleware = config.middleware ?? [];

  function shouldStop(calls: FunctionCallContent[], tools: Map<string, AnyFunctionTool>): boolean {
    if (calls.length === 0) {
      return true;
    }
    if (tools.size === 0) {
      return terminateOnUnknownCalls;
    }
    for (const call of calls) {
      const target = tools.get(call.name);
      if (target === undefined) {
        if (terminateOnUnknownCalls) {
          return true;
        }
        continue;
      }
      if (target.execute === undefined) {
        // Declaration-only tool: the caller owns the call, so surface it instead of looping.
        return true;
      }
    }
    return false;
  }

  async function runRound(
    calls: FunctionCallContent[],
    tools: Map<string, AnyFunctionTool>,
    errorCount: number,
    env: InvocationEnv,
  ): Promise<RoundOutcome> {
    // Once the error budget is exhausted the next failure is fatal rather than another retry
    // (Go `captureCurrentIterationErrors`).
    const captureErrors = errorCount < maxConsecutiveErrors;
    let results: SettledInvocation[];
    if (allowConcurrentInvocations && calls.length > 1) {
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
      .map((result) => toResultContent(result, includeDetailedErrors));
    const terminated = results.some((result) => result.terminated === true) || approvals.length > 0;
    const stop = terminated ? { terminated: true, approvals } : { approvals };

    // Only failed executions count toward the error budget. An unknown tool reports an exception
    // message to the model but never aborts the run (Go counts only results with a non-nil Error).
    if (!results.some((result) => result.status === 'exception')) {
      return { contents, errorCount: 0, ...stop };
    }

    const nextErrorCount = errorCount + 1;
    if (nextErrorCount > maxConsecutiveErrors) {
      const causes = results.filter((result) => result.status === 'exception').map((result) => result.error);
      const names = [...new Set(calls.map((call) => call.name))].join(', ');
      throw new FunctionInvocationLimitError(
        names,
        `Tool invocation failed ${nextErrorCount} times in a row (maxConsecutiveErrors=${maxConsecutiveErrors}).`,
        causes.length === 1 ? { cause: causes[0] } : { cause: causes },
      );
    }
    return { contents, errorCount: nextErrorCount, ...stop };
  }

  /**
   * Resolves approval decisions the caller sent in with this run.
   *
   * Mirrors Go `processToolApprovalResponses`: approval request/response content is removed from
   * what the provider sees and replaced by the plain `function_call` it wraps, so the model gets a
   * well-formed assistant tool-call followed by tool results. Approved calls are executed here,
   * rejections become a `function_result` the model reads as a refusal.
   *
   * Approvals belonging to a provider-hosted tool ({@link isHostedApproval}) are passed straight
   * through instead: the provider raised them and the provider settles them (Python
   * `_collect_approval_responses`).
   */
  async function resolveInboundApprovals(
    messages: Message[],
    tools: Map<string, AnyFunctionTool>,
    env: InvocationEnv,
  ): Promise<
    | {
        history: Message[];
        emitted: Message[];
        terminated: boolean;
        errorCount: number;
        /** `true` when at least one approved call was executed here (Go's `newMsg != nil`). */
        invoked: boolean;
      }
    | undefined
  > {
    const answered = new Set<string>();
    const respondedCallIds = new Set<string>();
    const requested = new Map<string, FunctionApprovalRequestContent>();
    let hasApprovalContent = false;
    for (const msg of messages) {
      for (const content of msg.contents) {
        if (content.type === 'function_result') {
          answered.add(content.callId);
        } else if (
          (isApprovalRequest(content) || isApprovalResponse(content)) &&
          !isHostedApproval(content)
        ) {
          hasApprovalContent = true;
          if (isApprovalRequest(content)) {
            requested.set(content.functionCall.callId, content);
          } else {
            respondedCallIds.add(content.functionCall.callId);
          }
        }
      }
    }
    if (!hasApprovalContent) {
      return undefined;
    }

    const pending = [...requested.entries()]
      .filter(([callId]) => !answered.has(callId) && !respondedCallIds.has(callId))
      .map(([, request]) => request);

    // Strip every local approval control item from provider-visible history. Answered calls are
    // re-materialized below as assistant tool calls; unanswered requests are returned to the
    // caller again and keep the loop paused.
    const history: Message[] = [];
    const decided = new Map<string, { approved: boolean; call: FunctionCallContent; reason?: string }>();
    for (const msg of messages) {
      const kept: Content[] = [];
      for (const content of msg.contents) {
        if (isHostedApproval(content)) {
          kept.push(content);
          continue;
        }
        if (isApprovalRequest(content)) {
          continue;
        }
        if (isApprovalResponse(content)) {
          const call = content.functionCall;
          if (!answered.has(call.callId) && call.informationalOnly !== true) {
            const reason = approvalReason(content);
            decided.set(call.callId, {
              approved: content.approved,
              call,
              ...(reason === undefined ? {} : { reason }),
            });
          }
          continue;
        }
        if (
          content.type === 'function_call' &&
          content.informationalOnly !== true &&
          respondedCallIds.has(content.callId) &&
          !answered.has(content.callId)
        ) {
          // A middleware-deferred round leaves the *raw* call in the transcript (it was flushed to
          // the caller before the middleware asked for a human), unlike the `approvalMode` path
          // which strips it in `releaseAsApprovals`. The decision below re-materializes the call
          // as `callMessage`, so keeping the replayed original would put the same call id on the
          // wire twice — a stateless-replay 400 on providers that reject duplicate items.
          continue;
        }
        kept.push(content);
      }
      if (kept.length > 0 || msg.contents.length === 0) {
        history.push(kept.length === msg.contents.length ? msg : { ...msg, contents: kept });
      }
    }

    if (decided.size === 0) {
      if (pending.length === 0) {
        return { history, emitted: [], terminated: false, errorCount: 0, invoked: false };
      }
      // No decision arrived, but unanswered requests did (a replayed transcript). Running the
      // model against a history the gated calls were stripped from would answer a conversation
      // in which they never happened, so the requests go back to the caller instead.
      return {
        history,
        emitted: [{ role: 'assistant', contents: pending, messageId: crypto.randomUUID() }],
        terminated: true,
        errorCount: 0,
        invoked: false,
      };
    }

    const decisions = [...decided.values()];
    const callMessage: Message = {
      role: 'assistant',
      contents: decisions.map((decision) => decision.call),
      messageId: crypto.randomUUID(),
    };

    const contents: Content[] = decisions
      .filter((decision) => !decision.approved)
      .map((decision) => ({
        type: 'function_result' as const,
        callId: decision.call.callId,
        result:
          decision.reason === undefined ? REJECTED_RESULT_TEXT : `${REJECTED_RESULT_TEXT} ${decision.reason}`,
        ...inheritedProperties(decision.call),
      }));

    const approved = decisions.filter((decision) => decision.approved).map((decision) => decision.call);
    let outcome: RoundOutcome | undefined;
    if (approved.length > 0) {
      outcome = await runRound(approved, tools, 0, {
        ...env,
        approvedCallIds: new Set(approved.map((call) => call.callId)),
      });
      contents.push(...outcome.contents);
    }

    const resultMessage: Message = { role: 'tool', contents, messageId: crypto.randomUUID() };
    const emitted: Message[] = [callMessage, resultMessage];
    // A middleware can defer an already-approved call a second time (a policy check that only the
    // arguments reveal); the new request goes back to the caller instead of to the model.
    if (outcome !== undefined && outcome.approvals.length > 0) {
      emitted.push({ role: 'assistant', contents: outcome.approvals, messageId: crypto.randomUUID() });
    }
    if (pending.length > 0) {
      emitted.push({ role: 'assistant', contents: pending, messageId: crypto.randomUUID() });
    }
    return {
      history: [...history, callMessage, resultMessage],
      emitted,
      terminated: outcome?.terminated === true || pending.length > 0,
      invoked: outcome !== undefined,
      // The error budget is shared across the whole run, resumed calls included: restarting at
      // zero here would let a tool that fails on every turn be retried forever by re-approving it.
      errorCount: outcome?.errorCount ?? 0,
    };
  }

  /**
   * Releases a buffered round that needs a human, as approval requests.
   *
   * The requests are built from the round's **coalesced** calls rather than from each buffered
   * update (Go `tryReplaceFunctionCallsWithApprovalRequests` converts per update, which is safe
   * there only because its provider never streams argument fragments). A streaming provider
   * delivers `function_call` arguments in pieces — `{"sc`, `ope":"a`, `ll"}` — so converting them
   * one update at a time surfaces one approval per *fragment*: the human is asked to approve
   * `{"sc`, and whichever fragment the decision binds to is not a call anyone can execute.
   * Verified against a live provider, where a single tool call produced six approval requests.
   *
   * Everything else in the tail — streamed prose, provider-answered calls — is passed through
   * untouched, so only the calls themselves are held back.
   */
  function* releaseAsApprovals(
    tail: readonly ChatResponseUpdate[],
    calls: readonly FunctionCallContent[],
  ): Generator<ChatResponseUpdate> {
    for (const update of tail) {
      const kept = update.contents.filter((content) => !isPendingCall(content));
      if (kept.length > 0) {
        yield chatResponseUpdate({ ...update, contents: kept });
      }
    }
    const last = tail[tail.length - 1];
    yield chatResponseUpdate({
      ...(last === undefined ? { role: 'assistant' } : last),
      contents: calls.map((call) => functionApprovalRequestContent(call)),
    });
  }

  async function* loop(
    stream: boolean,
    messages: Message[],
    options: (TOptions & { signal?: AbortSignal }) | undefined,
  ): AsyncGenerator<ChatResponseUpdate> {
    const signal = options?.signal;
    // The run scope is the agent layer's private channel; the provider must never see it.
    const scope = readRunScope(options);
    const env: InvocationEnv = {
      signal,
      middleware: [...configMiddleware, ...(scope?.middleware ?? [])],
      session: scope?.session,
    };
    // The spread is a deliberate defensive copy, not redundancy: stripRunScope only copies when
    // the run-scope key is present, and the inner client must never receive the caller's object.
    let current = stripRunScope({ ...options }) as TOptions & { signal?: AbortSignal };

    const resolved = await resolveInboundApprovals(
      messages,
      buildToolMap(current.tools, additionalTools),
      env,
    );
    // Calls resolved from inbound approvals are part of the same run, so their failures count
    // toward the same budget the loop below spends.
    let errorCount = resolved?.errorCount ?? 0;
    let history = resolved?.history ?? [...messages];
    for (const emittedMessage of resolved?.emitted ?? []) {
      yield chatResponseUpdate({
        contents: emittedMessage.contents,
        role: emittedMessage.role,
        ...(emittedMessage.messageId === undefined ? {} : { messageId: emittedMessage.messageId }),
      });
    }
    if (resolved?.terminated === true) {
      return;
    }
    // Only a round that actually *ran* something advances the options. Go gates the same call on
    // `newMsg != nil` — the message `invokeApprovedToolApprovalResponses` produces, which is `nil`
    // when there are no approved calls (`autocall.go:196` and `:629-644`). A turn that carried only
    // rejections, or only stale approval requests, has not answered the model yet, so relaxing
    // `toolChoice: 'required'` to `'auto'` there lets the model reply with prose to a request that
    // demanded a tool call. The loop below still relaxes after the first real round, which is what
    // keeps it terminating.
    if (resolved?.invoked === true) {
      current = optionsForNextIteration(current);
    }

    for (let iteration = 0; ; iteration++) {
      throwIfAborted(signal);
      const isFinalIteration = iteration >= maxIterations;
      const roundOptions = isFinalIteration ? withoutFunctionTools(current) : current;
      const tools = buildToolMap(roundOptions.tools, additionalTools);
      // Only a round that *could* need approval pays the buffering cost, matching Go's
      // `requiresApproval` fast path: approval is all-or-nothing across a round, so no call can be
      // released to the caller until it is known whether any sibling call needs a human.
      const mayRequireApproval = [...tools.values()].some(
        (candidate) => candidate.approvalMode === 'always_require',
      );

      const inner = client.getResponse(history, roundOptions);
      const updates: ChatResponseUpdate[] = [];
      let flushed = 0;
      let buffering = false;
      if (stream) {
        for await (const update of inner) {
          updates.push(update);
          buffering ||= mayRequireApproval && update.contents.some(isPendingCall);
          if (!buffering) {
            flushed++;
            yield update;
          }
        }
      } else {
        for (const update of chatResponseToUpdates(await inner)) {
          updates.push(update);
        }
        if (!mayRequireApproval) {
          for (const update of updates) {
            flushed++;
            yield update;
          }
        }
      }

      const roundResponse = mergeChatUpdates(updates);
      const calls = collectExecutableCalls(roundResponse.messages);
      const needsApproval = calls.some((call) => tools.get(call.name)?.approvalMode === 'always_require');

      // The buffered tail is released either as-is or rewritten into approval requests. A round is
      // never split: if one call needs a human, every call in it is surfaced for approval, because
      // the caller has no other way to carry the siblings to the next turn.
      if (needsApproval) {
        yield* releaseAsApprovals(updates.slice(flushed), calls);
        return;
      }
      for (const update of updates.slice(flushed)) {
        yield update;
      }

      if (isFinalIteration || shouldStop(calls, tools)) {
        return;
      }

      const outcome = await runRound(calls, tools, errorCount, env);
      const contents = outcome.contents;
      errorCount = outcome.errorCount;

      const toolMessageId = crypto.randomUUID();
      const toolMessage: Message = { role: 'tool', contents, messageId: toolMessageId };
      if (contents.length > 0) {
        yield chatResponseUpdate({ contents, role: 'tool', messageId: toolMessageId });
      }
      if (outcome.approvals.length > 0) {
        yield chatResponseUpdate({
          contents: outcome.approvals,
          role: 'assistant',
          messageId: crypto.randomUUID(),
        });
      }
      if (outcome.terminated === true) {
        // A middleware ended the loop. The results of this round have been reported; the model is
        // not called again (Python re-raises `MiddlewareTermination` out of the tool round).
        return;
      }

      // When the service owns the transcript it already holds this round's request and response,
      // so the next round carries nothing but the tool results (Python
      // `_prepare_messages_for_next_iteration`). Sending the rest again is how the same turn ends
      // up in the conversation twice.
      const serviceOwnsTranscript = current.conversationId !== undefined && current.conversationId !== '';
      history = serviceOwnsTranscript ? [toolMessage] : [...history, ...roundResponse.messages, toolMessage];
      current = optionsForNextIteration(current, roundResponse.conversationId);
    }
  }

  return {
    metadata: client.metadata,
    getResponse(
      messages: Message[],
      options?: TOptions & { signal?: AbortSignal },
    ): ChatResponseStream<unknown> {
      if (!enabled) {
        // Still the layer that owns the run scope, so it is stripped even when the loop is off.
        return client.getResponse(messages, options === undefined ? undefined : stripRunScope(options));
      }
      const init = {
        start: (ctx: { stream: boolean }): AsyncGenerator<ChatResponseUpdate> =>
          loop(ctx.stream, messages, options),
        finalize: (updates: ChatResponseUpdate[]) => mergeChatUpdates<unknown>(updates),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      };
      return createResponseStream(init);
    },
  };
}
