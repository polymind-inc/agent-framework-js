import { ConfigurationError } from '../errors.js';
import { randomId } from '../random-id.js';

/** Names a rejected value in an error message without ever printing its contents. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'string' ? JSON.stringify(value) : typeof value;
}

/** Whether a value is a JSON-object-shaped record rather than a class or built-in instance. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
  } catch {
    // A hostile Proxy can throw while its prototype is inspected. It is not safe session state.
    return false;
  }
}

/** The wire form of an {@link AgentSession}. */
export interface SerializedAgentSession {
  type: 'session';
  sessionId: string;
  serviceSessionId?: string;
  state: Record<string, unknown>;
}

/**
 * The conversation state for a sequence of agent runs.
 *
 * A session is a lightweight state container, not a message store (Python 1.13 / .NET ADR 0018).
 * Messages live in a {@link HistoryProvider}, which uses {@link AgentSession.state} — or an
 * external store — to hold them. Providers never keep per-session state on themselves, so the
 * same agent instance can serve many sessions concurrently.
 *
 * Sessions round-trip through JSON:
 *
 * ```ts
 * const saved = JSON.stringify(session);
 * const restored = AgentSession.fromJSON(JSON.parse(saved));
 * ```
 *
 * ## Security considerations
 *
 * - **A restored session is untrusted input.** Its state reaches the model as conversation
 *   history and can carry prompt-injection payloads from earlier turns. Restore sessions only
 *   from storage you control, and authorize the caller against the session before restoring it.
 * - **State is persisted in the clear.** Do not put credentials, tokens or personal data in
 *   `state` without encrypting it yourself.
 * - **`serviceSessionId` is application state, not an authorization boundary.** It is scoped by
 *   the API key or project behind the provider, so it identifies a conversation but proves
 *   nothing about who is asking for it.
 * - **A malformed session is refused, never repaired.** {@link AgentSession.fromJSON} validates
 *   the whole envelope and throws; it does not fall back to an empty state. Quietly accepting a
 *   session that is not one is how a caller ends up running against a transcript, or an approval
 *   ledger, that is not the one it saved.
 * - **State keys are data, never lookups.** Restored state can carry any key, `__proto__`
 *   included (unknown fields are kept for round-tripping). {@link partition} therefore
 *   reads and writes own properties only, so no key can resolve to — or write into — an object on
 *   the prototype chain.
 */
export class AgentSession {
  /** Stable identifier for this conversation. */
  readonly sessionId: string;
  /** Provider-issued conversation id when the service stores the transcript. */
  serviceSessionId?: string;
  /** JSON-safe state, partitioned per provider by `sourceId`. */
  readonly state: Record<string, unknown>;

  constructor(options?: { sessionId?: string; serviceSessionId?: string; state?: Record<string, unknown> }) {
    this.sessionId = options?.sessionId ?? randomId('session');
    if (options?.serviceSessionId !== undefined) {
      this.serviceSessionId = options.serviceSessionId;
    }
    this.state = options?.state ?? {};
  }

  /**
   * Returns the state partition owned by `sourceId`, creating it on first use.
   *
   * Own properties only, on both the read and the write. A plain `this.state[sourceId]` resolves
   * `'__proto__'` to `Object.prototype` on any ordinary object — handing that back as a partition
   * would let a provider write into the global prototype — and assigning to it would reparent the
   * state object instead of storing a key.
   */
  partition(sourceId: string): Record<string, unknown> {
    const existing = Object.hasOwn(this.state, sourceId) ? this.state[sourceId] : undefined;
    if (isPlainRecord(existing)) {
      return existing;
    }
    const created: Record<string, unknown> = {};
    Object.defineProperty(this.state, sourceId, {
      value: created,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return created;
  }

  /** Called automatically by `JSON.stringify`. */
  toJSON(): SerializedAgentSession {
    const serialized: SerializedAgentSession = {
      type: 'session',
      sessionId: this.sessionId,
      state: this.state,
    };
    if (this.serviceSessionId !== undefined) {
      serialized.serviceSessionId = this.serviceSessionId;
    }
    return serialized;
  }

  /**
   * Restores a session previously produced by {@link AgentSession.toJSON}.
   *
   * Every field of the envelope is checked, and anything that does not match is refused rather
   * than dropped:
   *
   * - `type` must be the own property `'session'`, so a document that merely *looks* like a
   *   session — a checkpoint, a provider payload, an attacker-chosen object — cannot pass as one;
   * - `sessionId` must be a string;
   * - `state` must be a plain record: `null`, arrays, built-ins (`Date`, `Map`, `Set`) and class
   *   instances are rejected. Arrays drop named properties, while the other shapes stringify as a
   *   different value or `{}` — so adopting one would silently lose or corrupt the transcript and
   *   approval ledger on the next save;
   * - `serviceSessionId` must be absent, `undefined`, or a string. Dropping a malformed one would
   *   turn a service-managed session into a framework-managed one, and the next run would either
   *   replay a transcript the service also holds or start a second conversation.
   *
   * Unknown extra fields are ignored for forward compatibility; only the fields this class owns
   * are constrained.
   *
   * @throws {ConfigurationError} When `data` is not a serialized session.
   */
  static fromJSON(data: unknown): AgentSession {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new ConfigurationError('Cannot restore an AgentSession: expected a serialized session object.');
    }
    const record = data as Partial<SerializedAgentSession>;
    // Own property: an inherited `type` says something about the prototype, not about this value.
    if (!Object.hasOwn(data, 'type') || record.type !== 'session') {
      throw new ConfigurationError(
        `Cannot restore an AgentSession: expected 'type' to be 'session', got ${describe(record.type)}.`,
      );
    }
    if (typeof record.sessionId !== 'string') {
      throw new ConfigurationError(
        `Cannot restore an AgentSession: 'sessionId' must be a string, got ${describe(record.sessionId)}.`,
      );
    }
    if (!isPlainRecord(record.state)) {
      throw new ConfigurationError(
        `Cannot restore an AgentSession: 'state' must be an object, got ${describe(record.state)}.`,
      );
    }
    if (record.serviceSessionId !== undefined && typeof record.serviceSessionId !== 'string') {
      throw new ConfigurationError(
        `Cannot restore an AgentSession: 'serviceSessionId' must be a string when present, got ${describe(
          record.serviceSessionId,
        )}.`,
      );
    }
    const options: { sessionId: string; serviceSessionId?: string; state: Record<string, unknown> } = {
      sessionId: record.sessionId,
      state: record.state,
    };
    if (record.serviceSessionId !== undefined) {
      options.serviceSessionId = record.serviceSessionId;
    }
    return new AgentSession(options);
  }
}
