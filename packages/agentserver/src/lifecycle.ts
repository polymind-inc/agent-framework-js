import { ProtocolError, SERVER_ERROR_MESSAGE, upstreamError } from './errors.js';
import type {
  ApiError,
  IncompleteDetails,
  OutputItem,
  ResponseEvent,
  ResponseObject,
  ResponseStatus,
  ResponseUsage,
} from './wire.js';
import { isTerminalEventType } from './wire.js';

/**
 * Why a cancelled turn ended.
 *
 * Not one of the two reasons the schema enumerates (`max_output_tokens`, `content_filter`) —
 * neither describes a container being drained. The field is a free-form string on the wire and the
 * hosting layer already extends it the same way (`tool_approval_required`).
 */
const ABORTED_REASON = 'interrupted';

/**
 * Whether a thrown value is a cancellation rather than a failure.
 *
 * Keyed on the standard `AbortError` name, which is what `AbortSignal.throwIfAborted()` produces
 * and what this package's own controllers (`#shutdown`, the per-run `abort`) carry as their
 * reason. A handler built on the Agent Framework reaches this point with the same value: the
 * providers normalize their SDKs' abort errors — which do *not* set `name` — onto this shape
 * (`@polymind-inc/agent-framework-core`'s `isAbortError` / `abortErrorFrom`).
 *
 * The predicate is duplicated rather than imported because this package is deliberately
 * independent of the Agent Framework (see its `package.json` description): it must stay usable
 * with any handler. Keep it in step with core's `streaming/abort.ts`.
 */
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** Maps a terminal event to the status it puts the response in. */
const TERMINAL_STATUS: Readonly<Record<string, ResponseStatus>> = {
  'response.completed': 'completed',
  'response.failed': 'failed',
  'response.incomplete': 'incomplete',
};

/** What the protocol layer had to correct in a handler's event stream. */
export interface LifecycleViolation {
  kind:
    | 'missing_created'
    | 'missing_in_progress'
    | 'missing_terminal'
    | 'duplicate_created'
    | 'events_after_terminal'
    | 'handler_error'
    /** The turn was cancelled — a client hang-up or a container drain — not a handler failure. */
    | 'aborted';
  detail?: string;
}

/**
 * Tracks the response resource as events flow past.
 *
 * The platform's storage and the non-streaming route both need the finished resource, and the
 * handler only ever reports *changes*. This assembles the current state from what it sees, so both
 * modes are served by one code path.
 */
export class ResponseTracker {
  #response: ResponseObject;

  constructor(initial: ResponseObject) {
    this.#response = initial;
  }

  /** The response as currently known. */
  get response(): ResponseObject {
    return this.#response;
  }

  /**
   * Replaces the tracked resource wholesale (Python `ResponseExecution.set_response_snapshot`).
   *
   * For the one case where the protocol layer, not the handler, decides what the resource is: the
   * cancellation override. What it writes has to be what every later reader sees — the `GET`
   * route, the store, and the terminal event still to be delivered — so it replaces the tracked
   * state rather than being applied at each of them.
   */
  replace(response: ResponseObject): void {
    this.#response = response;
  }

