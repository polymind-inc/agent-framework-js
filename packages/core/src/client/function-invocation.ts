import type { AgentSession } from '../agent/session.js';
import { validateSafeInteger } from '../errors.js';
import type { FunctionMiddleware } from '../middleware/middleware.js';
import { createResponseStream } from '../streaming/response-stream.js';
import {
  approvalReason,
  functionApprovalRequestContent,
  isApprovalRequest,
  isApprovalResponse,
  isHostedApproval,
} from '../tools/approval.js';
import type { AnyFunctionTool, Tool, ToolContext } from '../tools/tool.js';
import { isFunctionTool } from '../tools/tool.js';
import type {
  Content,
  ContentType,
  FunctionApprovalRequestContent,
  FunctionApprovalResponseContent,
  FunctionCallContent,
} from '../types/content.js';
import { textContent } from '../types/content.js';
import type { Message } from '../types/message.js';
import type { ChatResponse, ChatResponseUpdate } from '../types/response.js';
import { chatResponseToUpdates, chatResponseUpdate, mergeChatUpdates } from '../types/response.js';
import type { ChatClient, ChatOptions, ChatResponseStream } from './chat-client.js';
import type { InvocationEnv, InvocationRoundConfig, RoundOutcome } from './function-execution.js';
import { rejectedResultContent, runInvocationRound } from './function-execution.js';

