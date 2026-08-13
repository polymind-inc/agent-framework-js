import type { IdClaim } from './background-run.js';
import { BackgroundRun } from './background-run.js';
import { sseKeepAliveSeconds } from './config.js';
import { HEADERS } from './context.js';
import { ProtocolError } from './errors.js';
import { jsonResponse } from './http.js';
import type { ResponseTracker } from './lifecycle.js';
import { applyCancelledTerminal } from './lifecycle.js';
import { flushTelemetry } from './observability/flush.js';
import { SequenceNumberWriter, SSE_HEADERS, toSseStream } from './sse.js';
import type { ResponseOwner, ResponseProvider } from './store/provider.js';
import { TerminalPersister } from './terminal.js';
import type { OutputItem, ResponseEvent, ResponseObject } from './wire.js';
import { isTerminalEventType } from './wire.js';

/**
 * Rewrites a run's terminal as `cancelled`, and makes the tracked resource match.
 *
 * The port of Python `_orchestrator._maybe_override_to_cancelled`: once the caller has
 * been promised `cancelled`, a handler that ignores the signal and goes on to emit its own
 * `completed` must not have that terminal honoured — neither on the wire nor in the store. Without
 * this the cancel route's own persist is simply overwritten by the run when it finally ends.
 *
 * The event keeps the type `response.failed`, as the reference's override does: the protocol has
 * no `response.cancelled` event, so the status on the carried resource is what says what happened.
 */
function cancelledTerminal(tracker: ResponseTracker): ResponseEvent {
  const response = applyCancelledTerminal(tracker.response);
  tracker.replace(response);
  return { type: 'response.failed', response };
}

/**
 * `background=true`: run the handler detached from the request, registered in the server's claim
 * registry.
 *
 * - `stream=false` answers 200 once the handler's first event is in — status `queued` or
 *   `in_progress`, exactly what the caller then polls with `GET` (Python `run_background`
 *   waits for `response.created` the same way; a handler that fails before any event is
 *   reported as the `failed` snapshot, still with 200).
 * - `stream=true` answers an SSE subscription over the same detached run. Dropping it does
 *   not cancel the run; the caller reconnects with `GET ?stream=true&starting_after=N`.
 */
export async function startBackground(args: {
  responseId: string;
  claim: IdClaim;
  streamed: boolean;
  owner: ResponseOwner;
  sessionId: string;
  tracker: ResponseTracker;
  events: AsyncIterable<ResponseEvent>;
  inputItems: readonly OutputItem[];
  abort: AbortController;
  persist: () => Promise<void>;
  persistSnapshot: (response: ResponseObject) => Promise<void>;
  releaseSignals: () => void;
  store: ResponseProvider;
  /** Most events the run retains for replay; the server's `maxStreamEvents` limit. */
  maxEvents: number;
  /** Whether the claim this run started under is still the current holder of its id. */
  holdsClaim: () => boolean;
  /** Drops that claim, and only that claim: whoever holds the id now keeps it. */
  releaseClaim: () => void;
}): Promise<Response> {
  const run = new BackgroundRun({
    owner: args.owner,
    streamed: args.streamed,
    tracker: args.tracker,
    inputItems: args.inputItems,
    abort: args.abort,
    persistSnapshot: args.persistSnapshot,
    maxEvents: args.maxEvents,
  });
  // The id was claimed before any of the awaits that led here; this is the handover, not a
  // second registration.
  args.claim.run = run;
  run.done = runBackground({
    run,
    responseId: args.responseId,
    claim: args.claim,
    events: args.events,
    persist: args.persist,
    releaseSignals: args.releaseSignals,
    store: args.store,
    holdsClaim: args.holdsClaim,
    releaseClaim: args.releaseClaim,
  });
  // The claim's wait becomes the run's. Anyone already holding it — a `drain()` that started
  // while this create was still in setup — now waits for the terminal state and the replay log
  // too, without ever having seen a run.
  args.claim.settle(run.done);

  if (args.streamed) {
    const keepAliveMs = sseKeepAliveSeconds() * 1000;
    return new Response(toSseStream(run.follow(-1), { keepAliveMs }), {
      status: 200,
      headers: { ...SSE_HEADERS, [HEADERS.sessionId]: args.sessionId },
    });
  }
  await run.firstEvent;
  return jsonResponse(run.tracker.response, 200, { [HEADERS.sessionId]: args.sessionId });
}

/**
 * Drives one background run to its persisted end. Never throws: there is no request left to
 * answer, so every failure becomes the terminal state instead.
 */
