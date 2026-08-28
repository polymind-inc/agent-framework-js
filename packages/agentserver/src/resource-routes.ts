import type { BackgroundRun, IdClaim } from './background-run.js';
import { sequenceOf } from './background-run.js';
import { cancelGraceMs, sseKeepAliveMs } from './config.js';
import { badRequest, notFound, notImplemented, ProtocolError } from './errors.js';
import { jsonResponse, sseResponse } from './http.js';
import { applyCancelledTerminal } from './lifecycle.js';
import type { ResponseOwner, ResponseProvider } from './store/provider.js';
import { sameOwner } from './store/provider.js';
import { parseLimit, parseOrder, parseStartingAfter } from './validation.js';
import { raceTimeout } from './wait.js';
import type { DeletedResponse, InputItemList, OutputItem, ResponseEvent } from './wire.js';

/**
 * What the id-addressed routes — `GET`, `DELETE`, `/cancel`, `/input_items` — read from the server
 * that mounts them: the store, and the claim registry in-flight background runs are found through.
 * The registry is the server's own map; these routes only ever remove entries from it (`DELETE`
 * tears a finished run's record down), never add them.
 */
export interface ResourceRouteState {
  readonly store: ResponseProvider;
  readonly claims: Map<string, IdClaim>;
}

/**
 * The cancel refusals for each terminal state, worded exactly as the reference words them
 * (Python `_endpoint_handler._CANCEL_TERMINAL_ERRORS`). `cancelled` is missing on purpose:
 * cancelling an already-cancelled response is idempotent and answers 200.
 */
const CANCEL_TERMINAL_ERRORS: Readonly<Partial<Record<string, string>>> = {
  completed: 'Cannot cancel a completed response.',
  failed: 'Cannot cancel a failed response.',
  incomplete: 'Cannot cancel a response in terminal state.',
};

/**
 * The combined message for a background response whose event stream is not available — never
 * created (`stream=false`), dropped over the retention cap, or lost to a storage failure. The
 * persisted response does not say which, and Python's fallback uses one combined message for
 * exactly that reason (`_handle_get_fallback`).
 */
const REPLAY_UNAVAILABLE =
  'This response cannot be streamed because it was not created with stream=true or the stream TTL has expired.';

/** A 400 with `code: "invalid_mode"` on `param: "stream"`, Python's `_invalid_mode` shape. */
function invalidMode(message: string): ProtocolError {
  return badRequest(message, { code: 'invalid_mode', param: 'stream' });
}

/** A 400 refusal on `param: "response_id"` — the shape every delete/cancel refusal here shares. */
function refuse(message: string): ProtocolError {
  return new ProtocolError(400, message, { code: 'invalid_request_error', param: 'response_id' });
}

/** The states a response never leaves (Python `_RuntimeState._TERMINAL_STATUSES`). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'incomplete', 'cancelled']);

/** A finished event list as an async iterable, for the SSE encoder. */
async function* replayEvents(events: readonly ResponseEvent[]): AsyncGenerator<ResponseEvent> {
  for (const event of events) {
    yield event;
  }
}

/**
 * The status a route must judge a registered run by (Python `_refresh_background_status`).
 *
 * Two things make "registered" a different question from "still working":
 *
 * - the registration outlives the terminal state. The background driver persists the terminal,
 *   delivers it, stores the replay log, and only then drops the record — so between the caller
 *   reading `response.completed` and the registry being cleared, the run is registered *and*
 *   finished;
 * - a run whose cancellation is under way reads as `cancelled` before its terminal event is in,
 *   so a second cancel takes the idempotent path instead of opening a second winddown.
 */
function runStatus(run: BackgroundRun): string {
  const status = String(run.tracker.response.status);
  return run.cancelRequested && !TERMINAL_STATUSES.has(status) ? 'cancelled' : status;
}

/**
 * The run answering under `id` for `owner`, or `undefined`.
 *
 * A claim without a run is an id a create has reserved but not started yet: nothing answers under
 * it, so every route reads it as absent and falls through to the store, which is the 404 the
 * caller would have got a moment earlier. A run belonging to someone else reads as absent too.
 */
function runFor(state: ResourceRouteState, id: string, owner: ResponseOwner): BackgroundRun | undefined {
  const run = state.claims.get(id)?.run;
  return run !== undefined && sameOwner(run.owner, owner) ? run : undefined;
}

