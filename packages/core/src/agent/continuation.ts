import { ConfigurationError } from '../errors.js';
import type { Message } from '../types/message.js';
import type { AgentResponseUpdate, ContinuationToken } from '../types/response.js';
import { agentResponseUpdate } from '../types/response.js';
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

function serializeUpdate(update: AgentResponseUpdate): SerializedUpdate {
  const [serialized] = serializeMessages([{ role: update.role ?? 'assistant', contents: update.contents }]);
  const out: SerializedUpdate = { contents: serialized?.contents ?? [] };
  if (update.role !== undefined) out.role = update.role;
  if (update.authorName !== undefined) out.authorName = update.authorName;
  if (update.responseId !== undefined) out.responseId = update.responseId;
  if (update.messageId !== undefined) out.messageId = update.messageId;
  if (update.createdAt !== undefined) out.createdAt = update.createdAt;
  if (update.finishReason !== undefined) out.finishReason = update.finishReason;
  if (update.agentId !== undefined) out.agentId = update.agentId;
  if (update.additionalProperties !== undefined) out.additionalProperties = update.additionalProperties;
  return out;
}

function deserializeUpdate(serialized: SerializedUpdate): AgentResponseUpdate {
  const [message] = deserializeMessages([
    { role: serialized.role ?? 'assistant', contents: serialized.contents },
  ]);
  return agentResponseUpdate({
    contents: message?.contents ?? [],
    ...(serialized.role === undefined ? {} : { role: serialized.role }),
    ...(serialized.authorName === undefined ? {} : { authorName: serialized.authorName }),
    ...(serialized.responseId === undefined ? {} : { responseId: serialized.responseId }),
    ...(serialized.messageId === undefined ? {} : { messageId: serialized.messageId }),
    ...(serialized.createdAt === undefined ? {} : { createdAt: serialized.createdAt }),
    ...(serialized.finishReason === undefined ? {} : { finishReason: serialized.finishReason }),
    ...(serialized.agentId === undefined ? {} : { agentId: serialized.agentId }),
    ...(serialized.additionalProperties === undefined
      ? {}
      : { additionalProperties: serialized.additionalProperties }),
  });
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
): AgentContinuationToken {
  const token: AgentContinuationToken = { type: AGENT_TOKEN_TYPE, innerToken };
  if (inputMessages.length > 0) {
    token.inputMessages = serializeMessages(inputMessages);
  }
  if (updates.length > 0) {
    token.responseUpdates = updates.map(serializeUpdate);
  }
  return token;
}

/** The state carried by a token, or empty state when there is no token. */
export interface ContinuationState {
  innerToken?: ContinuationToken;
  inputMessages: Message[];
  updates: AgentResponseUpdate[];
}

/**
 * Unwraps a continuation token.
 *
 * @throws {ConfigurationError} When the value is not a token this framework produced.
 */
export function parseContinuationToken(token: ContinuationToken | undefined): ContinuationState {
  if (token === undefined) {
    return { inputMessages: [], updates: [] };
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
  };
}
