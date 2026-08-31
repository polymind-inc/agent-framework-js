import type { AgentSession } from '../agent/session.js';
import { createResponseStream } from '../streaming/response-stream.js';
import {
  approvalResponse,
  isApprovalRequest,
  isApprovalResponse,
  isHostedApproval,
  isMiddlewareApproval,
} from '../tools/approval.js';
import type { AnyFunctionTool, Tool } from '../tools/tool.js';
import { isFunctionTool } from '../tools/tool.js';
import type {
  Content,
  FunctionApprovalRequestContent,
  FunctionApprovalResponseContent,
  FunctionCallContent,
} from '../types/content.js';
import { isRecord } from '../types/content.js';
import type { Message } from '../types/message.js';
import type { ChatResponseUpdate } from '../types/response.js';
import { chatResponseUpdate, mergeChatUpdates } from '../types/response.js';
import type { ChatClient, ChatOptions, ChatResponseStream } from './chat-client.js';
import { updatesOf } from './provider-utils.js';

/** The {@link AgentSession.state} slot this layer owns. */
export const APPROVAL_STATE_KEY = '_toolApproval';

/**
 * Where the approval layer keeps the requests it has surfaced.
 *
 * The state has to outlive a single `run()` — a human answers on a later turn, in a different
 * process — so it lives in the session rather than on the client.
 */
export interface ApprovalStateStore {
  /** Reads and clears the requests surfaced to the caller on the previous turn. */
  takePending(): FunctionApprovalRequestContent[];
  /** Records newly surfaced requests, de-duplicating by id. */
  addPending(requests: readonly FunctionApprovalRequestContent[]): void;
  /** Reads and clears the requests that were suppressed because their tool needs no approval. */
  takeAutoApproved(): FunctionApprovalRequestContent[];
  /** Holds suppressed requests for pre-approved replay on the next turn. */
  setAutoApproved(requests: readonly FunctionApprovalRequestContent[]): void;
}

/**
 * Snapshots a request so a later mutation of the caller-visible object cannot change what the
 * decision is bound against (.NET `SnapshotRequest`). Also drops `rawRepresentation`, which is
 * never serializable.
 */
function snapshot(request: FunctionApprovalRequestContent): FunctionApprovalRequestContent {
  const call = request.functionCall;
  return {
    type: 'function_approval_request',
    id: request.id,
    userInputRequest: true,
    ...(request.callId === undefined ? {} : { callId: request.callId }),
    // Kept because it carries why the request exists — `requiredByMiddleware` above all, which the
    // bypass layer reads on the turn that replays it.
    ...(request.additionalProperties === undefined
      ? {}
      : { additionalProperties: structuredClone(request.additionalProperties) }),
    functionCall: {
      type: 'function_call',
      callId: call.callId,
      name: call.name,
      arguments: typeof call.arguments === 'string' ? call.arguments : structuredClone(call.arguments),
      ...(call.informationalOnly === undefined ? {} : { informationalOnly: call.informationalOnly }),
      ...(call.additionalProperties === undefined
        ? {}
        : { additionalProperties: structuredClone(call.additionalProperties) }),
    },
  };
}

function readSlot(state: Record<string, unknown>, key: string): FunctionApprovalRequestContent[] {
  const value = state[key];
  return Array.isArray(value) ? (value as FunctionApprovalRequestContent[]) : [];
}

/**
 * Backs an {@link ApprovalStateStore} with a session's state, so it survives serialization.
 *
 * The state slot is only materialized on the first write: a run that never surfaces an approval
 * leaves the session exactly as it found it.
 */
export function sessionApprovalStore(session: AgentSession): ApprovalStateStore {
  const peek = (): Record<string, unknown> => {
    const existing = session.state[APPROVAL_STATE_KEY];
    return isRecord(existing) ? existing : {};
  };
  const take = (slot: string): FunctionApprovalRequestContent[] => {
    const state = peek();
    const value = readSlot(state, slot);
    delete state[slot];
    if (Object.keys(state).length === 0) {
      delete session.state[APPROVAL_STATE_KEY];
    }
    return value;
  };
  const put = (slot: string, requests: readonly FunctionApprovalRequestContent[]): void => {
    if (requests.length === 0) {
      return;
    }
    session.partition(APPROVAL_STATE_KEY)[slot] = requests.map(snapshot);
  };

  return {
    takePending: () => take('pending'),
    addPending(requests: readonly FunctionApprovalRequestContent[]): void {
      if (requests.length === 0) {
        return;
      }
      const pending = readSlot(peek(), 'pending');
      const known = new Set(pending.map((request) => request.id));
      const merged = [...pending];
      for (const request of requests) {
        if (!known.has(request.id)) {
          known.add(request.id);
          merged.push(request);
        }
      }
      put('pending', merged);
    },
    takeAutoApproved: () => take('autoApproved'),
    setAutoApproved(requests: readonly FunctionApprovalRequestContent[]): void {
      take('autoApproved');
      put('autoApproved', requests);
    },
  };
}