/** `GET /responses/{id}`, plain and `?stream=true` replay. */
export async function getResponse(
  state: ResourceRouteState,
  id: string,
  url: URL,
  owner: ResponseOwner,
): Promise<Response> {
  const streamReplay = url.searchParams.get('stream') === 'true';
  // The cursor is validated before anything else the replay path could answer — stream
  // availability, even existence — so an invalid one always reports `param: "starting_after"`
  // (Python parses it first in the fallback path for exactly this reason).
  const startingAfter = streamReplay ? parseStartingAfter(url.searchParams.get('starting_after')) : -1;

  // An in-flight background run is publicly visible before anything is persisted (Python's
  // runtime-state-first lookup). A run belonging to someone else reads as absent, and the
  // store below gives the same caller the same 404.
  const run = runFor(state, id, owner);
  if (run !== undefined) {
    if (!streamReplay) {
      // A cancel that is still inside its winddown grace has already promised `cancelled`, and
      // `runStatus` refreshes a registered run's status from the cancel signal exactly the way
      // the reference does before answering any GET (`_refresh_background_status`). Only the
      // status is refreshed — the rest of the snapshot, accumulated output included, stays the
      // handler's until the cancel route applies the actual cancelled terminal.
      const snapshot = run.tracker.response;
      const status = runStatus(run);
      return jsonResponse(status === String(snapshot.status) ? snapshot : { ...snapshot, status }, 200);
    }
    if (!run.streamed) {
      throw invalidMode('This response cannot be streamed because it was not created with stream=true.');
    }
    if (run.overflowed) {
      throw invalidMode(REPLAY_UNAVAILABLE);
    }
    // Replay the retained prefix, then follow live to the terminal (the resilience contract's
    // reconnect clause: events strictly after the cursor, then live-tail).
    return sseResponse(run.follow(startingAfter), { keepAliveMs: sseKeepAliveMs() });
  }

  const stored = await state.store.get(id, owner);
  if (stored === undefined) {
    throw notFound(id);
  }
  if (!streamReplay) {
    return jsonResponse(stored.response, 200);
  }

  if (stored.response.background !== true) {
    // SSE replay requires background mode, whatever the stream happened to be (the Python
    // reference checks the same rule against the persisted resource in `_handle_get_fallback`).
    throw invalidMode('This response cannot be streamed because it was not created with background=true.');
  }
  if (state.store.getEvents === undefined) {
    // A store that cannot persist events keeps the documented fail-closed answer — the
    // same 501 its background create gives.
    throw notImplemented(
      'replaying a stored response as a stream is not supported by the configured response store',
    );
  }
  // A record whose generation cannot be matched must not be paired with a replay log: a reused
  // id would otherwise expose the previous turn's events. Records written before the current
  // fence come in two shapes, and this branch only catches one of them — both still fail closed,
  // just at different steps:
  //
  // - **No `generation` at all** (written before the generation fence existed). Refused here.
  // - **A numeric `generation`** (written when the fence was a
  //   per-server counter, before it became a UUID string). A number is not `undefined`, so it
  //   passes this check and is handed to `getEvents`, where the comparison against the stored
  //   log's own generation is a strict `===` that a legacy log — which
  //   carries no generation at all — cannot satisfy. `getEvents` answers `undefined` and the
  //   next branch refuses. (A current turn's UUID likewise never `===` a persisted number, so a
  //   legacy log can never be paired with a current record either.)
  //
  // Either way only replay is refused; the resource itself stays retrievable above.
  if (stored.generation === undefined) {
    throw invalidMode(REPLAY_UNAVAILABLE);
  }
  const events = await state.store.getEvents(id, owner, stored.generation);
  if (events === undefined || events.length === 0) {
    throw invalidMode(REPLAY_UNAVAILABLE);
  }
  const replayable = events.filter((event) => sequenceOf(event) > startingAfter);
  // A finished stream replays as-is and closes; no keep-alive timer for a body that is already
  // complete (Python's fallback replay does not wrap `with_keep_alive` either).
  return sseResponse(replayEvents(replayable));
}

/** `DELETE /responses/{id}`. */
export async function deleteResponse(
  state: ResourceRouteState,
  id: string,
  owner: ResponseOwner,
): Promise<Response> {
  const run = runFor(state, id, owner);
  if (run !== undefined && !TERMINAL_STATUSES.has(runStatus(run))) {
    // Only a run that is *still working* is undeletable. Python refuses on the status —
    // `record.mode_flags.background and record.status in {"queued", "in_progress"}` — not on
    // the record's mere presence, and the difference is a real window here: the registration
    // outlives the terminal state by however long the replay log takes to store, and during it
    // the finished turn is already in the store and perfectly deletable.
    throw refuse('Cannot delete an in-flight response.');
  }
  const deleted = await state.store.delete(id, owner);
  if (!deleted) {
    throw notFound(id);
  }
  // The runtime record goes with the response (Python `_RuntimeState.delete`), so a deleted id
  // does not keep answering `GET` out of the run that is still winding down. The run's own
  // deferred writes are guarded on the claim this drops, so the winddown cannot land them in
  // whatever turn takes the id next.
  const claim = state.claims.get(id);
  if (run !== undefined && claim?.run === run) {
    state.claims.delete(id);
  }
  const body: DeletedResponse = { id, object: 'response', deleted: true };
  return jsonResponse(body, 200);
}

