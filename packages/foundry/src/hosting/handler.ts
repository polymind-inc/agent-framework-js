import type {
  CreateResponseRequest,
  HandlerContext,
  OutputItem,
  ResponseEvent,
  ResponseHandler,
} from '@polymind-inc/agent-framework-agentserver';
import {
  conversationIdOf,
  isHosted as detectHosted,
  ProtocolError,
} from '@polymind-inc/agent-framework-agentserver';
import type {
  AgentLike,
  AgentSession,
  Content,
  SerializedAgentSession,
  UsageDetails,
} from '@polymind-inc/agent-framework-core';
import { addUsage, approvalResponse, AgentSession as Session } from '@polymind-inc/agent-framework-core';
import type { ApprovalStorage } from './approval-storage.js';
import { FileApprovalStorage, InMemoryApprovalStorage } from './approval-storage.js';
import { compositeKey } from './composite-key.js';
import type { ToolboxConsentRequest } from './consent.js';
import { consentRequestsOf } from './consent.js';
import { createConsentChannel, withConsentChannel } from './consent-channel.js';
import {
  approvalResponseTarget,
  inputToMessages,
  requestToChatOptions,
  usageToResponseUsage,
} from './converters.js';
import { hostedAgentContextOf, withHostedAgentContext } from './hosted-context.js';
import { OutputBuilder } from './output.js';
import type { AgentSessionStore } from './session-store.js';
import {
  FileSystemAgentSessionStore,
  InMemoryAgentSessionStore,
  sessionReadKey,
  sessionWriteKey,
  userPartition,
} from './session-store.js';
import { requireHostedUserId } from './user-id.js';

/**
 * Picks the session store the environment calls for.
 *
 * Hosted, sessions must live on the sandbox filesystem: the platform may deactivate the process
 * between requests, and an in-memory session would silently lose the approval bindings and
 * provider state a conversation depends on. Python's
 * `ResponsesHostServer` makes the same choice (`_responses.py`: `FoundrySessionStore` when
 * `is_hosted`, in-memory otherwise).
 */
export function defaultSessionStore(hosted: boolean): AgentSessionStore {
  return hosted ? new FileSystemAgentSessionStore() : new InMemoryAgentSessionStore();
}

/**
 * Picks the approval storage the environment calls for.
 *
 * Same reasoning as {@link defaultSessionStore}: an `mcp_approval_response` carries only an id, so
 * losing the stored request across a process recycle silently makes every pending approval
 * unresolvable. Python uses `FileBasedFunctionApprovalStorage` when hosted.
 */
export function defaultApprovalStorage(hosted: boolean): ApprovalStorage {
  return hosted ? new FileApprovalStorage() : new InMemoryApprovalStorage();
}

/** Construction options for {@link createFoundryHandler}. */
export interface FoundryHandlerConfig {
  /**
   * The agent, or a factory that builds it on first use.
   *
   * A factory is preferred in a hosted container: startup work (an MCP `tools/list`, a token
   * acquisition) that fails during construction would keep `/readiness` red and take every
   * invocation down with `session_not_ready`, whereas failing on the first request surfaces as a
   * normal error on that request.
   */
  agent: AgentLike | (() => AgentLike | Promise<AgentLike>);
  /** Defaults to {@link defaultSessionStore}: the sandbox filesystem when hosted, memory locally. */
  sessionStore?: AgentSessionStore;
  /** Defaults to {@link defaultApprovalStorage}: the sandbox filesystem when hosted, memory locally. */
  approvalStorage?: ApprovalStorage;
  /** Overrides `FOUNDRY_HOSTING_ENVIRONMENT` detection. */
  hosted?: boolean;
  /**
   * Called once per agent content item that has no wire representation and is therefore not
   * emitted (the analogue of Python's `logger.warning` in `_to_outputs`; this package carries no
   * logging dependency). Absent, unmapped content is dropped silently.
   */
  onUnsupportedContent?: (content: Content) => void;
}

/** Consent requests deduplicated by link and label, so one gateway refusal is one item. */
function dedupeConsents(consents: readonly ToolboxConsentRequest[]): ToolboxConsentRequest[] {
  const seen = new Set<string>();
  const unique: ToolboxConsentRequest[] = [];
  for (const consent of consents) {
    const key = compositeKey(consent.serverLabel, consent.consentLink);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(consent);
    }
  }
  return unique;
}

/**
 * Restores a session from its snapshot, or starts a fresh one.
 *
 * A snapshot that cannot be parsed is *not* silently replaced: losing the conversation quietly is
 * worse than failing the request, because the caller would see the agent forget everything with
 * no signal that anything went wrong.
 */