function sameCall(a: FunctionCallContent, b: FunctionCallContent): boolean {
  if (a.callId !== b.callId || a.name !== b.name) {
    return false;
  }
  const argsOf = (call: FunctionCallContent): string =>
    typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments);
  return argsOf(a) === argsOf(b);
}

/**
 * One logical approval: a request that was issued, and everything that has settled it since.
 *
 * A request id cannot stand in for this. Local ids are derived from the call id, so a provider
 * that reuses a call id issues a second request under the *same* id — two occurrences that a
 * decision names identically.
 */
interface ApprovalOccurrence {
  /** The id a decision names. Repeats across occurrences of a reused call id. */
  readonly id: string;
  /** The call this occurrence gates. A `function_result` naming it closes the occurrence. */
  readonly callId: string;
  /** The record a decision binds against — the stored snapshot whenever there is one. */
  request: FunctionApprovalRequestContent;
  /** A `function_result` for {@link callId} arrived after the request. */
  closed: boolean;
  /** A decision has already been bound here; one decision settles one occurrence. */
  answered: boolean;
}

/** What one pass over the input transcript says about the approvals it describes. */
interface ApprovalScan {
  /** Every occurrence the transcript opened, in the order it opened them. */
  readonly occurrences: ApprovalOccurrence[];
  /** The occurrence each decision settles, keyed by the decision object itself. */
  readonly bound: Map<FunctionApprovalResponseContent, ApprovalOccurrence>;
  /** Decisions naming an id the transcript has no open occurrence for, in transcript order. */
  readonly unbound: FunctionApprovalResponseContent[];
  /** Whether the turn carries any decision of ours at all. */
  hasDecision: boolean;
}

/**
 * Derives the approval occurrences of the current input transcript, in transcript order.
 *
 * A request opens an occurrence; a `function_result` naming its call closes every occurrence for
 * that call; a decision settles the one still open under its id. So a request that appears after
 * the latest result for its call is a *new* occurrence, and neither an older result nor the
 * decision that closed the older occurrence reaches it.
 *
 * Nothing derived here is persisted. The boundaries are recomputed from the messages of every
 * run, which is what keeps a serialized session free of transcript positions.
 */
function scanOccurrences(messages: readonly Message[]): ApprovalScan {
  const scan: ApprovalScan = { occurrences: [], bound: new Map(), unbound: [], hasDecision: false };
  /** The occurrence a decision would currently settle, per id. */
  const open = new Map<string, ApprovalOccurrence>();

  for (const msg of messages) {
    for (const content of msg.contents) {
      if (content.type === 'function_result') {
        // An empty call id names nothing — wire items that lost theirs must not close an
        // unrelated occurrence.
        if (content.callId !== '') {
          for (const [id, occurrence] of open) {
            if (occurrence.callId === content.callId) {
              occurrence.closed = true;
              open.delete(id);
            }
          }
        }
        continue;
      }
      if (isHostedApproval(content)) {
        // Not ours to bind: the provider issued it and the provider settles it.
        continue;
      }
      if (isApprovalRequest(content)) {
        const current = open.get(content.id);
        if (current !== undefined && current.callId === content.functionCall.callId) {
          // A replayed copy of an occurrence that is still open. The first copy stays canonical,
          // so a doctored replay neither displaces it nor asks the human a second time. A decision
          // having already settled it makes no difference: only a result ends an occurrence, so a
          // copy replayed after its own decision is still that same occurrence, and opening a new
          // one would ask again for what the human just granted.
          continue;
        }
        const occurrence: ApprovalOccurrence = {
          id: content.id,
          callId: content.functionCall.callId,
          request: content,
          closed: false,
          answered: false,
        };
        scan.occurrences.push(occurrence);
        open.set(content.id, occurrence);
      } else if (isApprovalResponse(content)) {
        scan.hasDecision = true;
        const current = open.get(content.id);
        if (current === undefined || current.answered) {
          scan.unbound.push(content);
        } else {
          current.answered = true;
          scan.bound.set(content, current);
        }
      }
    }
  }
  return scan;
}

/**
 * Folds the requests the store surfaced on an earlier turn into the scanned occurrences.
 *
 * A stored request records what a human was actually shown, so it outranks any copy the caller
 * replayed — but only for the occurrence it was surfaced for, which is the newest one still open
 * under its id. A store entry the transcript does not mention at all (a caller that echoes only
 * the decision, or a service-managed transcript that never replays history) becomes an occurrence
 * of its own, and the decision that arrived with nothing to bind against settles it.
 */
