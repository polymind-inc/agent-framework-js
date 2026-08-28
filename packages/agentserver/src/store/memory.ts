import { notFound } from '../errors.js';
import { positiveLimit } from '../validation.js';
import type { OutputItem, ResponseEvent } from '../wire.js';
import type {
  ResponseGeneration,
  ResponseOwner,
  ResponseProvider,
  StoredEventLog,
  StoredResponse,
} from './provider.js';
import {
  assertOwnerCanWrite,
  assertWritable,
  fencedEvents,
  historyVia,
  isCurrentGeneration,
  ownedOrUndefined,
  sameOwner,
} from './provider.js';

/** Construction options for {@link InMemoryResponseProvider}. */
export interface InMemoryResponseProviderConfig {
  /**
   * The most responses held before the oldest are evicted. Defaults to 10 000.
   *
   * A safety valve, not a cache policy: `store` defaults to on, so without a bound every request
   * ever served stays in process memory for the life of the container. Eviction is
   * oldest-inserted-first — .NET bounds the same store by TTL; a count is the minimal equivalent
   * that needs no timers. An evicted response reads as absent, exactly like an expired one.
   */
  maxResponses?: number;
}

/**
 * Keeps responses in process memory.
 *
 * The default for local development. Everything is lost when the process exits, so a hosted
 * container must not use it — a restart between turns would drop the conversation.
 *
 * Cross-user isolation still applies: one process serves every caller, so the owner check is the
 * only thing keeping their conversations apart.
 */
export class InMemoryResponseProvider implements ResponseProvider {
  readonly #responses = new Map<string, StoredResponse>();
  /** Conversation ids are indexes over responses, not responses in the retention budget. */
  readonly #aliases = new Map<string, StoredResponse>();
  /**
   * Which alias ids point at each response — the reverse of `#aliases`' `aliasOf` edges, kept in
   * step by every write to that map. It is what makes dropping one response's aliases cost only
   * those aliases: a scan of `#aliases` instead would run on every delete and, once the store
   * sits at its cap, on every insert.
   */
  readonly #aliasIdsFor = new Map<string, Set<string>>();
  /** Replayable background streams, keyed by response id. Bounded by the same cap as responses. */
  readonly #events = new Map<string, StoredEventLog>();
  readonly #maxResponses: number;

  constructor(options: InMemoryResponseProviderConfig = {}) {
    this.#maxResponses = positiveLimit('maxResponses', options.maxResponses ?? 10_000);
  }