function restoreSession(agent: AgentLike, snapshot: SerializedAgentSession | undefined): AgentSession {
  return snapshot === undefined ? agent.createSession() : agent.deserializeSession(snapshot);
}

/** The parts of `Agent` a hosting layer needs in order to stand its history down. */
interface HasHistoryProvider {
  readonly historyProvider: { readonly sourceId: string };
  readonly hasExplicitHistoryProvider: boolean;
}

function withHistoryProvider(agent: AgentLike): HasHistoryProvider | undefined {
  const candidate = agent as Partial<HasHistoryProvider>;
  return typeof candidate.historyProvider?.sourceId === 'string' &&
    typeof candidate.hasExplicitHistoryProvider === 'boolean'
    ? (candidate as HasHistoryProvider)
    : undefined;
}

/**
 * Empties the agent's own transcript slot in `session`.
 *
 * The platform hands the whole conversation to every request, so anything the agent also kept
 * would be sent a second time. Clearing the slot rather than disabling the provider keeps the
 * provider working normally *within* the run — the tool loop still sees a coherent transcript —
 * and only stops it carrying state across requests.
 */
function clearLocalHistory(agent: AgentLike, session: AgentSession): void {
  const sourceId = withHistoryProvider(agent)?.historyProvider.sourceId;
  if (sourceId !== undefined) {
    delete session.state[sourceId];
  }
}

/**
 * Refuses an agent that brings its own transcript.
 *
 * Two things claiming the conversation is a configuration error. It also fails in a way that is
 * hard to see: the container would work until a restart, then quietly start replaying a stale
 * local copy alongside the platform's (Python raises the same way).
 */
function assertNoExplicitHistory(agent: AgentLike): void {
  if (withHistoryProvider(agent)?.hasExplicitHistoryProvider === true) {
    throw new ProtocolError(
      500,
      'A hosted agent must not be configured with a historyProvider: the hosting infrastructure ' +
        'owns the transcript and replays it on every request.',
      { code: 'invalid_agent_configuration', source: 'platform' },
    );
  }
}

/** Resolves inbound approval decisions against what this container actually asked. */
async function resolveApprovals(
  request: CreateResponseRequest,
  storage: ApprovalStorage,
  userId: string,
): Promise<Content[]> {
  if (!Array.isArray(request.input)) {
    return [];
  }
  const contents: Content[] = [];
  for (const item of request.input as OutputItem[]) {
    const target = approvalResponseTarget(item);
    if (target === undefined) {
      continue;
    }
    const original = await storage.load(userId, target.id);
    if (original === undefined) {
      // A decision for a request this container never issued authorizes nothing. Dropping it
      // leaves the call unexecuted, which is the safe direction.
      continue;
    }
    contents.push(approvalResponse(original, target.approved));
  }
  return contents;
}

/**
 * Adapts an {@link AgentLike} to the Responses container protocol.
 *
 * The flow: resolve the agent, load the session for
 * `conversationId ?? previousResponseId` (checking it belongs to the caller), convert the input
 * and the prefetched history into messages, run the agent streaming, translate its content into
 * output items and delta events, and save the session under `conversationId ?? responseId` — in a
 * `finally`, so an abandoned turn still leaves a resumable conversation.
 *
 * ## Security considerations
 *
 * - **A session is bound to the user it was created for.** The store raises 403 on a mismatch;
 *   the check lives there because it has to hold for every caller of the store, not just this one.
 * - **An approval decision is only honoured against a request this container issued and stored
 *   for that user.** Both halves matter: unknown ids execute nothing, and the tool name and
 *   arguments come from the stored request rather than from the decision.
 * - **A hosted agent must not carry its own message history.** The platform owns the transcript
 *   and prefetches it; an agent that also replays a local one would send every turn twice, and
 *   the local copy would be the one that leaks across container restarts.
 */