/** `POST /responses/{id}/cancel`. */
export async function cancelResponse(
  state: ResourceRouteState,
  id: string,
  owner: ResponseOwner,
): Promise<Response> {
  const run = runFor(state, id, owner);
  if (run !== undefined) {
    // A registered run is not necessarily a running one, so the *status* decides — the same
    // order the reference decides it in (`_refresh_background_status`, then
    // `_check_cancel_terminal_status`): a terminal state refuses with its own message, and
    // `cancelled` is idempotent rather than an error.
    const status = runStatus(run);
    const refusal = CANCEL_TERMINAL_ERRORS[status];
    if (refusal !== undefined) {
      throw refuse(refusal);
    }
    if (status === 'cancelled') {
      // Repeats the cancelled snapshot instead of opening a second winddown — the case where a
      // cancel arrives while the first one is still inside its grace, as well as the plain
      // second cancel (Python's sentinel path re-applies the cancelled terminal the same way).
      return jsonResponse(applyCancelledTerminal(run.tracker.response), 200);
    }

    // The cancellation winddown (Python `handle_cancel`): signal the handler, give
    // it a bounded grace to finish its teardown, then cancellation wins regardless of what the
    // handler managed to emit.
    run.cancelRequested = true;
    run.abort.abort();
    // A run that fails during the winddown still ends the wait: the cancel route must not
    // throw because the handler did.
    await raceTimeout(
      run.done.catch(() => undefined),
      cancelGraceMs(),
    );
    const cancelled = applyCancelledTerminal(run.tracker.response);
    // Written back onto the run, exactly as the reference stamps it on the record
    // (`set_response_snapshot` + `transition_to("cancelled")`): a run that outlived its grace is
    // still registered, and every later reader — `GET`, a second cancel, the run's own terminal
    // override — has to see the state the caller was just promised.
    run.tracker.replace(cancelled);
    try {
      await run.persistSnapshot(cancelled);
    } catch {
      // Best-effort, as in the reference: the caller still gets the cancelled snapshot.
    }
    return jsonResponse(cancelled, 200);
  }

  const stored = await state.store.get(id, owner);
  if (stored === undefined) {
    throw notFound(id);
  }
  if (stored.response.background !== true) {
    throw refuse('Cannot cancel a synchronous response.');
  }
  const message = CANCEL_TERMINAL_ERRORS[String(stored.response.status)];
  if (message !== undefined) {
    throw refuse(message);
  }
  if (stored.response.status === 'cancelled') {
    // Idempotent: cancelling a cancelled response repeats the snapshot (Python's sentinel path).
    return jsonResponse(stored.response, 200);
  }
  // A background record that is neither running here nor terminal: the run that owned it is
  // gone — a restart, an eviction — and there is nothing left to signal (Python's cancel
  // fallback answers 404 for exactly this state).
  throw notFound(id);
}

/** `GET /responses/{id}/input_items`. */
export async function listInputItems(
  state: ResourceRouteState,
  id: string,
  url: URL,
  owner: ResponseOwner,
): Promise<Response> {
  const stored = await state.store.get(id, owner);
  let source: readonly OutputItem[];
  if (stored !== undefined) {
    source = stored.inputItems ?? [];
  } else {
    // An in-flight background response is publicly visible, and so are its input items
    // (Python's runtime-state fallback in `handle_input_items`).
    const run = runFor(state, id, owner);
    if (run === undefined) {
      throw notFound(id);
    }
    source = run.inputItems;
  }
  const limit = parseLimit(url.searchParams.get('limit'));
  const order = parseOrder(url.searchParams.get('order'));

  let items = [...source];
  if (order === 'desc') {
    items.reverse();
  }
  const after = url.searchParams.get('after');
  if (after !== null) {
    const index = items.findIndex((item) => item.id === after);
    items = index < 0 ? items : items.slice(index + 1);
  }
  const before = url.searchParams.get('before');
  if (before !== null) {
    const index = items.findIndex((item) => item.id === before);
    items = index < 0 ? items : items.slice(0, index);
  }

  const page = items.slice(0, limit);
  const body: InputItemList = {
    object: 'list',
    data: page,
    first_id: page[0]?.id ?? null,
    last_id: page[page.length - 1]?.id ?? null,
    has_more: items.length > page.length,
  };
  return jsonResponse(body, 200);
}