  /**
   * Folds one event into the tracked resource, and returns the event as it should go on the wire.
   *
   * A lifecycle event's `response` is rewritten to the tracked resource, so what the caller reads
   * and what the store keeps are the same object. Without this, a handler that builds its
   * terminal event from the initial resource would stream a `response.completed` with an empty
   * `output` while the stored copy had the real one.
   */
  observe(event: ResponseEvent): ResponseEvent {
    this.#fold(event);
    return event.response === undefined ? event : { ...event, response: this.#response };
  }

  #fold(event: ResponseEvent): void {
    const carried = event.response;
    if (typeof carried === 'object' && carried !== null) {
      const merged = { ...this.#response, ...(carried as ResponseObject) };
      // A handler that builds its terminal event from the initial resource would otherwise blank
      // the output this layer assembled from its own `output_item.done` events. An explicitly
      // populated `output` still wins, so a handler that reports the whole resource is honoured.
      if (!Array.isArray(merged.output) || merged.output.length === 0) {
        merged.output = this.#response.output;
      }
      // The id is the server's to assign; a handler echoing a stale one must not rewrite it.
      merged.id = this.#response.id;
      this.#response = merged;
    }

    if (event.type === 'response.output_item.done') {
      const item = event.item;
      if (typeof item === 'object' && item !== null) {
        this.#appendItem(item as OutputItem);
      }
    }

    const status = TERMINAL_STATUS[event.type];
    if (status !== undefined) {
      this.#response = { ...this.#response, status };
    } else if (event.type === 'response.in_progress') {
      this.#response = { ...this.#response, status: 'in_progress' };
    }
  }

  /** Replaces or appends an output item, keyed by id so a repeated `done` does not duplicate it. */
  #appendItem(item: OutputItem): void {
    const output = [...this.#response.output];
    const index = item.id === undefined ? -1 : output.findIndex((existing) => existing.id === item.id);
    if (index >= 0) {
      output[index] = item;
    } else {
      output.push(item);
    }
    this.#response = { ...this.#response, output };
  }

  /** Builds a lifecycle event for `status` from the tracked resource. */
  lifecycleEvent(
    type: string,
    status: ResponseStatus,
    extra: { error?: ApiError; usage?: ResponseUsage; incompleteDetails?: IncompleteDetails } = {},
  ): ResponseEvent {
    const response: ResponseObject = { ...this.#response, status };
    if (extra.error !== undefined) response.error = extra.error;
    if (extra.usage !== undefined) response.usage = extra.usage;
    if (extra.incompleteDetails !== undefined) response.incomplete_details = extra.incompleteDetails;
    this.#response = response;
    return { type, response };
  }
}

/**
 * Overlays the `cancelled` terminal onto a response snapshot.
 *
 * The port of Python `models/runtime.apply_cancelled_terminal`, whose contract is that
 * **cancellation always wins: "0 output items
 * regardless of what processing had produced"**. So `output` is cleared, and `error` and
 * `completed_at` must be absent — only a `completed` response carries the latter, and a cancelled
 * turn did not fail. Every other field the handler produced (`metadata`, `conversation`, `usage`,
 * `model`, …) is the handler's and is preserved.
 *
 * Returning the accumulated output on a `cancelled` response would be worse than untidy: the
 * caller was told the turn did not happen, while `previous_response_id` would replay items it was
 * told to discard.
 */
export function applyCancelledTerminal(base: ResponseObject): ResponseObject {
  const cancelled: ResponseObject = { ...base, status: 'cancelled', output: [] };
  delete cancelled.error;
  delete cancelled.completed_at;
  return cancelled;
}

/**
 * The message a thrown value contributes to a failed terminal: an `Error`'s own message, its name
 * when that message is empty (Python's fallback: `str(ex) or type(ex).__name__`), or the value
 * stringified.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? (error.message === '' ? error.name : error.message) : String(error);
}

/**
 * Builds the `response.failed` terminal for an unhandled failure from the tracked resource —
 * always `server_error`, with `message` the only variable part.
 */
export function failedTerminal(tracker: ResponseTracker, message: string): ResponseEvent {
  return tracker.lifecycleEvent('response.failed', 'failed', {
    error: { code: 'server_error', message, type: 'server_error' },
  });
}

/** Configuration for {@link enforceLifecycle}. */
export interface EnforceLifecycleOptions {
  /** Called for every correction, so violations are visible rather than silently patched. */
  onViolation?: (violation: LifecycleViolation) => void;
}

/**
 * Enforces the protocol's lifecycle contract on a handler's events.
 *
 * The contract is: `response.created` first, then
 * `response.in_progress`, then output, then exactly one of `response.completed` /
 * `response.failed` / `response.incomplete`.
 *
 * A stream that breaks it is repaired rather than rejected, because by the time events are
 * flowing the caller already has a `200` and an SSE body — there is no status code left to fail
 * with, and a malformed stream would be dropped by the platform instead. Specifically:
 *
 * - a missing `response.created` or `response.in_progress` is synthesized before the event that
 *   needed it, so `queued → terminal` never skips `in_progress`;
 * - a second `response.created` is dropped;
 * - events after a terminal event are dropped, keeping "exactly one" true;
 * - a handler that ends without a terminal event gets `response.failed` (.NET's documented
 *   behaviour: the library fails loudly rather than assuming success);
 * - a handler that throws gets `response.failed` carrying the exception's own message — both
 *   hosting references surface it deliberately (.NET `AgentFrameworkResponseHandler`:
 *   `EmitFailed(ServerError, ex.Message)`; Python `_responses._emit_failure`:
 *   `str(ex) or type name`) so the caller can see *why* the turn failed — and the error is also
 *   reported through `onViolation` for the platform's diagnostics;
 * - except when the throw is a cancellation, which ends the turn as `response.incomplete`.
 */
export async function* enforceLifecycle(
  events: AsyncIterable<ResponseEvent>,
  tracker: ResponseTracker,
  options: EnforceLifecycleOptions = {},
): AsyncGenerator<ResponseEvent> {
  const violation = (kind: LifecycleViolation['kind'], detail?: string): void => {
    options.onViolation?.(detail === undefined ? { kind } : { kind, detail });
  };

  let created = false;
  let inProgress = false;
  let terminated = false;

  /** Emits the lifecycle prefix an event depends on. */
  function* prefixFor(type: string): Generator<ResponseEvent> {
    if (!created) {
      violation('missing_created');
      created = true;
      yield tracker.lifecycleEvent('response.created', 'queued');
    }
    // Neither `response.created` nor `response.in_progress` needs an `in_progress` before it —
    // synthesizing one ahead of the handler's own would double it.
    if (!inProgress && type !== 'response.created' && type !== 'response.in_progress') {
      violation('missing_in_progress');
      inProgress = true;
      yield tracker.lifecycleEvent('response.in_progress', 'in_progress');
    }
  }

  try {
    for await (const event of events) {
      if (terminated) {
        violation('events_after_terminal', event.type);
        continue;
      }
      if (event.type === 'response.created') {
        if (created) {
          violation('duplicate_created');
          continue;
        }
        created = true;
        yield tracker.observe(event);
        continue;
      }

      yield* prefixFor(event.type);
      if (event.type === 'response.in_progress') {
        inProgress = true;
      }
      yield tracker.observe(event);
      if (isTerminalEventType(event.type)) {
        terminated = true;
      }
    }
  } catch (error) {
    if (!created) {
      // Nothing has been emitted, so nothing is committed: the caller can still be told what
      // actually went wrong, with the right status code. A 403 for someone else's session must
      // not be laundered into a generic `response.failed`. An exception the handler did not
      // shape itself is classified as its author's — `upstream`, not `platform` (.NET
      // `ResponsesExceptionFilter`, Python `_validation.error_response`).
      throw error instanceof ProtocolError ? error : upstreamError(error);
    }
    if (!terminated) {
      if (isAbort(error)) {
        // A cancelled turn is unfinished, not broken. SIGTERM and a client hang-up both land here,
        // and `failed` would tell the platform the agent malfunctioned — with a retry against a
        // container that is on its way out. `incomplete` says what actually happened and points at
        // the recovery the protocol already defines: come back with `previous_response_id`. The
        // session was saved on the way out.
        violation('aborted');
        yield* prefixFor('response.incomplete');
        yield tracker.lifecycleEvent('response.incomplete', 'incomplete', {
          incompleteDetails: { reason: ABORTED_REASON },
        });
        return;
      }
      violation('handler_error', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      yield* prefixFor('response.failed');
      // The real message, not a fixed one: both hosting references put `ex.Message` /
      // `str(ex) or type name` on the terminal event, because by now the caller holds a 200 and
      // this event is the only place it can learn why the turn failed.
      yield failedTerminal(tracker, messageOf(error));
    }
    return;
  }

  if (!terminated) {
    violation('missing_terminal');
    yield* prefixFor('response.failed');
    yield failedTerminal(tracker, SERVER_ERROR_MESSAGE);
  }
}