export function createFoundryHandler(options: FoundryHandlerConfig): ResponseHandler {
  const hosted = options.hosted ?? detectHosted();
  const sessionStore = options.sessionStore ?? defaultSessionStore(hosted);
  const approvalStorage = options.approvalStorage ?? defaultApprovalStorage(hosted);

  let resolved: AgentLike | undefined;
  let resolving: Promise<AgentLike> | undefined;
  const getAgent = async (): Promise<AgentLike> => {
    if (resolved !== undefined) {
      return resolved;
    }
    // Built once, on the first request rather than at startup. Concurrent first requests share
    // one construction; the in-flight promise is cleared once it settles (the same pattern as
    // `tokenProvider`), so a *transient* failure — a token fetch timing out, a toolbox briefly
    // unreachable — fails only the requests in flight instead of poisoning every later one.
    resolving ??= (async (): Promise<AgentLike> =>
      typeof options.agent === 'function' ? await options.agent() : options.agent)().finally(() => {
      resolving = undefined;
    });
    resolved = await resolving;
    return resolved;
  };

  return async function* handle(
    request: CreateResponseRequest,
    context: HandlerContext,
  ): AsyncGenerator<ResponseEvent> {
    // Agent construction is where a toolbox's `tools/list` runs, and where the Foundry MCP
    // gateway first refuses with CONSENT_REQUIRED (`-32006`). That refusal is not a failure of
    // the turn: it becomes an `oauth_consent_request` output item on a `response.incomplete`,
    // exactly as Python surfaces a consent error from lazy agent entry. The
    // factory result stays uncached on a throw, so the turn after the user consents rebuilds
    // the agent and proceeds.
    let agent: AgentLike | undefined;
    let constructionConsents: ToolboxConsentRequest[] | undefined;
    try {
      agent = await getAgent();
    } catch (error) {
      constructionConsents = consentRequestsOf(error);
      if (constructionConsents === undefined) {
        throw error;
      }
    }
    if (agent !== undefined) {
      assertNoExplicitHistory(agent);
    }

    if (hosted) {
      requireHostedUserId(context.request.userId);
    }

    const userId = userPartition(context.request.userId);
    const conversationId = conversationIdOf(request);
    const previousResponseId =
      typeof request.previous_response_id === 'string' && request.previous_response_id !== ''
        ? request.previous_response_id
        : undefined;

    const readKey = sessionReadKey(conversationId, previousResponseId);
    const snapshot = readKey === undefined ? undefined : await sessionStore.load(userId, readKey);

    if (agent === undefined) {
      // Consent required before the agent even exists, so there is no agent to build a session
      // *with*. The snapshot is still carried forward under this response id: the documented flow
      // is consent out of band then retry, and the retry addresses this turn by
      // `previous_response_id` — which without a snapshot is the 500 below, not a fresh start
      // (Python creates the session before `_ensure_agent_ready()` and saves it either way).
      const builder = new OutputBuilder(previousResponseId ?? conversationId ?? context.responseId);
      yield { type: 'response.created', response: context.response };
      yield { type: 'response.in_progress', response: { ...context.response, status: 'in_progress' } };
      for (const consent of dedupeConsents(constructionConsents ?? [])) {
        yield* builder.pushOauthConsentRequest(consent);
      }
      await sessionStore.save(
        userId,
        sessionWriteKey(conversationId, context.responseId),
        snapshot ?? new Session().toJSON(),
      );
      yield {
        type: 'response.incomplete',
        response: {
          ...context.response,
          status: 'incomplete',
          incomplete_details: { reason: 'oauth_consent_required' },
        },
      };
      return;
    }

    if (previousResponseId !== undefined && snapshot === undefined) {
      // The response store resolved the id (or the request would already be a 404), yet this
      // container holds no session snapshot for it — most likely the turn ran in a different
      // sandbox. Proceeding with a fresh session would silently drop the approval bindings and
      // provider state the conversation depends on, so the turn fails diagnosably instead
      // (Python `_responses.py`: "No Agent Framework session snapshot was found …").
      throw new ProtocolError(
        500,
        `No Agent Framework session snapshot was found for previous_response_id '${previousResponseId}'.` +
          (sessionStore instanceof FileSystemAgentSessionStore
            ? " Reuse the response's agent_session_id so the request is routed to the same " +
              'persistent Foundry sandbox.'
            : ''),
        { code: 'server_error', type: 'server_error', source: 'upstream' },
      );
    }
    const session = restoreSession(agent, snapshot);

    // The platform prefetches the whole transcript and it is replayed below as this turn's input,
    // so the agent's own history must contribute nothing. Its slot is emptied before the run and
    // again before the session is saved (Python `_responses.py` does exactly this).
    //
    // `serviceSessionId` is deliberately *not* used for this. It is the id the provider is told to
    // continue from, and the container's `caresp_…` belongs to the protocol's namespace, not the
    // model API's — sending it as `previous_response_id` is what the service rejects.
    clearLocalHistory(agent, session);

    const messages = [...inputToMessages(context.history), ...inputToMessages(request.input)];
    const approvals = await resolveApprovals(request, approvalStorage, userId);
    if (approvals.length > 0) {
      messages.push({ role: 'user', contents: approvals });
    }

    const builder = new OutputBuilder(previousResponseId ?? conversationId ?? context.responseId, {
      ...(options.onUnsupportedContent === undefined
        ? {}
        : { onUnsupportedContent: options.onUnsupportedContent }),
    });

    // Persists every approval request surfaced so far, at most once. Called on the success path
    // *before* the terminal event — so the caller never learns of a request that is not yet
    // resolvable — and again from `finally`, because a disconnect or SIGTERM abort still persists
    // the surfaced `mcp_approval_request` item in the incomplete response; a decision against it
    // must find the request, or the call silently becomes unexecutable.
    let approvalsSaved = false;
    const persistApprovals = async (): Promise<void> => {
      if (approvalsSaved) {
        return;
      }
      for (const surfaced of builder.surfacedApprovals) {
        // Stored under the wire id, but *as issued*: the framework id inside is what the approval
        // layer binds the decision against next turn.
        await approvalStorage.save(userId, surfaced.wireId, surfaced.request);
      }
      approvalsSaved = true;
    };

    yield { type: 'response.created', response: context.response };
    yield { type: 'response.in_progress', response: { ...context.response, status: 'in_progress' } };

    const consentChannel = createConsentChannel();
    const hostedContext = hostedAgentContextOf(context);

    try {
      const stream = agent.run(messages, {
        session,
        options: requestToChatOptions(request),
        signal: context.signal,
      });

      // `usage` contents become the terminal event's `usage` rather than an output item,
      // accumulated across tool-loop rounds (.NET `OutputConverter`: `ConvertUsage` into
      // `EmitCompleted(usage)`; the priority reference — Python hosting drops usage).
      let usage: UsageDetails | undefined;
      // Consent refusals surfaced by a toolbox tool *call*, reported out of band against the call
      // id. The loop reduces a thrown tool error to `function_result.exception` text, and tool
      // text is attacker-reachable, so it is never read as protocol (see `consent-channel.ts`).
      const consentRequests: ToolboxConsentRequest[] = [];

      for await (const update of withHostedAgentContext(
        hostedContext,
        withConsentChannel(consentChannel, stream),
      )) {
        for (const content of update.contents) {
          if (content.type === 'usage') {
            usage = addUsage(usage, content.usageDetails);
            continue;
          }
          if (content.type === 'function_result') {
            const consents = consentChannel.byCallId.get(content.callId);
            if (consents !== undefined) {
              // Not a tool failure: the call never ran. The error text must not reach the model
              // or the transcript as a `function_call_output` — the consent item below is the
              // wire representation.
              consentRequests.push(...consents);
              continue;
            }
            yield* builder.pushFunctionResult(content.callId, content.result);
          } else {
            yield* builder.push(content);
          }
        }
        if (consentRequests.length > 0) {
          // Stop before the loop calls the model again: the model reacting to a consent error
          // would burn a round narrating a failure the user has not had a chance to fix.
          break;
        }
      }
      yield* builder.close();

      for (const consent of dedupeConsents(consentRequests)) {
        yield* builder.pushOauthConsentRequest(consent);
      }

      await persistApprovals();

      const waitingOnConsent = consentRequests.length > 0;
      const status = waitingOnConsent || builder.surfacedApprovals.length > 0 ? 'incomplete' : 'completed';
      yield {
        // A turn waiting on a human is not finished: `incomplete` is what tells the caller to come
        // back once the consent is granted or the decision is made.
        type: status === 'completed' ? 'response.completed' : 'response.incomplete',
        response: {
          ...context.response,
          status,
          ...(usage === undefined ? {} : { usage: usageToResponseUsage(usage) }),
          ...(status === 'incomplete'
            ? {
                incomplete_details: {
                  reason: waitingOnConsent ? 'oauth_consent_required' : 'tool_approval_required',
                },
              }
            : {}),
        },
      };
    } finally {
      // An aborted turn may have surfaced an approval whose item is persisted with the incomplete
      // response; the stored request has to exist for the decision to resolve against.
      await persistApprovals();
      // Emptied again: the run just wrote this turn into it, and the platform will replay the same
      // turn next time. Keeping it would send every message twice.
      clearLocalHistory(agent, session);
      // Saved even when the caller disconnects, so the conversation can be resumed rather than
      // silently restarting.
      await sessionStore.save(userId, sessionWriteKey(conversationId, context.responseId), session.toJSON());
    }
  };
}
