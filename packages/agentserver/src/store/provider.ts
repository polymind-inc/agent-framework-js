import { notFound } from '../errors.js';
import type { OutputItem, ResponseEvent, ResponseObject } from '../wire.js';

/** A globally unique identity for one turn that owns a reusable response id. */
export type ResponseGeneration = string;

/** A stored response plus what the protocol needs that is not on the resource itself. */
export interface StoredResponse {
  response: ResponseObject;
  /** The request's input items, for `GET /responses/{id}/input_items`. */
  inputItems?: OutputItem[];
  /** The user this response belongs to, for cross-user isolation. */
  userId?: string;
  /**
   * Which *turn* of this id the record belongs to — the fence for {@link ResponseProvider.putEvents}.
   *
   * A response id is reusable: `DELETE` frees it, and the next create may take it straight away.
   * The server stamps every turn with a globally unique value, so "the record under this id is
   * still the one my turn wrote" is a comparison rather than a guess even when several server
   * instances share the provider. A provider that implements the {@link ResponseProvider.putEvents} /
   * {@link ResponseProvider.getEvents} pair **must round-trip it through `put` and `get`**; one
   * that implements neither may ignore it.
   *
   * It is server-internal and never reaches the wire: it sits beside the response resource, not on
   * it, exactly like {@link userId}.
   */
  generation?: ResponseGeneration;
}

/**
 * Who a stored response belongs to.
 *
 * `undefined` is a partition in its own right — the unauthenticated local-development one — not a
 * wildcard. An implementation must never treat it as "any user".
 */
export type ResponseOwner = string | undefined;

/**
 * Where responses live between requests.
 *
 * Hosted, this is Foundry storage; locally it is a file or memory. Every route that resolves
 * `previous_response_id`, replays a background response or lists input items goes through here.
 *
 * ## Security considerations
 *
 * **Every method is partitioned by owner, and the owner is not optional.** A conversation id is
 * chosen by the caller and a response id travels through client code, so neither is a secret;
 * identity is the only thing that separates one caller's transcript from another's. The parameter
 * is on the abstraction rather than on the routes because it has to hold for every implementation
 * — including the ones a host swaps in. Python's `ResponseProviderProtocol`
 * takes the same stance with its required `PlatformContext`.
 *
 * A response the owner does not own reads as **absent**: `get` and `history` return `undefined`,
 * `delete` returns `false`, and the routes turn that into a 404. Answering 403 would confirm the
 * id exists, which is itself the other user's business.
 */
