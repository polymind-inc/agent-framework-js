import { agentName, agentSessionId, agentVersion } from './config.js';
import { partitionKeyOf, toHex } from './ids.js';
import { conversationIdOf } from './validation.js';
import type { CreateResponseRequest } from './wire.js';

/** Session ids are 63 lowercase hex characters, whether derived or random, matching the Python reference. */
const SESSION_ID_LENGTH = 63;

/** What an unnamed agent is called when deriving a session id. Matches Python's constant. */
const DEFAULT_AGENT_NAME = 'server-default-agent';

/** Overrides for {@link resolveAgentSessionId}; every one of them defaults to the environment. */
export interface AgentSessionIdOptions {
  /** Defaults to `FOUNDRY_AGENT_SESSION_ID`. */
  envSessionId?: string | undefined;
  /** Defaults to `FOUNDRY_AGENT_NAME`. */
  agentName?: string | undefined;
  /** Defaults to `FOUNDRY_AGENT_VERSION`. */
  agentVersion?: string | undefined;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  return text === '' ? undefined : text;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return toHex(bytes).slice(0, length);
}

/**
 * Resolves the `x-agent-session-id` a `POST /responses` answers with, mirroring the Python
 * reference implementation (`azure-ai-agentserver-core`).
 *
 * The value names the **sandbox** the turn should run in, which is why it must be stable for a
 * conversation and must not be the response id: a fresh id every turn sends each turn of one
 * conversation to a different filesystem, so anything a file-backed session store wrote last turn
 * is simply not there.
 *
 * The priority chain, in order:
 *
 * 1. `agent_session_id` on the request — the caller pinning session affinity;
 * 2. `FOUNDRY_AGENT_SESSION_ID` — the platform having already decided;
 * 3. a **deterministic** derivation, `SHA-256(name:version:partitionHint)`, where the hint is the
 *    partition key of the conversation id or of `previous_response_id`. Every turn of one
 *    conversation therefore resolves to the same sandbox without any shared state;
 * 4. a random id, for a one-shot request that carries no conversational context at all.
 *
 * @remarks
 * **On a deployed container only step 1 ever runs**: the platform puts `agent_session_id` on the
 * request itself, and keeps it constant across a conversation — measured, by chaining turns
 * through a real deployment and watching the value stay put while a fresh conversation got a new
 * one. Steps 3 and 4 are what a container reached outside the platform falls back to, which is
 * where local development and the tests live. Do not read a passing multi-turn test in production
 * as evidence that the derivation works.
 */
export async function resolveAgentSessionId(
  request: CreateResponseRequest,
  options: AgentSessionIdOptions = {},
): Promise<string> {
  const fromPayload = trimmed(request.agent_session_id);
  if (fromPayload !== undefined) {
    return fromPayload;
  }

  const fromEnv = trimmed(options.envSessionId ?? agentSessionId());
  if (fromEnv !== undefined) {
    return fromEnv;
  }

  const source = conversationIdOf(request) ?? trimmed(request.previous_response_id);
  if (source === undefined) {
    return randomHex(SESSION_ID_LENGTH);
  }

  const name =
    trimmed(request.agent_reference?.name) ?? trimmed(options.agentName ?? agentName()) ?? DEFAULT_AGENT_NAME;
  const version =
    trimmed(request.agent_reference?.version) ?? trimmed(options.agentVersion ?? agentVersion()) ?? '';
  // The partition key, not the whole id: two turns of one conversation share the former and differ
  // in the latter, and it is the conversation that has to land in one sandbox.
  const hint = partitionKeyOf(source) ?? source;
  return (await sha256Hex(`${name}:${version}:${hint}`)).slice(0, SESSION_ID_LENGTH);
}
