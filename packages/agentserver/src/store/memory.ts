import { notFound } from '../errors.js';
import type { OutputItem, ResponseEvent } from '../wire.js';
import type { ResponseGeneration, ResponseOwner, ResponseProvider, StoredResponse } from './provider.js';
import {
  assertOwnerCanWrite,
  assertWritable,
  historyOf,
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

/** An event stream held for replay, together with who it belongs to. */
interface StoredEvents {
  owner: ResponseOwner;
  generation: ResponseGeneration;
  events: ResponseEvent[];
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
  /** Replayable background streams, keyed by response id. Bounded by the same cap as responses. */
  readonly #events = new Map<string, StoredEvents>();
  readonly #maxResponses: number;

  constructor(options: InMemoryResponseProviderConfig = {}) {
    this.#maxResponses = options.maxResponses ?? 10_000;
  }

  async get(id: string, owner: ResponseOwner): Promise<StoredResponse | undefined> {
    return ownedOrUndefined(this.#responses.get(id), owner);
  }

  async assertWritable(id: string, owner: ResponseOwner): Promise<void> {
    // The same rule `put` applies, run before the turn does any work.
    assertOwnerCanWrite(this.#responses.get(id), id, owner);
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
    }
  }

  async put(stored: StoredResponse): Promise<void> {
    const id = stored.response.id;
    assertWritable(this.#responses.get(id), stored);
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
    // The same two refusals a `put` gives: neither someone else's response record nor someone
    // else's event stream may be replaced under a reused id.
    const record = this.#responses.get(id);
    assertOwnerCanWrite(record, id, owner);
    if (!isCurrentGeneration(record, generation)) {
      // The id was deleted, or has moved on to another turn, since these events were produced.
      // Discarded rather than reported: nothing about the *current* occupant of the id is wrong.
      // The whole check-and-write is one synchronous step here, so nothing can slip between them.
      return;
    }
    const existing = this.#events.get(id);
    if (existing !== undefined && !sameOwner(existing.owner, owner)) {
      throw notFound(id);
    }
    if (!this.#events.has(id)) {
      this.#evictOldest(this.#events);
    }
    this.#events.set(id, { owner, generation, events: [...events] });
  }

  async getEvents(
    id: string,
    owner: ResponseOwner,
    generation: ResponseGeneration,
  ): Promise<ResponseEvent[] | undefined> {
    const entry = this.#events.get(id);
    return entry !== undefined && entry.generation === generation && sameOwner(entry.owner, owner)
      ? [...entry.events]
      : undefined;
  }

  async delete(id: string, owner: ResponseOwner): Promise<boolean> {
    if (ownedOrUndefined(this.#responses.get(id), owner) === undefined) {
      return false;
    }
    // The replay log is part of the response; a deleted response must not remain replayable.
    this.#events.delete(id);
    return this.#responses.delete(id);
  }

  async history(id: string, owner: ResponseOwner): Promise<OutputItem[] | undefined> {
    const stored = await this.get(id, owner);
    return stored === undefined ? undefined : historyOf(stored);
  }

  /** How many responses are held. Exposed for tests and diagnostics. */
  get size(): number {
    return this.#responses.size;
  }
}