export interface ResponseProvider {
  get(id: string, owner: ResponseOwner): Promise<StoredResponse | undefined>;
  /**
   * Stores a response under `stored.response.id`, owned by `stored.userId`.
   *
   * @throws {ProtocolError} 404 when a response with that id is already owned by someone else —
   * an id reused across users must not silently replace the original.
   */
  put(stored: StoredResponse): Promise<void>;
  /**
   * Fails now if `put` would later refuse this id for this owner.
   *
   * Optional, and called before the turn runs so a reused id costs nothing.
   * A provider that partitions service-side has no local record to check and simply omits
   * it; one that stores locally implements it with the same rule `put` uses, so the two answers
   * cannot disagree.
   *
   * @throws {ProtocolError} 404 when the id is already owned by someone else.
   */
  assertWritable?(id: string, owner: ResponseOwner): Promise<void>;
  delete(id: string, owner: ResponseOwner): Promise<boolean>;
  /**
   * The transcript to prepend to a new turn: the stored response's input plus its output.
   *
   * Returns `undefined` when `id` is unknown *to `owner`*, which the route turns into a 404
   * *before* the handler runs — a handler must never see a conversation that does not exist, and
   * must never see one belonging to another user.
   */
  history(id: string, owner: ResponseOwner): Promise<OutputItem[] | undefined>;
  /**
   * Persists the replayable event stream of a background streaming response.
   *
   * Optional, together with {@link getEvents}: the pair is what makes the `background` execution
   * modes and `GET /responses/{id}?stream=true` replay possible, and the server feature-detects
   * them — a provider that implements neither (a service-side store such as Foundry's) keeps the
   * documented fail-closed 501 for those routes.
   *
   * Called once per response, with the complete stamped event list. Events already carry their
   * `sequence_number`s; an implementation stores them as given and never renumbers.
   *
   * ## The write is conditional, and the condition is not advisory
   *
   * Unlike {@link put}, this is the one write the server still owes *after* the turn has become
   * deletable — the terminal state is persisted and delivered first, and `DELETE` is refused only
   * while a run is still working. So by the time this call arrives, the id may have been deleted,
   * and may already belong to a different turn whose own replay log is in place.
   *
   * The write must therefore be applied **atomically, and only if the response record under `id` is
   * still generation `generation`** — see {@link StoredResponse.generation} and
   * {@link isCurrentGeneration}. A stale write is **discarded silently**: it describes a turn that
   * no longer holds the id, and there is nothing to report to (the run that made it is winding
   * down, with no caller left). It must not be turned into an empty log, a tombstone or any other
   * observable edit, because the id's *current* turn may have a perfectly good log of its own.
   *
   * Check-then-write over two awaits does not satisfy this. Implement it with whatever the backing
   * store offers for a conditional write — a compare-and-set, an ETag precondition, a
   * `WHERE generation = ?` — or, for a local store, under the same per-id lock `put` and `delete`
   * take (see `FileResponseProvider`).
   *
   * @throws {ProtocolError} 404 when an event stream under this id is already owned by someone
   * else — the same refusal `put` gives a reused response id. Ownership outranks the fence: a
   * cross-user collision is a protocol answer, a stale generation is a no-op.
   */
  putEvents?(
    id: string,
    owner: ResponseOwner,
    events: readonly ResponseEvent[],
    generation: ResponseGeneration,
  ): Promise<void>;
  /**
   * The persisted event stream of this exact turn of `id`, or `undefined` when none was stored,
   * the log belongs to another generation, or it belongs to someone else (absent and forbidden
   * are indistinguishable on purpose, exactly like `get`).
   *
   * Matching the generation on reads is required. `put` may replace a response with a new turn
   * before that turn has produced a replay log, and the old turn's log must not become visible
   * through the new resource during that window.
   */
  getEvents?(
    id: string,
    owner: ResponseOwner,
    generation: ResponseGeneration,
  ): Promise<ResponseEvent[] | undefined>;
}

/** Flattens a stored response into the items a follow-up turn should replay. */
export function historyOf(stored: StoredResponse): OutputItem[] {
  return [...(stored.inputItems ?? []), ...stored.response.output];
}

/** Whether two owners are the same partition. Both halves normalize `''` to "no user". */
export function sameOwner(a: ResponseOwner, b: ResponseOwner): boolean {
  return (a === '' ? undefined : a) === (b === '' ? undefined : b);
}

/**
 * Whether `existing` is still the turn that `generation` was issued for.
 *
 * The fence {@link ResponseProvider.putEvents} is conditional on, written once so every provider
 * applies the same rule. A missing record fails it: the id was deleted, and a deleted response must
 * not become replayable again.
 */
export function isCurrentGeneration(
  existing: StoredResponse | undefined,
  generation: ResponseGeneration,
): boolean {
  return existing !== undefined && existing.generation === generation;
}

/** Whether `stored` belongs to `owner`. Both halves normalize `''` to "no user". */
export function isOwnedBy(stored: StoredResponse, owner: ResponseOwner): boolean {
  return sameOwner(stored.userId, owner);
}

/**
 * The record `owner` is allowed to see, or `undefined`.
 *
 * The one place the ownership rule is written, so every {@link ResponseProvider} implementation
 * applies exactly the same one.
 */
export function ownedOrUndefined(
  stored: StoredResponse | undefined,
  owner: ResponseOwner,
): StoredResponse | undefined {
  return stored !== undefined && isOwnedBy(stored, owner) ? stored : undefined;
}

/**
 * Guards a write against replacing a record owned by somebody else.
 *
 * @throws {ProtocolError} 404, so a reused id tells the caller nothing about whose it was.
 */
export function assertWritable(existing: StoredResponse | undefined, incoming: StoredResponse): void {
  assertOwnerCanWrite(existing, incoming.response.id, incoming.userId);
}

/**
 * The same guard, addressed by id and owner rather than by a record to write.
 *
 * This is what {@link ResponseProvider.assertWritable} uses: the early check runs before the turn
 * has produced anything to store, so there is no `StoredResponse` yet.
 *
 * @throws {ProtocolError} 404, so a reused id tells the caller nothing about whose it was.
 */
export function assertOwnerCanWrite(
  existing: StoredResponse | undefined,
  id: string,
  owner: ResponseOwner,
): void {
  if (existing !== undefined && !isOwnedBy(existing, owner)) {
    throw notFound(id);
  }
}