  #lookup(id: string): StoredResponse | undefined {
    return this.#responses.get(id) ?? this.#aliases.get(id);
  }

  /** Stores `stored` as an alias of `target`, moving the reverse edge when the id is re-pointed. */
  #setAlias(id: string, stored: StoredResponse, target: string): void {
    const previous = this.#aliases.get(id)?.aliasOf;
    if (previous !== undefined && previous !== target) {
      // The id no longer speaks for its old target; left indexed, dropping that target's aliases
      // would take this one along even though it points somewhere else now.
      this.#unindexAlias(id, previous);
    }
    this.#aliases.set(id, stored);
    let ids = this.#aliasIdsFor.get(target);
    if (ids === undefined) {
      ids = new Set();
      this.#aliasIdsFor.set(target, ids);
    }
    ids.add(id);
  }

  /** Removes one reverse edge, and the target's whole entry once no alias points at it. */
  #unindexAlias(id: string, target: string): void {
    const ids = this.#aliasIdsFor.get(target);
    if (ids === undefined) {
      return;
    }
    ids.delete(id);
    if (ids.size === 0) {
      this.#aliasIdsFor.delete(target);
    }
  }

  #dropAliasesFor(responseId: string): void {
    const ids = this.#aliasIdsFor.get(responseId);
    if (ids === undefined) {
      return;
    }
    this.#aliasIdsFor.delete(responseId);
    for (const id of ids) {
      this.#aliases.delete(id);
    }
  }

  async get(id: string, owner: ResponseOwner): Promise<StoredResponse | undefined> {
    return ownedOrUndefined(this.#lookup(id), owner);
  }

  async assertWritable(id: string, owner: ResponseOwner): Promise<void> {
    // The same rule `put` applies, run before the turn does any work.
    assertOwnerCanWrite(this.#lookup(id), id, owner);
  }

  /**
   * Evicts oldest-first until `map` is under the shared cap, cascading each eviction into
   * `alsoDrop` — the response is what makes its event stream reachable, so keeping orphaned
   * events would let the eviction bound be dodged through the second map.
   */
  #evictOldest(map: Map<string, unknown>, alsoDrop?: Map<string, unknown>): void {
    while (map.size >= this.#maxResponses) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      map.delete(oldest);
      alsoDrop?.delete(oldest);
      if (map === this.#responses) this.#dropAliasesFor(oldest);
    }
  }

  async put(stored: StoredResponse): Promise<void> {
    const id = stored.response.id;
    assertWritable(this.#lookup(id), stored);
    if (stored.aliasOf !== undefined) {
      this.#setAlias(id, stored, stored.aliasOf);
      return;
    }
    const existing = this.#responses.get(id);
    if (existing !== undefined && existing.generation !== stored.generation) {
      this.#dropAliasesFor(id);
    }
    // Overwriting an existing id does not grow the map, so only a genuinely new entry evicts.
    if (!this.#responses.has(id)) {
      this.#evictOldest(this.#responses, this.#events);
    }
    this.#responses.set(id, stored);
  }

  async putEvents(
    id: string,
    owner: ResponseOwner,
    events: readonly ResponseEvent[],
    generation: ResponseGeneration,
  ): Promise<void> {
    // The same two refusals a `put` gives — `FileResponseProvider.putEvents` spells out the
    // rationale. Here the whole check-and-write is one synchronous step, so nothing can slip
    // between them.
    const record = this.#responses.get(id);
    assertOwnerCanWrite(record, id, owner);
    if (!isCurrentGeneration(record, generation)) {
      // The id was deleted, or has moved on to another turn, since these events were produced.
      // Discarded rather than reported: nothing about the *current* occupant of the id is wrong.
      return;
    }
    const existing = this.#events.get(id);
    if (existing !== undefined && !sameOwner(existing.userId, owner)) {
      throw notFound(id);
    }
    if (!this.#events.has(id)) {
      this.#evictOldest(this.#events);
    }
    this.#events.set(id, { userId: owner, generation, events: [...events] });
  }

  async getEvents(
    id: string,
    owner: ResponseOwner,
    generation: ResponseGeneration,
  ): Promise<ResponseEvent[] | undefined> {
    const events = fencedEvents(this.#events.get(id), owner, generation);
    // Copied, so a caller cannot mutate the retained log.
    return events === undefined ? undefined : [...events];
  }

  async delete(id: string, owner: ResponseOwner): Promise<boolean> {
    const stored = ownedOrUndefined(this.#lookup(id), owner);
    if (stored === undefined) {
      return false;
    }
    const alias = this.#aliases.get(id);
    if (alias !== undefined) {
      if (alias.aliasOf !== undefined) {
        // Only `#setAlias` writes this map, so the edge is always there; the guard is for the type.
        this.#unindexAlias(id, alias.aliasOf);
      }
      return this.#aliases.delete(id);
    }
    // The replay log is part of the response; a deleted response must not remain replayable.
    this.#events.delete(id);
    this.#dropAliasesFor(id);
    return this.#responses.delete(id);
  }

  async history(id: string, owner: ResponseOwner): Promise<OutputItem[] | undefined> {
    return historyVia(this, id, owner);
  }

  /** How many responses are held. Exposed for tests and diagnostics. */
  get size(): number {
    return this.#responses.size;
  }
}