/** Tuning for the automatic function-calling loop. */
export interface FunctionInvocationConfig {
  /** Set to `false` to pass calls straight through to the caller. Default `true`. */
  enabled?: boolean;
  /**
   * Maximum number of tool rounds per run. Must be a positive safe integer. Default `40`,
   * matching .NET and Go.
   *
   * On hitting the limit the loop makes one final model call with the function tools removed and
   * `toolChoice: 'none'`. Should the model still answer with a local call or a local approval
   * request, it is removed from that round rather than handed to the caller, and a run left with
   * no answer at all ends on a fixed sentence — so the run always ends with an assistant message
   * rather than an unanswered tool call.
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

/** A `function_call` this layer is expected to act on, rather than one the provider already ran. */
export function isPendingCall(content: Content): content is FunctionCallContent {
  return content.type === 'function_call' && content.informationalOnly !== true;
}

/** Collects the `callId`s answered by a `function_result` anywhere in the transcript. */
export function answeredCallIds(messages: readonly Message[]): Set<string> {
  const answered = new Set<string>();
  for (const msg of messages) {
    for (const content of msg.contents) {
      if (content.type === 'function_result') {
        answered.add(content.callId);
      }
    }
  }
  return answered;
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
 * Prepares the final, over-budget model call.
 *
 * Local function declarations are withdrawn (Go `prepareOptionsForLastIteration`) and the tool
 * choice is pinned to `'none'` (Python's last phase), so the model is asked for prose rather than
 * for calls nobody will run. Provider-hosted declarations stay: the provider executes those
 * itself, and removing them would change what it can report about work it already did.
 */
function withoutFunctionTools<TOptions extends ChatOptions>(options: TOptions): TOptions {
  const remaining = (options.tools ?? []).filter((candidate) => !isFunctionTool(candidate));
  const next = { ...options, toolChoice: 'none' } as TOptions;
  if (remaining.length === 0) {
    delete next.tools;
  } else {
    next.tools = remaining;
  }
  return next;
}

/** The answer a run ends with when the iteration budget ran out before the model produced one. */
const FUNCTION_INVOCATION_LIMIT_FALLBACK_TEXT =
  'Function invocation limit reached before a final answer could be produced.';

/**
 * Content types that are an answer in themselves, alongside non-blank text.
 *
 * Reasoning is deliberately absent: it explains an answer rather than being one, so a round that
 * produced nothing but reasoning still needs the fallback below.
 */
const USER_VISIBLE_CONTENT_TYPES: ReadonlySet<ContentType> = new Set<ContentType>([
  'data',
  'uri',
  'error',
  'hosted_file',
  'hosted_vector_store',
]);

/**
 * Local tool content the final request can neither execute nor answer.
 *
 * Two things qualify: a call this layer would have run (a provider-executed `informationalOnly`
 * call is a report, not a request), and an approval request for a local tool. An approval a
 * provider raised for its own hosted tool is *its* to settle — see {@link isHostedApproval} — so
 * it survives and reaches the caller.
 */
function isUnexecutableLocalContent(content: Content): boolean {
  if (isPendingCall(content)) {
    return true;
  }
  return content.type === 'function_approval_request' && !isHostedApproval(content);
}

/**
 * Whether an update still says something once its contents are gone.
 *
 * `role` is excluded on purpose: every update carries one, so counting it would keep every empty
 * husk. The rest — ids, model, finish reason, continuation token, raw representation — is what a
 * consumer folds into the response, and dropping it would lose response-level facts.
 */
function hasMeaningfulMetadata(update: ChatResponseUpdate): boolean {
  return (
    update.authorName !== undefined ||
    update.responseId !== undefined ||
    update.messageId !== undefined ||
    update.conversationId !== undefined ||
    update.model !== undefined ||
    update.createdAt !== undefined ||
    update.finishReason !== undefined ||
    update.continuationToken !== undefined ||
    (update.additionalProperties !== undefined && Object.keys(update.additionalProperties).length > 0) ||
    update.rawRepresentation !== undefined
  );
}

/**
 * Removes unexecutable local content from one update, returning `undefined` for an update that is
 * left with nothing at all.
 *
 * Applied per update rather than to a buffered round, so everything the update kept keeps flowing
 * at the moment it arrived. The update is never mutated: the same objects are also what the
 * provider's own stream and any layer beneath observe.
 */
function dropUnexecutableLocalContent(update: ChatResponseUpdate): ChatResponseUpdate | undefined {
  if (!update.contents.some(isUnexecutableLocalContent)) {
    return update;
  }
  const kept = update.contents.filter((content) => !isUnexecutableLocalContent(content));
  if (kept.length === 0 && !hasMeaningfulMetadata(update)) {
    return undefined;
  }
  return chatResponseUpdate({ ...update, contents: kept });
}

/** Whether the round left the caller something to read. */
function hasUserVisibleAnswer(response: ChatResponse<unknown>): boolean {
  for (const msg of response.messages) {
    for (const content of msg.contents) {
      if (content.type === 'text') {
        if (content.text.trim() !== '') {
          return true;
        }
      } else if (USER_VISIBLE_CONTENT_TYPES.has(content.type)) {
        return true;
      }
    }
  }
  return false;
}

/** Whether the round left a provider-owned approval for the caller to settle. */
function hasHostedApprovalRequest(response: ChatResponse<unknown>): boolean {
  return response.messages.some((msg) =>
    msg.contents.some((content) => content.type === 'function_approval_request' && isHostedApproval(content)),
  );
}

/**
 * The answer emitted when the final round produced nothing the caller can use.
 *
 * A round left with an empty message — everything it carried was withheld — takes the sentence
 * into that message, which is what the id-less update folds into. Otherwise the sentence opens a
 * message of its own: appending it to a message that kept content would coalesce the two texts
 * into one run of prose, and the fallback is meant to be recognizable verbatim.
 */
function limitFallbackUpdate(response: ChatResponse<unknown>): ChatResponseUpdate {
  const last = response.messages.at(-1);
  const emptiedMessage = last !== undefined && last.contents.length === 0;
  return chatResponseUpdate({
    contents: [textContent(FUNCTION_INVOCATION_LIMIT_FALLBACK_TEXT)],
    role: 'assistant',
    finishReason: 'stop',
    ...(emptiedMessage ? {} : { messageId: crypto.randomUUID() }),
  });
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
 * @param stableConversationId - The provider's declaration of which ids are stable anchors
 *   ({@link ChatClientMetadata.stableConversationId}).
 */
function optionsForNextIteration<TOptions extends ChatOptions>(
  options: TOptions,
  roundConversationId?: string,
  stableConversationId?: (conversationId: string) => boolean,
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
    // An id the provider declares stable is an anchor the service resolves across responses;
    // displacing it with a round's reported id would unhook the run from the stored conversation
    // (the provider-side guard Go keeps in `keepConversationID`). Which ids are stable is the
    // provider's knowledge, so the loop only asks — it never inspects the id itself.
    stableConversationId?.(current) !== true &&
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
  const answered = answeredCallIds(messages);
  const calls: FunctionCallContent[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    for (const content of msg.contents) {
      if (!isPendingCall(content)) {
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
 * - after `maxIterations` rounds, one final call is made with the function tools removed and
 *   `toolChoice: 'none'`, and anything local the model still asks for on that round is dropped
 *   instead of being returned unexecuted;
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
  return createFunctionInvocationClientFactory(client, config)();
}

/**
 * Prepares the function-invocation layer once, then binds values that belong to an individual
 * agent run when that run starts.
 *
 * @internal
 */
export function createFunctionInvocationClientFactory<TOptions extends ChatOptions>(
  client: ChatClient<TOptions>,
  config: FunctionInvocationConfig = {},
): (session?: AgentSession, middleware?: readonly FunctionMiddleware[]) => ChatClient<TOptions> {
  const enabled = config.enabled ?? true;
  const maxIterations = validateSafeInteger(
    'maxIterations',
    config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    1,
  );
  const maxConsecutiveErrors = validateSafeInteger(
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

  const roundConfig: InvocationRoundConfig = {
    allowConcurrentInvocations,
    includeDetailedErrors,
    maxConsecutiveErrors,
  };
  const runRound = (
    calls: FunctionCallContent[],
    tools: Map<string, AnyFunctionTool>,
    errorCount: number,
    env: InvocationEnv,
  ): Promise<RoundOutcome> => runInvocationRound(calls, tools, errorCount, env, roundConfig);

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
    // One pass collects everything the acceptance and retirement rules below need: the position
    // of every content object (per occurrence, keyed by identity), the latest position of each
    // result / request / response, and the approval contents themselves.
    const positions = new WeakMap<object, number>();
    const lastResultPosition = new Map<string, number>();
    const lastRequestPosition = new Map<string, number>();
    const lastRequestPositionByCallId = new Map<string, number>();
    const lastResponsePosition = new Map<string, number>();
    const requested: FunctionApprovalRequestContent[] = [];
    const responses: FunctionApprovalResponseContent[] = [];
    let position = 0;
    for (const msg of messages) {
      for (const content of msg.contents) {
        const contentPosition = position++;
        positions.set(content, contentPosition);
        if (content.type === 'function_result') {
          lastResultPosition.set(content.callId, contentPosition);
        } else if (
          (isApprovalRequest(content) || isApprovalResponse(content)) &&
          !isHostedApproval(content)
        ) {
          if (isApprovalRequest(content)) {
            requested.push(content);
            // A copy replayed while the occurrence is still open does not restart it: only a
            // result ends one. The first copy keeps the position, so a decision that arrived
            // between the copies still answers it instead of being read as preceding a request
            // it never saw. A copy after a result is a genuinely new occurrence and does move it.
            const closingResult = lastResultPosition.get(content.functionCall.callId) ?? -1;
            const openedAt = lastRequestPosition.get(content.id);
            if (openedAt === undefined || openedAt < closingResult) {
              lastRequestPosition.set(content.id, contentPosition);
            }
            const openedAtForCall = lastRequestPositionByCallId.get(content.functionCall.callId);
            if (openedAtForCall === undefined || openedAtForCall < closingResult) {
              lastRequestPositionByCallId.set(content.functionCall.callId, contentPosition);
            }
          } else {
            responses.push(content);
            lastResponsePosition.set(content.id, contentPosition);
          }
        }
      }
    }
    if (requested.length === 0 && responses.length === 0) {
      return undefined;
    }

    const isActionableResponse = (response: FunctionApprovalResponseContent): boolean => {
      const responsePosition = positions.get(response) ?? -1;
      const callId = response.functionCall.callId;
      const resultPosition = lastResultPosition.get(callId) ?? -1;
      // Prefer the exact request id: if it names an older closed occurrence, falling back to a
      // newer request with the same call id would let that stale decision approve the new call.
      // A response whose id names no request is the documented callId-only path, so correlate it
      // with the latest request for that call instead.
      const requestPosition = lastRequestPosition.get(response.id) ?? lastRequestPositionByCallId.get(callId);
      // A result after the response closes that logical occurrence. When a provider reuses a
      // call id, a later request opens a new occurrence even though an older result has the same
      // id. A matched decision must come after that request as well; a response with no request
      // remains accepted only when no prior result makes it ambiguous, preserving the
      // wire-compatible standalone-decision path.
      return requestPosition === undefined
        ? resultPosition < 0
        : requestPosition > resultPosition && responsePosition > requestPosition;
    };
    const respondedCallIds = new Set(
      responses.filter(isActionableResponse).map((response) => response.functionCall.callId),
    );
    const pendingById = new Map<string, FunctionApprovalRequestContent>();
    for (const request of requested.filter((request) => {
      const requestPosition = positions.get(request) ?? -1;
      const resultPosition = lastResultPosition.get(request.functionCall.callId) ?? -1;
      const responsePosition = lastResponsePosition.get(request.id) ?? -1;
      // A request is retired by the response that answers it — matched by id, or, like the
      // standalone-decision path above, by its call's callId alone. The retirement criteria must
      // mirror the acceptance criteria: a decision this turn executes cannot leave its own
      // request pending, or the re-surfaced request would ask the human to approve a call that
      // already ran.
      return (
        requestPosition > resultPosition &&
        requestPosition > responsePosition &&
        !respondedCallIds.has(request.functionCall.callId)
      );
    })) {
      // Session replay may contain the same still-pending control item more than once. Keep its
      // latest copy without asking the human twice; a genuinely reused id after a closed
      // occurrence is the only surviving copy because the earlier request was filtered above.
      pendingById.delete(request.id);
      pendingById.set(request.id, request);
    }
    const pending = [...pendingById.values()];

    // Strip every local approval control item from provider-visible history. Answered calls are
    // re-materialized below as assistant tool calls; unanswered requests are returned to the
    // caller again and keep the loop paused.
    const history: Message[] = [];
    // Keyed by callId: a replayed transcript can carry the same decision more than once, but one
    // call is answered by exactly one result, so only one decision per call may survive — the
    // latest occurrence, like Python, which collects responses into a dict and lets a later
    // entry overwrite an earlier one.
    const decidedByCallId = new Map<
      string,
      { approved: boolean; call: FunctionCallContent; reason?: string }
    >();
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
          if (isActionableResponse(content) && call.informationalOnly !== true) {
            const reason = approvalReason(content);
            decidedByCallId.set(call.callId, {
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
          (positions.get(content) ?? -1) > (lastResultPosition.get(content.callId) ?? -1)
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

    if (decidedByCallId.size === 0) {
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

    const decisions = [...decidedByCallId.values()];
    const callMessage: Message = {
      role: 'assistant',
      contents: decisions.map((decision) => decision.call),
      messageId: crypto.randomUUID(),
    };

    const contents: Content[] = decisions
      .filter((decision) => !decision.approved)
      .map((decision) => rejectedResultContent(decision.call, decision.reason));

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
    session: AgentSession | undefined,
    middleware: readonly FunctionMiddleware[],
  ): AsyncGenerator<ChatResponseUpdate> {
    const signal = options?.signal;
    const env: InvocationEnv = { signal, middleware, session };
    // Keep the inner client isolated from mutations made while advancing tool rounds.
    let current = { ...options } as TOptions & { signal?: AbortSignal };

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
    // when there are no approved calls (Go `autocall.go`). A turn that carried only
    // rejections, or only stale approval requests, has not answered the model yet, so relaxing
    // `toolChoice: 'required'` to `'auto'` there lets the model reply with prose to a request that
    // demanded a tool call. The loop below still relaxes after the first real round, which is what
    // keeps it terminating.
    if (resolved?.invoked === true) {
      current = optionsForNextIteration(current);
    }

    for (let iteration = 0; ; iteration++) {
      signal?.throwIfAborted();
      const isFinalIteration = iteration >= maxIterations;
      const roundOptions = isFinalIteration ? withoutFunctionTools(current) : current;
      const tools = buildToolMap(roundOptions.tools, additionalTools);
      // Only a round that *could* need approval pays the buffering cost, matching Go's
      // `requiresApproval` fast path: approval is all-or-nothing across a round, so no call can be
      // released to the caller until it is known whether any sibling call needs a human.
      const mayRequireApproval = [...tools.values()].some(
        (candidate) => candidate.approvalMode === 'always_require',
      );

      // The final request carries no local function declarations, so a call or approval the
      // provider emits anyway is content this layer will neither execute nor remove later —
      // exactly the unanswered tool call the run promises not to end on. Each update is filtered
      // as it arrives, before it is accumulated or forwarded, so whatever the update kept still
      // reaches the caller at the moment the provider sent it.
      const retained = (update: ChatResponseUpdate): ChatResponseUpdate | undefined =>
        isFinalIteration ? dropUnexecutableLocalContent(update) : update;

      const inner = client.getResponse(history, roundOptions);
      const updates: ChatResponseUpdate[] = [];
      let flushed = 0;
      let buffering = false;
      if (stream) {
        for await (const raw of inner) {
          const update = retained(raw);
          if (update === undefined) {
            continue;
          }
          updates.push(update);
          buffering ||= mayRequireApproval && update.contents.some(isPendingCall);
          if (!buffering) {
            flushed++;
            yield update;
          }
        }
      } else {
        for (const raw of chatResponseToUpdates(await inner)) {
          const update = retained(raw);
          if (update !== undefined) {
            updates.push(update);
          }
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

      if (isFinalIteration) {
        // Only once the round is complete is it known whether anything usable survived. The
        // fallback is appended, never substituted: retained content keeps its place and the
        // sentence is added after it.
        if (!hasUserVisibleAnswer(roundResponse) && !hasHostedApprovalRequest(roundResponse)) {
          yield limitFallbackUpdate(roundResponse);
        }
        return;
      }
      if (shouldStop(calls, tools)) {
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
      current = optionsForNextIteration(
        current,
        roundResponse.conversationId,
        client.metadata.stableConversationId,
      );
    }
  }

  return (session, middleware = []) => ({
    metadata: client.metadata,
    getResponse(
      messages: Message[],
      options?: TOptions & { signal?: AbortSignal },
    ): ChatResponseStream<unknown> {
      if (!enabled) {
        return client.getResponse(messages, options);
      }
      const init = {
        start: (ctx: { stream: boolean }): AsyncGenerator<ChatResponseUpdate> =>
          loop(ctx.stream, messages, options, session, [...configMiddleware, ...middleware]),
        finalize: (updates: ChatResponseUpdate[]) => mergeChatUpdates<unknown>(updates),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      };
      return createResponseStream(init);
    },
  });
}
