import { ConfigurationError } from '../errors.js';
import type { Message } from '../types/message.js';
import type { AgentResponseUpdate, AgentResponseUpdateInit, ContinuationToken } from '../types/response.js';
import { agentResponseUpdate, copyDefined } from '../types/response.js';
import type { SerializedMessage } from '../types/serialization.js';
import { deserializeMessages, serializeMessages } from '../types/serialization.js';

/** Marks a token as this framework's wrapper rather than a bare provider token. */
const AGENT_TOKEN_TYPE = 'agentContinuationToken';

/**
 * The agent-level continuation token.
 *
 * A provider token only identifies the background operation. Resuming a run also has to persist
 * history and notify context providers for the *whole* exchange, so the agent wraps the provider
 * token together with the run's input messages and the updates seen so far (Go `continuation.go`).
 * Without that, a resumed run would save only the tail of the response.
 */
export interface AgentContinuationToken extends ContinuationToken {
  type: typeof AGENT_TOKEN_TYPE;
  /** The provider's own token, passed back down verbatim. */
  innerToken: ContinuationToken;
  /** The messages the original `run()` was called with. */
  inputMessages?: SerializedMessage[];
  /** Every update produced before the run was suspended. */
  responseUpdates?: SerializedUpdate[];
  /**
   * What the context providers injected into the original run, minus replayed history.
   *
   * A suspended streaming run defers persistence to the run that completes the exchange, so the
   * injected context has to travel with the token for a store configured to keep it. Replayed
   * history is excluded: it is already in the store, and it can dwarf the rest of the token.
   */
  contextMessages?: SerializedMessage[];
}

/** An {@link AgentResponseUpdate} reduced to its JSON-safe fields. */
export interface SerializedUpdate {
  contents: SerializedMessage['contents'];
  role?: string;
  authorName?: string;
  responseId?: string;
  messageId?: string;
  createdAt?: string;
  finishReason?: string;
  agentId?: string;
  additionalProperties?: Record<string, unknown>;
}

/** Returns `true` when `token` was produced by {@link wrapContinuationToken}. */
export function isAgentContinuationToken(
  token: ContinuationToken | undefined,
): token is AgentContinuationToken {
  return token?.type === AGENT_TOKEN_TYPE && token.innerToken !== undefined;
}

/**
 * The update fields a token carries, keyed exhaustively so the compiler rejects both a stray entry
 * and a missing one whenever {@link AgentResponseUpdate} changes.
 *
 * Three fields are deliberately excluded rather than listed. `contents` is the payload, serialized
 * separately through the message serializer so nested unknown content round-trips.
 * `rawRepresentation` is the provider's own object, which is never serialized anywhere in the
 * framework and can be circular. `continuationToken` is the token this update is being packed
 * *into*: carrying it would nest a token inside itself and grow the payload on every resume.
 * (`text` never appears here at all — the init type already omits it, and it is recomputed from
 * the contents on the way back.)
 *
 * **Adding a field to `ResponseUpdateBase`? It has to be listed here, or added to the key list's
 * `Exclude` with the reason why.** Otherwise a resumed run replays its updates with the new field
 * silently dropped — a data loss no test of the field itself would catch.
 */
const CARRIED_UPDATE_KEYS = {
  role: true,
  authorName: true,
  responseId: true,
  messageId: true,
  createdAt: true,
  finishReason: true,
  agentId: true,
  additionalProperties: true,
} as const satisfies Record<
  Exclude<keyof AgentResponseUpdateInit, 'contents' | 'continuationToken' | 'rawRepresentation'>,
  true
>;

/**
 * The same keys as a list, in declaration order.
 *
 * One list drives both directions, so the two halves of the round trip cannot disagree about
 * which fields survive it.
 */
const CARRIED_UPDATE_KEY_LIST = Object.keys(CARRIED_UPDATE_KEYS) as ReadonlyArray<
  keyof typeof CARRIED_UPDATE_KEYS
>;

function serializeUpdate(update: AgentResponseUpdate): SerializedUpdate {
  const [serialized] = serializeMessages([{ role: update.role ?? 'assistant', contents: update.contents }]);
  const out: SerializedUpdate = { contents: serialized?.contents ?? [] };
  return copyDefined(out, update, CARRIED_UPDATE_KEY_LIST);
}

function deserializeUpdate(serialized: SerializedUpdate): AgentResponseUpdate {
  const [message] = deserializeMessages([
    { role: serialized.role ?? 'assistant', contents: serialized.contents },
  ]);
  const init: AgentResponseUpdateInit = { contents: message?.contents ?? [] };
  return agentResponseUpdate(copyDefined(init, serialized, CARRIED_UPDATE_KEY_LIST));
}

/**
 * Wraps a provider token with the state a resumed run needs to finish the exchange.
 *
 * `updates` is only carried for streaming runs: an awaited run folds its own updates, so
 * duplicating them in the token would double the transcript on resume (Go `agent.go`).
 */
export function wrapContinuationToken(
  innerToken: ContinuationToken,
  inputMessages: readonly Message[],
  updates: readonly AgentResponseUpdate[],
  contextMessages: readonly Message[] = [],
): AgentContinuationToken {
  const token: AgentContinuationToken = { type: AGENT_TOKEN_TYPE, innerToken };
  if (inputMessages.length > 0) {
    token.inputMessages = serializeMessages(inputMessages);
  }
  if (updates.length > 0) {
    token.responseUpdates = updates.map(serializeUpdate);
  }
  if (contextMessages.length > 0) {
    token.contextMessages = serializeMessages(contextMessages);
  }
  return token;
}

/** The state carried by a token, or empty state when there is no token. */
export interface ContinuationState {
  innerToken?: ContinuationToken;
  inputMessages: Message[];
  updates: AgentResponseUpdate[];
  contextMessages: Message[];
}

/**
 * Unwraps a continuation token.
 *
 * @throws {ConfigurationError} When the value is not a token this framework produced.
 */
export function parseContinuationToken(token: ContinuationToken | undefined): ContinuationState {
  if (token === undefined) {
    return { inputMessages: [], updates: [], contextMessages: [] };
  }
  if (!isAgentContinuationToken(token)) {
    throw new ConfigurationError(
      'The value passed as continuationToken was not produced by this framework. Pass back the ' +
        '`continuationToken` from a previous AgentResponse unchanged.',
    );
  }
  return {
    innerToken: token.innerToken,
    inputMessages: deserializeMessages(token.inputMessages ?? []),
    updates: (token.responseUpdates ?? []).map(deserializeUpdate),
    contextMessages: deserializeMessages(token.contextMessages ?? []),
  };
}
