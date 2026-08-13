import { homedir } from 'node:os';
import {
  readJsonFile,
  resolveUnder,
  writeJsonFile,
} from '@polymind-inc/agent-framework-agentserver/internal';
import type { SerializedAgentSession } from '@polymind-inc/agent-framework-core';

/** A session snapshot plus the user it belongs to. */
export interface StoredSession {
  userId: string;
  session: SerializedAgentSession;
}

/** Where an agent session lives between hosted requests. */
export interface AgentSessionStore {
  load(userId: string, key: string): Promise<SerializedAgentSession | undefined>;
  save(userId: string, key: string, session: SerializedAgentSession): Promise<void>;
}

/** The default user partition when the platform sent no user id (local development only). */
const ANONYMOUS_USER = '_anonymous';

/** Copies a session through the same JSON boundary as the filesystem store. */
function cloneSession(session: SerializedAgentSession): SerializedAgentSession {
  return JSON.parse(JSON.stringify(session)) as SerializedAgentSession;
}

/** Resolves the user partition for a request. */
export function userPartition(userId: string | undefined): string {
  return userId === undefined || userId === '' ? ANONYMOUS_USER : userId;
}

/**
 * Keys a session by conversation when there is one, and by response id otherwise.
 *
 * Reads use `conversationId ?? previousResponseId`, writes use `conversationId ?? responseId`.
 * In the response-chaining mode that asymmetry is the feature: a turn reads the previous
 * snapshot and writes a new one under its own id, so one response can be branched into several.
 */
export function sessionReadKey(
  conversationId: string | undefined,
  previousResponseId: string | undefined,
): string | undefined {
  return conversationId ?? previousResponseId;
}

/** The key a turn's resulting snapshot is written under. */
export function sessionWriteKey(conversationId: string | undefined, responseId: string): string {
  return conversationId ?? responseId;
}

/**
 * Stores session snapshots on the container's sandbox filesystem.
 *
 * ## Security considerations
 *
 * - **Cross-user isolation is enforced on read.** The path partitions by user, and a snapshot also
 *   records the user it was written for; loading it under a different `x-agent-user-id` reads as
 *   *absent* rather than forbidden, so a caller learns nothing about whether that conversation id
 *   exists. This matters because a conversation id is guessable in a way an identity is not.
 * - **Both key parts are untrusted.** The user id comes from a header, the conversation id from a
 *   request body; both become path segments and are therefore rejected — never sanitized — and
 *   the resolved path is re-checked against the root (see `resolveUnder`).
 * - Snapshots are written in the clear. A session carries whatever the conversation put in it.
 */
export class FileSystemAgentSessionStore implements AgentSessionStore {
  readonly #root: string;

  constructor(options: { root?: string } = {}) {
    this.#root = options.root ?? `${homedir()}/.sessions`;
  }

  #pathFor(userId: string, key: string): string {
    return resolveUnder(this.#root, [userId, `${key}.json`], 'session key');
  }

  async load(userId: string, key: string): Promise<SerializedAgentSession | undefined> {
    const stored = await readJsonFile<StoredSession>(this.#pathFor(userId, key));
    if (stored === undefined) {
      return undefined;
    }
    if (stored.userId !== userId) {
      // Defence in depth: the path already partitions by user, so this is only reachable if the
      // root is shared some other way. Reported as absent rather than forbidden, for the reason in
      // {@link InMemoryAgentSessionStore.load}.
      return undefined;
    }
    return stored.session;
  }

  async save(userId: string, key: string, session: SerializedAgentSession): Promise<void> {
    const stored: StoredSession = { userId, session };
    // Write-then-rename, so a container killed mid-write leaves the previous snapshot intact
    // rather than a truncated one.
    await writeJsonFile(this.#pathFor(userId, key), stored);
  }
}

/** Keeps sessions in memory. For tests and single-process local runs. */
export class InMemoryAgentSessionStore implements AgentSessionStore {
  readonly #sessions = new Map<string, StoredSession>();

  /**
   * A map key that cannot collide across `(userId, key)` pairs.
   *
   * Both halves are untrusted strings (a header, a request body), so joining them with *any*
   * delimiter character lets a crafted conversation id impersonate another pair — the previous
   * NUL-joined scheme let `key = "alice\u0000conv1"` overwrite the entry for `("alice", "conv1")`.
   * `JSON.stringify` escapes every character, so the pair is recoverable and the composition is
   * structurally injective.
   */
  static #compositeKey(userId: string, key: string): string {
    return JSON.stringify([userId, key]);
  }

  async load(userId: string, key: string): Promise<SerializedAgentSession | undefined> {
    const stored = this.#sessions.get(InMemoryAgentSessionStore.#compositeKey(userId, key));
    // A key another user owns is reported as absent, not as forbidden: a distinguishable refusal
    // tells the caller that *someone* holds that conversation id, and a conversation id is
    // guessable in a way an identity is not. The caller gets a
    // fresh session, which is what the filesystem store does naturally.
    return stored === undefined ? undefined : cloneSession(stored.session);
  }

  async save(userId: string, key: string, session: SerializedAgentSession): Promise<void> {
    // Keyed by the pair, so one user's write can never reach another user's entry — the same
    // isolation the filesystem store gets from its `[userId, key]` path.
    this.#sessions.set(InMemoryAgentSessionStore.#compositeKey(userId, key), {
      userId,
      session: cloneSession(session),
    });
  }
}