function mergeStoredRequests(scan: ApprovalScan, stored: readonly FunctionApprovalRequestContent[]): void {
  for (const request of stored) {
    let target: ApprovalOccurrence | undefined;
    for (const occurrence of scan.occurrences) {
      if (occurrence.id === request.id && !occurrence.closed) {
        target = occurrence;
      }
    }
    if (target !== undefined) {
      target.request = request;
      continue;
    }
    const occurrence: ApprovalOccurrence = {
      id: request.id,
      callId: request.functionCall.callId,
      request,
      closed: false,
      answered: false,
    };
    scan.occurrences.push(occurrence);
    const index = scan.unbound.findIndex((response) => response.id === request.id);
    const response = index < 0 ? undefined : scan.unbound.splice(index, 1)[0];
    if (response !== undefined) {
      occurrence.answered = true;
      scan.bound.set(response, occurrence);
    }
  }
}

/**
 * Binds each inbound approval decision to the request occurrence the framework actually issued.
 *
 * Mirrors .NET `ApprovalResponseBindingChatClient`. Requests are known from two places: the store
 * (for callers that echo only the decision) and the message history itself (for callers that
 * replay the whole transcript). A decision that settles no open occurrence is dropped, and one
 * whose `functionCall` differs from the recorded call is rebound to the recorded one.
 *
 * Correlation is per occurrence rather than per call id: a completed call cannot retire the
 * request a provider raised afterwards under the same id, and the decision that authorized the
 * completed one cannot authorize the new one, because it settled an occurrence the result closed.
 * This matches how the invocation loop underneath decides which decisions are actionable.
 *
 * ## Security considerations
 *
 * **The store wins.** A request that came out of the store is the record of what a human was
 * actually shown; one read out of the message history is whatever the caller sent this turn. When
 * both describe the same occurrence the stored one is kept, so replaying a doctored copy of a
 * request cannot change the arguments an already-granted decision authorizes.
 */
function bindInboundDecisions(messages: readonly Message[], store: ApprovalStateStore): Message[] {
  const scan = scanOccurrences(messages);
  mergeStoredRequests(scan, store.takePending());
  const stillPending = (): FunctionApprovalRequestContent[] =>
    scan.occurrences
      .filter((occurrence) => !occurrence.closed && !occurrence.answered)
      .map((occurrence) => occurrence.request);

  if (!scan.hasDecision) {
    // `takePending` is destructive, but an unrelated turn must not consume approvals that the
    // caller has not answered yet.
    store.addPending(stillPending());
    return [...messages];
  }

  const out: Message[] = [];
  for (const msg of messages) {
    const kept: Content[] = [];
    let changed = false;
    for (const content of msg.contents) {
      if (!isApprovalResponse(content) || isHostedApproval(content)) {
        kept.push(content);
        continue;
      }
      const matched = scan.bound.get(content);
      if (matched === undefined) {
        // A decision for a request this session never issued — or a replayed duplicate that finds
        // its occurrence already settled — cannot authorize anything.
        changed = true;
        continue;
      }
      if (sameCall(content.functionCall, matched.request.functionCall)) {
        kept.push(content);
        continue;
      }
      changed = true;
      kept.push({ ...content, functionCall: matched.request.functionCall });
    }
    if (!changed) {
      out.push(msg);
    } else if (kept.length > 0) {
      out.push({ ...msg, contents: kept });
    }
  }

  // A caller may answer only part of a batch. Keep the remaining requests durable and inject
  // them into this turn so the invocation loop can surface them again instead of silently
  // consuming them when `takePending` cleared the store.
  const pending = stillPending();
  store.addPending(pending);
  if (pending.length > 0) {
    out.push({ role: 'assistant', contents: pending, messageId: crypto.randomUUID() });
  }
  return out;
}

/**
 * Replays the calls that were held back because their tool needs no approval.
 *
 * Mirrors .NET `InjectPendingAutoApprovals`. They are injected unconditionally: the model was
 * shown a batch of tool calls and needs a result for every one of them, so a stored call is
 * replayed even if the tool set has since changed.
 */
function injectAutoApprovals(messages: Message[], store: ApprovalStateStore): Message[] {
  const stored = store.takeAutoApproved();
  if (stored.length === 0) {
    return messages;
  }
  const contents = stored.map((request) => approvalResponse(request, true));
  return [...messages, { role: 'user', contents }];
}