async function runBackground(args: {
  run: BackgroundRun;
  responseId: string;
  claim: IdClaim;
  events: AsyncIterable<ResponseEvent>;
  persist: () => Promise<void>;
  releaseSignals: () => void;
  store: ResponseProvider;
  holdsClaim: () => boolean;
  releaseClaim: () => void;
}): Promise<void> {
  const { run, responseId, claim, events, persist, releaseSignals, store, holdsClaim, releaseClaim } = args;
  const sequence = new SequenceNumberWriter();
  const persister = new TerminalPersister(persist, run.tracker);
  try {
    try {
      for await (const raw of events) {
        let event = raw;
        if (isTerminalEventType(String(event.type))) {
          if (run.cancelRequested) {
            // The caller was already promised `cancelled`; whatever terminal the handler
            // reached does not get to overrule that (Python `_maybe_override_to_cancelled`).
            // Without this the persist below writes the handler's `completed` over the cancel
            // route's `cancelled` — the route has no way to write last, because the run may
            // outlive its grace by any amount.
            event = cancelledTerminal(run.tracker);
          }
          event = await persister.onTerminal(event);
        }
        run.deliver(sequence.stamp(event));
      }
    } catch (error) {
      // `enforceLifecycle` rethrows only before `response.created`. A foreground request turns
      // that into a real status code; a background caller already has its 200, so the failure
      // becomes the terminal state instead (Python `run_background`:
      // `response_failed_before_events` answers the `failed` snapshot, still with 200). The
      // wrap `enforceLifecycle` applied for the 500 body is undone here: like a streamed
      // `response.failed`, this terminal state is the only place left
      // for the caller to learn why the turn failed.
      const cause = error instanceof ProtocolError && error.cause !== undefined ? error.cause : error;
      const message =
        cause instanceof Error ? (cause.message === '' ? cause.name : cause.message) : String(cause);
      const event = run.cancelRequested
        ? // Same override as the loop above: a handler that throws *after* the cancel route
          // answered still ends as `cancelled`, not as `failed` (the reference applies
          // `_maybe_override_to_cancelled` on the resolved terminal whatever produced it).
          cancelledTerminal(run.tracker)
        : run.tracker.lifecycleEvent('response.failed', 'failed', {
            error: { code: 'server_error', message, type: 'server_error' },
          });
      run.deliver(sequence.stamp(await persister.onTerminal(event)));
    }
    // Unreachable while `enforceLifecycle` guarantees a terminal event; kept so a future
    // regression cannot silently drop a finished turn.
    await persister.ensureAttempted();
    if (run.streamed && !run.overflowed) {
      await storeReplayLog(store, responseId, run, claim, holdsClaim);
    }
  } finally {
    // Order matters: the run leaves the registry only after the replay log is on the store, so
    // there is no moment where the id answers neither live nor from storage.
    run.finish();
    // …and only if the slot is still *this* run's. `DELETE` frees it early once the run is
    // terminal (Python `_RuntimeState.delete`), and the id is reusable from that moment on, so
    // an unconditional delete here would deregister whoever holds it now.
    releaseClaim();
    releaseSignals();
    // The detached run is the turn here; flush before the platform freezes the sandbox.
    await flushTelemetry();
  }
}

/**
 * Writes one finished run's replay log, and only under the id that run still holds.
 *
 * This is the one thing the server persists *after* a run has become deletable: it is written
 * once, whole, as the run winds down, while `DELETE` is allowed from the moment the run is
 * terminal (Python `_RuntimeState.delete` refuses on the status, not on the record's presence).
 * The store is keyed by id alone, so an unguarded write lands in whatever turn holds that id when
 * it arrives — after a `DELETE` and a re-create, somebody else's — and `GET ?stream=true` would
 * replay the *previous* run's output under the new response.
 *
 * The local claim check below is only an optimization: it skips a write this server already knows
 * is pointless. **It cannot be the guarantee**, because the id can be freed and re-taken while
 * the write is in flight, and there is no un-write. The guarantee is the generation the store
 * checks under its own lock — see {@link ResponseProvider.putEvents}. Compensating afterwards
 * (writing an empty log over whatever landed) is worse than doing nothing: by then the id may
 * belong to another streamed turn whose own log is in place, and blanking it turns
 * `GET ?stream=true` on a perfectly good response into a 400.
 *
 * The reference has no equivalent write: Python's replay buffer is a per-run in-process subject
 * (`_ResponseEventSubject`) in a registry the delete route tears down, so a stale publisher writes
 * into an object nothing can reach any more. The generation is what gives a store-backed log the
 * same property across a boundary the server cannot hold a lock over.
 */
async function storeReplayLog(
  store: ResponseProvider,
  responseId: string,
  run: BackgroundRun,
  claim: IdClaim,
  holdsClaim: () => boolean,
): Promise<void> {
  const putEvents = store.putEvents?.bind(store);
  if (putEvents === undefined || !holdsClaim()) {
    return;
  }
  try {
    await putEvents(responseId, run.owner, run.events, claim.generation);
  } catch {
    // Replay is best-effort: without the log, `GET ?stream=true` answers the same 400 an expired
    // stream gets. The terminal state itself was persisted before this.
  }
}