/** Tool names that are known *and* declared as not needing approval. Unknown names are not listed. */
function autoApprovableNames(
  tools: readonly Tool[] | undefined,
  additionalTools: readonly AnyFunctionTool[],
): Set<string> {
  const names = new Set<string>();
  for (const candidate of [...(tools ?? []), ...additionalTools]) {
    if (
      isFunctionTool(candidate) &&
      candidate.execute !== undefined &&
      candidate.approvalMode !== 'always_require'
    ) {
      names.add(candidate.name);
    }
  }
  return names;
}

/** Options for {@link withToolApproval}. */
export interface ToolApprovalConfig {
  /** Tools the loop can execute without advertising them; they are auto-approvable too. */
  additionalTools?: AnyFunctionTool[];
}

/**
 * Adds human-in-the-loop guarantees around a client whose loop can surface approval requests.
 *
 * Two behaviours, composed in the order .NET uses (`ApprovalResponseBindingChatClient` outermost,
 * then `ApprovalNotRequiredFunctionBypassingChatClient`, then the function-calling loop):
 *
 * 1. **Binding.** Every decision the caller sends is matched against a request this session
 *    actually issued, and the approved call is rebound to the recorded tool name and arguments.
 * 2. **Bypass.** The loop surfaces the whole round for approval once any call in it needs a human.
 *    Calls whose tool does not require approval are removed from what the caller sees and held in
 *    the store, then replayed as pre-approved on the next turn — the model needs a result for every
 *    call it made, so they cannot simply be dropped.
 *
 * ## Security considerations
 *
 * This is what makes `approvalMode: 'always_require'` a control rather than a display convention.
 * It depends on the store outliving the turn: with a store that forgets — or a session that is
 * not the one the request came from — every decision is unbindable and therefore discarded, which
 * fails closed. The binding is against forged or edited decisions, not against a compromised
 * store: anything that can write session state can write a pending request.
 */
export function withToolApproval<TOptions extends ChatOptions>(
  client: ChatClient<TOptions>,
  store: ApprovalStateStore,
  options: ToolApprovalConfig = {},
): ChatClient<TOptions> {
  const additionalTools = options.additionalTools ?? [];

  return {
    metadata: client.metadata,
    getResponse(
      messages: Message[],
      requestOptions?: TOptions & { signal?: AbortSignal },
    ): ChatResponseStream<unknown> {
      const autoApprovable = autoApprovableNames(requestOptions?.tools, additionalTools);

      async function* run(stream: boolean): AsyncGenerator<ChatResponseUpdate> {
        const prepared = injectAutoApprovals(bindInboundDecisions(messages, store), store);
        const inner = client.getResponse(prepared, requestOptions);
        const suppressed: FunctionApprovalRequestContent[] = [];
        const surfaced: FunctionApprovalRequestContent[] = [];

        const handle = function* (update: ChatResponseUpdate): Generator<ChatResponseUpdate> {
          if (!update.contents.some((c) => isApprovalRequest(c) && !isHostedApproval(c))) {
            yield update;
            return;
          }
          const kept: Content[] = [];
          for (const content of update.contents) {
            if (!isApprovalRequest(content) || isHostedApproval(content)) {
              // A hosted request is surfaced to the caller as-is and never recorded: there is
              // nothing here to bind the decision against, and nothing here to execute.
              kept.push(content);
            } else if (autoApprovable.has(content.functionCall.name) && !isMiddlewareApproval(content)) {
              // A middleware asked for this specific call, not for every call of this tool, so the
              // tool's `never_require` declaration does not answer it.
              suppressed.push(snapshot(content));
            } else {
              // The caller gets its own deep snapshot, so nothing the caller mutates can reach the
              // original request — which is what the store records when the run winds down. One
              // clone keeps the binding record independent from the object yielded to the caller.
              surfaced.push(content);
              kept.push(snapshot(content));
            }
          }
          // An update that carried nothing but suppressed approvals has nothing left to report.
          if (kept.length > 0) {
            yield chatResponseUpdate({ ...update, contents: kept });
          }
        };

        try {
          for await (const update of updatesOf(inner, stream)) {
            yield* handle(update);
          }
        } finally {
          // `finally` so an abandoned stream still records what it surfaced; otherwise the caller
          // could answer a request the next turn cannot bind.
          store.setAutoApproved(suppressed);
          store.addPending(surfaced);
        }
      }

      return createResponseStream({
        start: (ctx: { stream: boolean }): AsyncGenerator<ChatResponseUpdate> => run(ctx.stream),
        finalize: (updates: ChatResponseUpdate[]) => mergeChatUpdates<unknown>(updates),
        ...(requestOptions?.signal === undefined ? {} : { signal: requestOptions.signal }),
      });
    },
  };
}
