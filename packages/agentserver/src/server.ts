import { context as otelContext } from '@opentelemetry/api';
import {
  agentSessionId,
  cancelGraceMs,
  isHosted,
  maxBodyBytes,
  maxInputItems,
  maxStreamEvents,
  serverIdentity,
  sseKeepAliveSeconds,
} from './config.js';
import type { RequestContext } from './context.js';
import { createRequestContext, HEADERS, runWithRequestContext } from './context.js';
import {
  badRequest,
  conflict,
  methodNotAllowed,
  notFound,
  notImplemented,
  ProtocolError,
  requestTooLarge,
  routeNotFound,
  toHeaderValue,
  toProtocolError,
  unavailable,
  upstreamError,
} from './errors.js';
import { ID_PREFIX, newId, newResponseId } from './ids.js';
import type { LifecycleViolation } from './lifecycle.js';
import { applyCancelledTerminal, enforceLifecycle, ResponseTracker } from './lifecycle.js';
import { flushTelemetry } from './observability/flush.js';
import { bindIterable, extractTraceContext, withResponseBaggage } from './observability/trace-context.js';
import { resolveAgentSessionId } from './session-id.js';
import { SequenceNumberWriter, SSE_HEADERS, toSseStream } from './sse.js';
import { InMemoryResponseProvider } from './store/memory.js';
import type { ResponseGeneration, ResponseOwner, ResponseProvider } from './store/provider.js';
import { sameOwner } from './store/provider.js';
import {
  conversationIdOf,
  parseCreateRequest,
  parseLimit,
  parseOrder,
  parseStartingAfter,
  validateResponseId,
} from './validation.js';
import { raceTimeout } from './wait.js';
import type {
  ApiError,
  CreateResponseRequest,
  DeletedResponse,
  InputItemList,
  OutputItem,
  ResponseEvent,
  ResponseObject,
} from './wire.js';
import { isTerminalEventType } from './wire.js';

/** What a handler is told about the request it is answering. */
export interface HandlerContext {
  /** The id this response will be stored under. Already partition-inherited. */
  readonly responseId: string;
  /** The conversation this turn belongs to, when the request named one. */
  readonly conversationId: string | undefined;
  /** The platform request context: user id, call id, correlation id. */
  readonly request: RequestContext;
  /** The transcript so far, prefetched from the store. Empty for a new conversation. */
  readonly history: readonly OutputItem[];
  /** Aborted when the client disconnects or the container is shutting down. */
  readonly signal: AbortSignal;
  /** Builds the response resource in its initial state, for lifecycle events. */
  readonly response: ResponseObject;
}

/**
 * The one thing an implementation provides: events for a request.
 *
 * Everything else — routing, SSE framing, sequence numbers, execution modes, storage, error
 * shapes — belongs to this package. A handler never sees them.
 */
export type ResponseHandler = (
  request: CreateResponseRequest,
  context: HandlerContext,
) => AsyncIterable<ResponseEvent>;

/** Request-size bounds, so one caller cannot buffer the container into the ground. */
export interface ResponsesServerLimits {
  /** Largest request body read, in bytes. Defaults to `AGENTSERVER_MAX_BODY_BYTES`, or 10 MiB. */
  maxBodyBytes?: number;
  /** Most items an `input` array may carry. Defaults to `AGENTSERVER_MAX_INPUT_ITEMS`, or 1000. */
  maxInputItems?: number;
  /**
   * Most events one background stream retains for replay. Defaults to
   * `AGENTSERVER_MAX_STREAM_EVENTS`, or 10 000. A run that crosses it keeps running and persists
   * its terminal state; only its replay log is dropped (see `maxStreamEvents` in `./config`).
   */
  maxStreamEvents?: number;
}

/** Construction options for {@link ResponsesServer}. */
export interface ResponsesServerConfig {
  handler: ResponseHandler;
  /** Defaults to {@link InMemoryResponseProvider}. */
  store?: ResponseProvider;
  /** Mounted under this path prefix. Foundry serves at the root, which is the default. */
  prefix?: string;
  /** Called for every lifecycle repair, so a misbehaving handler is visible in logs. */
  onViolation?: (violation: LifecycleViolation) => void;
  /** Overrides `FOUNDRY_HOSTING_ENVIRONMENT` detection. */
  hosted?: boolean;
  /** Request-size bounds; every one of them defaults to the environment. */
  limits?: ResponsesServerLimits;
}

/**
 * What the caller is told when a finished response could not be stored (.NET
 * `ResponseOrchestrator`): the turn is reported as `failed` — with the output cleared, because
 * items that were never persisted cannot be retrieved later and returning them would create a
 * false expectation — rather than pretending a `completed` happened that no follow-up turn will
 * be able to resolve.
 */
const STORAGE_ERROR: ApiError = {
  code: 'storage_error',
  message:
    'An internal error occurred while storing the response. Subsequent retrieval is not guaranteed. Please retry the request.',
  type: 'server_error',
};

function storageFailed(response: ResponseObject): ResponseObject {
  return { ...response, status: 'failed', output: [], error: STORAGE_ERROR };
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

/**
 * Who owes one turn's telemetry flush.
 *
 * Every request flushes when it is answered, so no error path can lose the spans a failing turn
 * produced. Two answers hand the turn to something that outlives the request — a committed SSE
 * body, and a detached background run — and those flush in their own `finally` instead: the
 * spans that matter are made *after* the response is out, and a second flush on the request path
 * would only spend the bound (5 s) again for nothing.
 */
interface TurnTelemetry {
  deferred: boolean;
}

/** A 400 with `code: "invalid_mode"` on `param: "stream"`, Python's `_invalid_mode` shape. */
function invalidMode(message: string): ProtocolError {
  return badRequest(message, { code: 'invalid_mode', param: 'stream' });
}

/** The states a response never leaves (Python `_RuntimeState._TERMINAL_STATUSES`). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'incomplete', 'cancelled']);

/** The event's replay cursor position. Events this server persists are always stamped. */
function sequenceOf(event: ResponseEvent): number {
  return typeof event.sequence_number === 'number' ? event.sequence_number : -1;
}

/** A finished event list as an async iterable, for the SSE encoder. */
async function* replayEvents(events: readonly ResponseEvent[]): AsyncGenerator<ResponseEvent> {
  for (const event of events) {
    yield event;
  }
}

/**
 * One detached background execution, registered while it runs.
 *
 * The counterpart of Python's `_RuntimeState` record: `GET` observes in-flight state through it,
 * `GET ?stream=true` subscribes to it, and `/cancel` signals it. It exists only while the run
 * does — once the terminal state (and, for a streamed run, the event log) is persisted, the
 * store is the single source of truth and the record is dropped.
 */
class BackgroundRun {
  readonly owner: ResponseOwner;
  /** Whether the run was created with `stream=true` — the precondition for replay. */
  readonly streamed: boolean;
  readonly tracker: ResponseTracker;
  /** What `input_items` serves while the run is still in flight. */
  readonly inputItems: readonly OutputItem[];
  /** Cancels the handler; also fired by the server's shutdown signal. */
  readonly abort: AbortController;
  /** Persists an arbitrary snapshot under this run's identity; the cancel route's tool. */
  readonly persistSnapshot: (response: ResponseObject) => Promise<void>;
  /** Set when the retention cap was crossed: replay is off the table. Live delivery continues. */
  overflowed = false;
  finished = false;
  cancelRequested = false;
  /** Settles when the runner is done — terminal delivered, persistence attempted. */
  done: Promise<void> = Promise.resolve();

  readonly #maxEvents: number;
  #waiters: Array<() => void> = [];
  readonly #firstEventSeen: () => void;
  /** Resolves once the first event was folded (or the run ended): the non-stream 200 boundary. */
  readonly firstEvent: Promise<void>;

  /** The retained window of stamped events. Streamed runs only. */
  #buffer: ResponseEvent[] = [];
  /** Where `#buffer[0]` sits in the delivery order, so a cursor survives the window moving. */
  #base = 0;
  /** How many events have been delivered, ever. */
  #delivered = 0;
  /** The cursor of every live subscription, so retention can serve the slowest of them. */
  readonly #followers = new Set<{ index: number }>();

  constructor(options: {
    owner: ResponseOwner;
    streamed: boolean;
    tracker: ResponseTracker;
    inputItems: readonly OutputItem[];
    abort: AbortController;
    persistSnapshot: (response: ResponseObject) => Promise<void>;
    maxEvents: number;
  }) {
    this.owner = options.owner;
    this.streamed = options.streamed;
    this.tracker = options.tracker;
    this.inputItems = options.inputItems;
    this.abort = options.abort;
    this.persistSnapshot = options.persistSnapshot;
    this.#maxEvents = options.maxEvents;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.firstEvent = promise;
    this.#firstEventSeen = resolve;
  }

  /**
   * The complete replay log, valid only while `overflowed` is false.
   *
   * Once the cap has been crossed the window has been trimmed to what live subscribers still
   * need, so this is no longer the whole stream and `#runBackground` must not store it.
   */
  get events(): readonly ResponseEvent[] {
    return this.#buffer;
  }

  /** Hands one stamped event to the buffer and to everyone currently waiting on it. */
  deliver(event: ResponseEvent): void {
    if (this.streamed) {
      this.#buffer.push(event);
      this.#delivered += 1;
      if (!this.overflowed && this.#delivered > this.#maxEvents) {
        // The cap is a memory bound, not a protocol state: the run continues, its terminal is
        // still persisted, and every subscriber that is following it live is still carried to
        // that terminal. Only *replay* dies, and it dies whole — a replay missing its head would
        // start without `response.created`, which no client is written to survive. Cutting the
        // live subscribers too would close their streams with no terminal event and no way back
        // in, since reconnecting to an overflowed run is a 400.
        this.overflowed = true;
      }
      this.#trim();
    }
    this.#firstEventSeen();
    this.#wake();
  }

  /**
   * Releases everything no live subscription still needs.
   *
   * Nothing is dropped before the cap is crossed: until then the whole log is the replay log.
   * After it, the window is what the slowest subscriber has yet to read — bounded in turn by the
   * cap itself, so a subscription that has stopped draining (a client that stopped reading its
   * socket) cannot defeat the memory bound. Such a subscriber stays subscribed and resumes from
   * whatever is still retained, terminal included.
   */
  #trim(): void {
    if (!this.overflowed) {
      return;
    }
    let keep = this.#delivered;
    for (const follower of this.#followers) {
      keep = Math.min(keep, follower.index);
    }
    keep = Math.max(keep, this.#base, this.#delivered - this.#maxEvents);
    if (keep > this.#base) {
      this.#buffer.splice(0, keep - this.#base);
      this.#base = keep;
    }
  }

  /** Marks the run over and releases every follower. */
  finish(): void {
    this.finished = true;
    this.#firstEventSeen();
    this.#wake();
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  /**
   * The live subscription: replays the retained buffer past `startingAfter`, then follows until
   * the run finishes. Purely observational — a follower that goes away (a client disconnect
   * closing its SSE stream) leaves the run untouched, which is what decouples a background run
   * from any one connection.
   */
  async *follow(startingAfter: number): AsyncGenerator<ResponseEvent> {
    const follower = { index: this.#base };
    this.#followers.add(follower);
    try {
      for (;;) {
        while (follower.index < this.#delivered) {
          // The window can only have moved past this cursor after the cap was crossed *and* this
          // subscriber stopped draining; picking it up at the new front is what keeps the terminal
          // reachable for it. Checked on every step rather than once per wake, because `yield`
          // below suspends *inside* this loop for as long as the consumer takes to pull: a
          // `#trim()` during that suspension would otherwise leave the cursor behind `#base` and
          // the next read would index the buffer at a negative offset.
          if (follower.index < this.#base) {
            follower.index = this.#base;
          }
          const event = this.#buffer[follower.index - this.#base];
          if (event === undefined) {
            throw new Error('subscriber cursor left the retained window');
          }
          follower.index += 1;
          if (sequenceOf(event) > startingAfter) {
            yield event;
          }
        }
        if (this.finished) {
          return;
        }
        await new Promise<void>((resolve) => this.#waiters.push(resolve));
      }
    } finally {
      this.#followers.delete(follower);
      // A departing subscriber may have been the only reason the window was still held open.
      this.#trim();
    }
  }
}

/**
 * One response id's exclusive hold on the background registry.
 *
 * The claim is taken *synchronously*, the moment a background create has settled on its id, and is
 * what makes "is this id busy?" a decision rather than a guess: the create then spends several
 * awaits — the writability check, the session lookup, the handler's own setup — before there is a
 * {@link BackgroundRun} to register, and two simultaneous creates would otherwise both read an
 * empty registry and both install themselves under the same key.
 *
 * It doubles as the *generation* of the id, in two ways. Locally, every store write a detached run
 * still owes is made conditional on the claim it started under still being the current one, so a
 * run whose id was freed underneath it — `DELETE` frees a terminal run's id while it is winding
 * down — cannot land its writes in a turn that now belongs to somebody else. And
 * {@link IdClaim.generation} carries that identity *into the store*, for the one write whose
 * arrival the server cannot order — the replay log, made long after the turn became deletable.
 *
 * Finally it is what `drain()` waits on. The wait exists from the instant the id is reserved —
 * before there is a run, before the handler has been asked for anything — so a shutdown cannot
 * return while a turn it never saw is still coming.
 */
interface IdClaim {
  /** Who reserved it, so a claim can answer 409-vs-404 before any run exists. */
  readonly owner: ResponseOwner;
  /** This turn's generation of the id, for the fenced store writes. */
  readonly generation: ResponseGeneration;
  /** The run once it has been started; `undefined` for the length of the create's own setup. */
  run: BackgroundRun | undefined;
  /**
   * Settles when everything this claim owes is over: the create's own setup, the detached run, and
   * the terminal persistence and replay log that follow it.
   */
  readonly done: Promise<void>;
  /**
   * Ends the wait, optionally by adopting the work that replaces it. Called exactly once — either
   * with the run's completion, or bare when the create failed before there was a run.
   */
  readonly settle: (work?: Promise<void>) => void;
}

/** A claim and its wait, in the one place both are created. */
function newClaim(owner: ResponseOwner, generation: ResponseGeneration): IdClaim {
  const { promise: done, resolve } = Promise.withResolvers<void>();
  // A failure is still a completion as far as a shutdown is concerned: `drain()` waits for the
  // turn to be *over*, not to have succeeded.
  const settle = (work?: Promise<void>): void => resolve(work?.then(undefined, () => undefined));
  return { owner, generation, run: undefined, done, settle };
}

/**
 * The status a route must judge a registered run by (Python `_refresh_background_status`).
 *
 * Two things make "registered" a different question from "still working":
 *
 * - the registration outlives the terminal state. `#runBackground` persists the terminal, delivers
 *   it, stores the replay log, and only then drops the record — so between the caller reading
 *   `response.completed` and the registry being cleared, the run is registered *and* finished;
 * - a run whose cancellation is under way reads as `cancelled` before its terminal event is in,
 *   so a second cancel takes the idempotent path instead of opening a second winddown.
 */
function runStatus(run: BackgroundRun): string {
  const status = String(run.tracker.response.status);
  return run.cancelRequested && !TERMINAL_STATUSES.has(status) ? 'cancelled' : status;
}

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

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Percent-decodes one path segment.
 *
 * A lone `%` makes `decodeURIComponent` throw a `URIError`, which would surface as an opaque 500
 * for what is plainly a malformed request.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw badRequest('Malformed identifier.', { code: 'invalid_parameters', param: 'response_id' });
  }
}

/**
 * Drops trailing `/` characters, scanning once from the end.
 *
 * Deliberately not `/\/+$/`: that pattern retries the run from every start position, so a request
 * path made of slashes that does not end in one costs time quadratic in its length. The path comes
 * off the wire, which makes the difference a denial-of-service lever rather than a micro-optimization.
 */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

/**
 * A Foundry Responses container protocol v2.0.0 server.
 *
 * The public surface is one `fetch` handler, so it runs behind `node:http` (see `./node`), a
 * framework, or any Web-standard server.
 *
 * ## Security considerations
 *
 * - **Inbound requests are not authenticated here.** The Foundry gateway is the authorization
 *   boundary and every header this server reads is platform-injected. Exposing this port outside
 *   that gateway means trusting whoever can reach it to say who the user is.
 * - **`x-agent-user-id` never leaves.** It identifies the end user across every agent, so it is
 *   read-only input; see {@link RequestContext.platformHeaders}.
 * - **Handler exceptions are opaque to the caller.** A 500 body says only `internal server error`.
 *   They are classified `upstream` on `x-platform-error-source`; the `x-platform-error-detail`
 *   diagnostics header is reserved for `platform`-source failures of this layer itself.
 */
export class ResponsesServer {
  readonly #handler: ResponseHandler;
  readonly #store: ResponseProvider;
  readonly #prefix: string;
  readonly #onViolation: ((violation: LifecycleViolation) => void) | undefined;
  readonly #hosted: boolean;
  readonly #limits: Required<ResponsesServerLimits>;
  readonly #shutdown = new AbortController();
  /**
   * Response ids currently spoken for by a background execution, keyed by id. An entry appears the
   * instant a create settles on its id and carries a {@link BackgroundRun} from the moment the run
   * starts. See {@link IdClaim}.
   */
  readonly #claims = new Map<string, IdClaim>();
  #draining = false;

  constructor(options: ResponsesServerConfig) {
    this.#handler = options.handler;
    this.#store = options.store ?? new InMemoryResponseProvider();
    this.#prefix = trimTrailingSlashes(options.prefix ?? '');
    this.#onViolation = options.onViolation;
    this.#hosted = options.hosted ?? isHosted();
    this.#limits = {
      maxBodyBytes: options.limits?.maxBodyBytes ?? maxBodyBytes(),
      maxInputItems: options.limits?.maxInputItems ?? maxInputItems(),
      maxStreamEvents: options.limits?.maxStreamEvents ?? maxStreamEvents(),
    };
  }

  /**
   * Signals in-flight responses to wrap up. Used by the SIGTERM path.
   *
   * The returned promise settles once every detached background turn has wound down and persisted
   * its terminal state — the Python shutdown handler waits for its background records the same
   * way before letting the process exit. Callers that only need the signal may ignore it.
   *
   * "Turn", not "run": the wait covers a create that has reserved its id and is still in setup as
   * well as one that is already executing. Waiting on {@link BackgroundRun}s alone would miss the
   * whole window between the id being claimed and the run being registered — the writability
   * check, the session lookup, the handler's own setup are all awaits — and a shutdown would return
   * while a turn was still about to start, run, and persist.
   *
   * Admission is synchronized against this in one step: `#draining` is set here, *before* the
   * snapshot below, and `#createResponse` refuses to claim an id once it is set. So every claim is
   * either in this snapshot or was never admitted; there is no third case.
   */
  drain(): Promise<void> {
    this.#draining = true;
    this.#shutdown.abort();
    const pending = [...this.#claims.values()].map((claim) => claim.done);
    return Promise.allSettled(pending).then(() => undefined);
  }

  /**
   * The run answering under `id` for `owner`, or `undefined`.
   *
   * A claim without a run is an id a create has reserved but not started yet: nothing answers under
   * it, so every route reads it as absent and falls through to the store, which is the 404 the
   * caller would have got a moment earlier. A run belonging to someone else reads as absent too.
   */
  #runFor(id: string, owner: ResponseOwner): BackgroundRun | undefined {
    const run = this.#claims.get(id)?.run;
    return run !== undefined && sameOwner(run.owner, owner) ? run : undefined;
  }

  /**
   * Whether `claim` is still the current holder of `id` — the guard on every deferred write.
   *
   * `undefined` means the turn never took a claim (a foreground turn), which is always allowed to
   * write: nothing else can be holding an id it never registered.
   */
  #holds(id: string, claim: IdClaim | undefined): boolean {
    return claim === undefined || this.#claims.get(id) === claim;
  }

  /** Drops `claim`, and only `claim`: whoever holds the id now keeps it. */
  #releaseClaim(id: string, claim: IdClaim | undefined): void {
    if (claim !== undefined && this.#claims.get(id) === claim) {
      this.#claims.delete(id);
    }
  }

  /** The `fetch` handler. */
  get fetch(): (request: Request) => Promise<Response> {
    return (request) => this.handle(request);
  }

  /** Routes and answers one request. */
  async handle(request: Request): Promise<Response> {
    const context = createRequestContext(request.headers);
    const telemetry: TurnTelemetry = { deferred: false };
    try {
      // The caller's W3C trace context and baggage become the ambient OTel context for the
      // whole turn, so the handler's spans parent under the calling service's trace. No server
      // span is created here — that is the reference's deliberate choice on both sides, so the
      // framework's `invoke_agent` attaches directly. With no SDK
      // registered this is a no-op.
      return await otelContext.with(extractTraceContext(request.headers), () =>
        runWithRequestContext(context, async () => {
          const response = await this.#route(request, context, telemetry);
          return this.#withStandardHeaders(response, context);
        }),
      );
    } catch (error) {
      return this.#errorResponse(toProtocolError(error), context);
    } finally {
      // Unconditional, as the reference's is (Python `handle_create` flushes in a `finally`): the
      // failing turns are the ones whose spans are worth the most, and a hosted sandbox may be
      // frozen the moment this response is out — before a `BatchSpanProcessor` timer ever fires.
      // The exception is a turn that outlives its request, which flushes when its own work ends
      // rather than paying for two bounded flushes; see {@link TurnTelemetry}.
      if (!telemetry.deferred) {
        await flushTelemetry();
      }
    }
  }

  async #route(request: Request, context: RequestContext, telemetry: TurnTelemetry): Promise<Response> {
    const url = new URL(request.url);
    const path = trimTrailingSlashes(url.pathname) || '/';

    if (path === '/readiness') {
      // Answered even while draining: the platform needs the probe to keep working so it can see
      // the container leave rotation on its own terms.
      return jsonResponse({ status: 'healthy' }, 200);
    }

    // `startsWith` alone is not a prefix match: with `prefix = '/api'` it would also claim
    // `/apiary/responses`. Only the whole segment counts.
    const relative =
      this.#prefix === ''
        ? path
        : path === this.#prefix
          ? '/'
          : path.startsWith(`${this.#prefix}/`)
            ? path.slice(this.#prefix.length)
            : undefined;
    if (relative === undefined || !relative.startsWith('/responses')) {
      throw routeNotFound();
    }

    if (this.#draining) {
      throw unavailable('the container is shutting down');
    }

    const rest = relative.slice('/responses'.length);
    if (rest === '' || rest === '/') {
      if (request.method !== 'POST') {
        throw methodNotAllowed('POST');
      }
      return this.#createResponse(request, context, telemetry);
    }

    const segments = rest.split('/').filter((segment) => segment !== '');
    if (segments.length > 2) {
      // `/responses/{id}/cancel/anything` is not the cancel route; matching it anyway would make
      // unknown paths silently alias known ones.
      throw routeNotFound();
    }
    const id = decodeSegment(segments[0] ?? '');
    // The id is about to become a storage key — with a file-backed store, a file name. Rejecting a
    // malformed one here keeps behaviour identical across store implementations (the file store
    // would otherwise throw an opaque 500 where the in-memory store answers 404) and makes the id
    // safe to echo in a 404 message.
    validateResponseId(id);
    const action = segments[1];

    if (action === 'cancel') {
      if (request.method !== 'POST') throw methodNotAllowed('POST');
      return this.#cancel(id, context.userId);
    }
    if (action === 'input_items') {
      if (request.method !== 'GET') throw methodNotAllowed('GET');
      return this.#inputItems(id, url, context.userId);
    }
    if (action !== undefined) {
      throw routeNotFound();
    }

    if (request.method === 'GET') return this.#getResponse(id, url, context.userId);
    if (request.method === 'DELETE') return this.#deleteResponse(id, context.userId);
    throw methodNotAllowed('GET, DELETE');
  }

  /**
   * Fails closed when a v1.0.0 caller reaches a v2.0.0 container.
   *
   * The only runtime signal of the protocol version is whether `x-agent-foundry-call-id` is
   * present. Without it, every outbound call to a first-party service would be unattributable, so
   * serving the request would silently do the wrong thing — refusing is the safe answer.
   */
  #assertProtocolVersion(context: RequestContext): void {
    if (this.#hosted && context.foundryCallId === undefined) {
      throw notImplemented(
        'This container implements Responses container protocol 2.0.0, which requires the ' +
          'x-agent-foundry-call-id header. The request did not carry one.',
        'unsupported_container_protocol_version',
      );
    }
  }

  /**
   * Reads and parses the request body, bounded by {@link ResponsesServerLimits.maxBodyBytes}.
   *
   * `request.json()` would buffer however much the caller cares to send; this reads the stream
   * chunk by chunk and stops with a 413 the moment the limit is crossed, whether or not the caller
   * declared a `content-length`.
   */
  async #readJsonBody(request: Request): Promise<unknown> {
    const limit = this.#limits.maxBodyBytes;
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      throw requestTooLarge(limit);
    }

    let text = '';
    if (request.body !== null) {
      const decoder = new TextDecoder();
      const reader = request.body.getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel();
          throw requestTooLarge(limit);
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ProtocolError(400, 'request body must be valid JSON', {
        code: 'invalid_request',
        cause: error,
      });
    }
  }

  async #createResponse(
    request: Request,
    context: RequestContext,
    telemetry: TurnTelemetry,
  ): Promise<Response> {
    this.#assertProtocolVersion(context);

    const payload = await this.#readJsonBody(request);
    const created = parseCreateRequest(payload, { maxInputItems: this.#limits.maxInputItems });
    const conversationId = conversationIdOf(created);
    const previousResponseId =
      typeof created.previous_response_id === 'string' && created.previous_response_id !== ''
        ? created.previous_response_id
        : undefined;

    // The history is resolved *before* the handler runs, so an unknown conversation is a 404
    // rather than a handler failing halfway through a stream it already started. It is resolved
    // *for this caller*: a transcript belonging to someone else is not merely off limits, it does
    // not exist as far as this request is concerned.
    let history: OutputItem[] = [];
    if (previousResponseId !== undefined) {
      const resolved = await this.#store.history(previousResponseId, context.userId);
      if (resolved === undefined) {
        throw notFound(previousResponseId, 'previous_response_id');
      }
      history = resolved;
    } else if (conversationId !== undefined) {
      history = (await this.#store.history(conversationId, context.userId)) ?? [];
    }

    const background = created.background === true;
    if (background && (this.#store.putEvents === undefined || this.#store.getEvents === undefined)) {
      // The `store=true` precondition is already enforced above, so a caller that would break it
      // learns that first. A store without event persistence — one that partitions service-side,
      // like Foundry's — keeps the documented fail-closed answer: running
      // in background without a replayable record would silently promise durability this
      // container cannot honour.
      throw notImplemented(
        'background responses are not supported by this container: the configured response store does not persist event streams',
        'unsupported_parameter',
      );
    }

    // The platform's chosen id wins, then the client's, then a fresh one that inherits the
    // conversation's partition so storage co-locates the turn.
    const platformResponseId = request.headers.get(HEADERS.responseId);
    const responseId =
      platformResponseId !== null && platformResponseId !== ''
        ? platformResponseId
        : (created.response_id ?? newResponseId(previousResponseId ?? conversationId));
    validateResponseId(
      responseId,
      platformResponseId !== null && platformResponseId !== '' ? HEADERS.responseId : 'response_id',
    );

    // Everything from here to the claim below is one synchronous step, decided against the flag
    // `drain()` sets before it snapshots what to wait for.
    //
    // The router's own draining check is not enough: reading the body and resolving the history are
    // awaits, so a request admitted a moment before the shutdown can still arrive here afterwards.
    // Claiming an id at that point would start a background turn behind a drain that has already
    // decided its list — the container would exit with a run still going. Refusing is the same
    // answer the router gives, one step later.
    if (this.#draining) {
      throw unavailable('the container is shutting down');
    }

    // An id a detached background run currently answers under cannot be handed to a second run.
    // `#claims` is keyed by it, so the newcomer would displace the incumbent — after which `GET`,
    // `/cancel` and `input_items` answer for the wrong run, and whichever run finishes first
    // deregisters the other. The store cannot catch this the way it catches a reused *stored* id:
    // a background run persists nothing until its terminal state, so `assertWritable` below sees
    // an unused id and waves the collision through.
    //
    // Cross-owner reuse keeps the store's answer — a plain 404 — so an id in flight tells someone
    // who does not own it nothing at all, not even that it is busy.
    const claimed = this.#claims.get(responseId);
    if (claimed !== undefined) {
      if (!sameOwner(claimed.owner, context.userId)) {
        throw notFound(responseId);
      }
      throw conflict(
        'A response with this id is already in flight. Cancel it or wait for it to finish before reusing the id.',
        'response_in_flight',
        'response_id',
      );
    }
    // Claimed in the same synchronous step as the check above, and *before* the awaits that follow
    // — the writability check, the session lookup, the handler's own setup. Checking against a
    // registry that is only written once a `BackgroundRun` exists is not a check at all: two
    // simultaneous creates for one id both read it empty, both proceed, and the second registers
    // over the first. Everything after this point releases the claim on the
    // way out, so a create that fails does not leave the id pinned.
    // Every turn is stamped, foreground included: the stamp is what tells a stale background write
    // that the record under its id belongs to somebody else now, and a foreground turn is a
    // perfectly ordinary somebody else.
    // The provider may be shared by several server instances, so a process-local counter is not a
    // safe fence: two writers could both call their first turn generation 1. A UUID identifies the
    // turn globally and is round-tripped through both the response and its replay log.
    const generation = crypto.randomUUID();
    const claim: IdClaim | undefined = background ? newClaim(context.userId, generation) : undefined;
    if (claim !== undefined) {
      this.#claims.set(responseId, claim);
    }

    try {
      return await this.#createClaimed({
        request,
        context,
        telemetry,
        created,
        conversationId,
        previousResponseId,
        history,
        background,
        responseId,
        generation,
        claim,
      });
    } catch (error) {
      // The id goes back, so a failed create does not pin it for the life of the container. Once a
      // run has taken it over the release belongs to that run's teardown, and only to the claim it
      // was given — whoever holds the id now keeps it. The wait goes with it: a claim that never
      // became a run owes nothing, and a `drain()` already holding its promise must not hang on it.
      if (claim !== undefined && claim.run === undefined) {
        this.#releaseClaim(responseId, claim);
        claim.settle();
      }
      throw error;
    }
  }

  /**
   * The rest of `POST /responses`, from the point where the response id is settled and — for a
   * background turn — claimed.
   *
   * Split out so the claim has exactly one release path: every failure from here on unwinds through
   * {@link #createResponse}'s `catch`, and the only way the id stays claimed is a background run
   * taking it over.
   */
  async #createClaimed(args: {
    request: Request;
    context: RequestContext;
    telemetry: TurnTelemetry;
    created: CreateResponseRequest;
    conversationId: string | undefined;
    previousResponseId: string | undefined;
    history: readonly OutputItem[];
    background: boolean;
    responseId: string;
    generation: ResponseGeneration;
    claim: IdClaim | undefined;
  }): Promise<Response> {
    const { request, context, telemetry, created, conversationId, previousResponseId } = args;
    const { history, background, responseId, generation, claim } = args;

    // Refuse a reused id *before* the model runs, not when the finished turn is offered to the
    // store. Both refusals are the same 404, but the late one has already spent a model call, run
    // whatever tools the turn asked for, and — while streaming — committed a 200 the caller is
    // reading. Providers that partition service-side do not implement
    // this and keep their existing behaviour.
    if (created.store !== false && this.#store.assertWritable !== undefined) {
      await this.#store.assertWritable(responseId, context.userId);
      if (conversationId !== undefined && conversationId !== responseId) {
        await this.#store.assertWritable(conversationId, context.userId);
      }
    }

    // Resolved per request rather than per response: it names the sandbox the turn runs in, and
    // every turn of one conversation has to come back to the same one.
    const sessionId = await resolveAgentSessionId(created);

    const initial: ResponseObject = {
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'queued',
      output: [],
      // Persisted on the resource because the replay and cancel routes decide their answers by
      // it long after the run itself is gone.
      ...(background ? { background: true } : {}),
      ...(created.model === undefined ? {} : { model: created.model }),
      ...(created.metadata === undefined ? {} : { metadata: created.metadata }),
      ...(previousResponseId === undefined ? {} : { previous_response_id: previousResponseId }),
      ...(conversationId === undefined ? {} : { conversation: { id: conversationId } }),
    };

    const abort = new AbortController();
    const onShutdown = (): void => abort.abort();
    this.#shutdown.signal.addEventListener('abort', onShutdown, { once: true });
    if (!background) {
      // A background run is decoupled from the connection that started it: the caller hanging up
      // must not cancel work it was explicitly told would outlive the request — as in the Python
      // reference, "a consumer disconnect must NOT cancel it". Only the container's own shutdown reaches it.
      request.signal.addEventListener('abort', onShutdown, { once: true });
    }
    // `#shutdown.signal` lives as long as the server; a listener left on it after the turn ends
    // is a leak that grows with every request served. Every exit path below releases both.
    const releaseSignals = (): void => {
      this.#shutdown.signal.removeEventListener('abort', onShutdown);
      request.signal.removeEventListener('abort', onShutdown);
    };
    // `addEventListener` is not a subscription to *state*: an `AbortSignal` that was already
    // aborted never fires again, so a request whose client hung up before this turn was routed —
    // or a `drain()` that landed between the `#draining` check in `#route` and the registration
    // just above — would hand the handler a signal that reads as live, and the turn would report
    // `completed` for work nobody is waiting for. Re-read here, after the
    // listeners are in place, so neither the edge nor the state can be missed.
    if (this.#shutdown.signal.aborted || (!background && request.signal.aborted)) {
      onShutdown();
    }

    const tracker = new ResponseTracker(initial);
    const handlerContext: HandlerContext = {
      responseId,
      conversationId,
      request: context,
      history,
      signal: abort.signal,
      response: initial,
    };

    // The server's own baggage stamp, on top of whatever the caller propagated (Python
    // `handle_create`'s `set_baggage` + `attach`, .NET `PropagateResponseBaggage`). It is what
    // makes the enrichment processor's lifts fire at all: without it `gen_ai.conversation.id`
    // would appear only when the calling service happened to speak W3C baggage. Everything from
    // here on — the handler, its later pulls, and a detached background run started inside —
    // runs under it.
    const turnContext = withResponseBaggage(otelContext.active(), {
      responseId,
      conversationId,
      streaming: created.stream === true,
      // The header as sent, not `context.requestId`: that falls back to a generated id, and the
      // reference sets this entry only when the caller actually supplied one.
      requestId: request.headers.get(HEADERS.requestId) ?? undefined,
    });

    return await otelContext.with(turnContext, async (): Promise<Response> => {
      // A handler that throws synchronously — before returning its iterable — surfaces right
      // here, and the listeners registered above must not outlive the turn
      // (`removeEventListener` is idempotent, so the release below racing the per-mode ones is
      // harmless). The throw came out of the developer's handler, so it is classified `upstream`
      // (as `enforceLifecycle` does for the asynchronous case).
      let events: AsyncIterable<ResponseEvent>;
      try {
        events = enforceLifecycle(
          this.#handler(created, handlerContext),
          tracker,
          this.#onViolation === undefined ? {} : { onViolation: this.#onViolation },
        );
      } catch (error) {
        releaseSignals();
        throw error instanceof ProtocolError ? error : upstreamError(error);
      }
      // An SSE body (and a background run's tail) is pulled after this request scope has closed,
      // and an async generator resumes in its *consumer's* context — which would drop the
      // handler's later spans out of the caller's trace, and the baggage stamped just above with
      // them. Pinning this context to every pull keeps the whole turn under one trace.
      events = bindIterable(events, otelContext.active());

      // A string `input` is shorthand for one user message. Normalizing it here is what keeps it
      // in the stored transcript: left as-is it would simply vanish, and the next turn would
      // replay a conversation missing everything the caller actually said.
      const inputItems: OutputItem[] =
        typeof created.input === 'string'
          ? created.input === ''
            ? []
            : [
                {
                  type: 'message',
                  id: newId(ID_PREFIX.message, responseId),
                  role: 'user',
                  content: [{ type: 'input_text', text: created.input }],
                },
              ]
          : Array.isArray(created.input)
            ? (created.input as OutputItem[])
            : [];
      const storedInputItems = [...history, ...inputItems];
      const persistSnapshot = async (response: ResponseObject): Promise<void> => {
        if (!this.#holds(responseId, claim)) {
          // The id this turn was claiming now belongs to somebody else — `DELETE` frees a terminal
          // run's id while it is still winding down, and the next create takes it. A detached run
          // (or the cancel route's post-grace write) must not land its snapshot on that turn.
          return;
        }
        const stored = {
          response,
          inputItems: storedInputItems,
          // The turn's stamp travels with the record, so a later write addressed by this id can be
          // told apart from one made by whoever holds the id now.
          generation,
          ...(context.userId === undefined ? {} : { userId: context.userId }),
        };
        await this.#store.put(stored);
        if (conversationId !== undefined && conversationId !== response.id) {
          // A conversation-addressed turn is also reachable by the conversation id, so the next
          // request can resolve it without knowing the response id.
          await this.#store.put({ ...stored, response: { ...response, id: conversationId } });
        }
      };
      const persist = async (): Promise<void> => {
        if (created.store === false) {
          return;
        }
        await persistSnapshot(tracker.response);
      };

      // A claim is taken for exactly the background creates, so this *is* the background branch —
      // written against `claim` rather than `background` because the run it starts needs it.
      if (claim !== undefined) {
        const answer = await this.#startBackground({
          responseId,
          claim,
          streamed: created.stream === true,
          owner: context.userId,
          sessionId,
          tracker,
          events,
          inputItems: storedInputItems,
          abort,
          persist,
          persistSnapshot,
          releaseSignals,
        });
        // The detached run is the turn from here on, and it flushes when it winds down.
        telemetry.deferred = true;
        return answer;
      }

      if (created.stream === true) {
        // Set only once the 200 is real: a failure before the commit is answered by this request,
        // so this request is what has to flush the spans it produced.
        const answer = await this.#streamResponse(events, tracker, persist, sessionId, releaseSignals);
        telemetry.deferred = true;
        return answer;
      }
      try {
        return await this.#collectResponse(events, tracker, persist, sessionId);
      } finally {
        releaseSignals();
      }
    });
  }

  /**
   * `background=true`: run the handler detached from the request, registered in {@link #claims}.
   *
   * - `stream=false` answers 200 once the handler's first event is in — status `queued` or
   *   `in_progress`, exactly what the caller then polls with `GET` (Python `run_background`
   *   waits for `response.created` the same way; a handler that fails before any event is
   *   reported as the `failed` snapshot, still with 200).
   * - `stream=true` answers an SSE subscription over the same detached run. Dropping it does
   *   not cancel the run; the caller reconnects with `GET ?stream=true&starting_after=N`.
   */
  async #startBackground(args: {
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
  }): Promise<Response> {
    const run = new BackgroundRun({
      owner: args.owner,
      streamed: args.streamed,
      tracker: args.tracker,
      inputItems: args.inputItems,
      abort: args.abort,
      persistSnapshot: args.persistSnapshot,
      maxEvents: this.#limits.maxStreamEvents,
    });
    // The id was claimed before any of the awaits that led here; this is the handover, not a
    // second registration.
    args.claim.run = run;
    run.done = this.#runBackground({
      run,
      responseId: args.responseId,
      claim: args.claim,
      events: args.events,
      persist: args.persist,
      releaseSignals: args.releaseSignals,
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
  async #runBackground(args: {
    run: BackgroundRun;
    responseId: string;
    claim: IdClaim;
    events: AsyncIterable<ResponseEvent>;
    persist: () => Promise<void>;
    releaseSignals: () => void;
  }): Promise<void> {
    const { run, responseId, claim, events, persist, releaseSignals } = args;
    const sequence = new SequenceNumberWriter();
    let persistAttempted = false;
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
            // Persist *before* the terminal event reaches any follower:
            // a caller that reads `response.completed` — live or replayed — must be able to come
            // back with `previous_response_id`. When the store refuses, the terminal every
            // follower reads is a `response.failed` carrying `storage_error`.
            persistAttempted = true;
            try {
              await persist();
            } catch {
              event = { type: 'response.failed', response: storageFailed(run.tracker.response) };
            }
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
        let event = run.cancelRequested
          ? // Same override as the loop above: a handler that throws *after* the cancel route
            // answered still ends as `cancelled`, not as `failed` (the reference applies
            // `_maybe_override_to_cancelled` on the resolved terminal whatever produced it).
            cancelledTerminal(run.tracker)
          : run.tracker.lifecycleEvent('response.failed', 'failed', {
              error: { code: 'server_error', message, type: 'server_error' },
            });
        persistAttempted = true;
        try {
          await persist();
        } catch {
          event = { type: 'response.failed', response: storageFailed(run.tracker.response) };
        }
        run.deliver(sequence.stamp(event));
      }
      if (!persistAttempted) {
        // Unreachable while `enforceLifecycle` guarantees a terminal event; kept so a future
        // regression cannot silently drop a finished turn.
        try {
          await persist();
        } catch {
          // Nobody left to tell.
        }
      }
      if (run.streamed && !run.overflowed) {
        await this.#storeReplayLog(responseId, run, claim);
      }
    } finally {
      // Order matters: the run leaves the registry only after the replay log is on the store, so
      // there is no moment where the id answers neither live nor from storage.
      run.finish();
      // …and only if the slot is still *this* run's. `DELETE` frees it early once the run is
      // terminal (Python `_RuntimeState.delete`), and the id is reusable from that moment on, so
      // an unconditional delete here would deregister whoever holds it now.
      this.#releaseClaim(responseId, claim);
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
  async #storeReplayLog(responseId: string, run: BackgroundRun, claim: IdClaim): Promise<void> {
    const putEvents = this.#store.putEvents?.bind(this.#store);
    if (putEvents === undefined || !this.#holds(responseId, claim)) {
      return;
    }
    try {
      await putEvents(responseId, run.owner, run.events, claim.generation);
    } catch {
      // Replay is best-effort: without the log, `GET ?stream=true` answers the same 400 an expired
      // stream gets. The terminal state itself was persisted before this.
    }
  }

  /**
   * `stream=false`: drive the handler to completion and answer with the finished resource.
   *
   * A persistence failure after the handler completes is answered as the resource with
   * `status: "failed"` and `error.code: "storage_error"` (.NET's documented behaviour) — not as an
   * opaque 500: the handler did its work, and the caller needs to know specifically that a
   * follow-up `previous_response_id` will not resolve.
   */
  async #collectResponse(
    events: AsyncIterable<ResponseEvent>,
    tracker: ResponseTracker,
    persist: () => Promise<void>,
    sessionId: string,
  ): Promise<Response> {
    for await (const _ of events) {
      // The lifecycle layer already folds each event into the tracker.
    }
    let response = tracker.response;
    try {
      await persist();
    } catch (error) {
      if (error instanceof ProtocolError) {
        // Not a storage outage but a protocol answer — the ownership 404 for a reused
        // `response_id`, most importantly. The caller gets the real status code.
        throw error;
      }
      response = storageFailed(response);
    }
    // No flush here: `handle` flushes every answered request in its own `finally`, which is what
    // covers the `throw` above as well (the reference's `flush_spans`).
    return jsonResponse(response, 200, { [HEADERS.sessionId]: sessionId });
  }

  /** `stream=true`: frame the events as SSE, stamping the sequence numbers. */
  async #streamResponse(
    events: AsyncIterable<ResponseEvent>,
    tracker: ResponseTracker,
    persist: () => Promise<void>,
    sessionId: string,
    releaseSignals: () => void,
  ): Promise<Response> {
    // The first event is pulled *before* the 200 and the SSE headers go out. A handler that fails
    // during setup — an unauthorized session, a missing agent — therefore still reaches the
    // caller as a real status code, which is impossible once the response is committed. Nothing
    // is persisted before `response.created` either, so this is the same boundary the protocol
    // already draws.
    const iterator = events[Symbol.asyncIterator]();
    let first: IteratorResult<ResponseEvent>;
    try {
      first = await iterator.next();
    } catch (error) {
      await iterator.return?.();
      releaseSignals();
      throw error;
    }

    const sequence = new SequenceNumberWriter();
    const numbered = async function* (): AsyncGenerator<ResponseEvent> {
      // Whether the turn has been offered to the store, successfully or not. `.NET` does not
      // retry a failed persist, and neither does this.
      let persistAttempted = false;
      try {
        let pending = first;
        while (pending.done !== true) {
          let event = pending.value;
          if (isTerminalEventType(String(event.type))) {
            // Persist *before* the terminal event is delivered (.NET's streaming contract): a
            // caller that reads `response.completed` must be able to come back with
            // `previous_response_id`. When the store refuses, the terminal the caller reads is a
            // `response.failed` carrying `storage_error` — not a `completed` for a turn that no
            // longer exists anywhere.
            persistAttempted = true;
            try {
              await persist();
            } catch {
              event = { type: 'response.failed', response: storageFailed(tracker.response) };
            }
          }
          yield sequence.stamp(event);
          pending = await iterator.next();
        }
      } finally {
        // The client-disconnect path: the stream was torn down before the terminal event came
        // through. Close the handler chain first so its own `finally` blocks run, then record the
        // partial turn — it is resumable with `previous_response_id`. A store failure here has no
        // caller left to tell, so it is deliberately swallowed.
        try {
          await iterator.return?.();
        } catch {
          // The generator's own failure must not mask the teardown.
        }
        if (!persistAttempted) {
          try {
            await persist();
          } catch {
            // Nothing to answer: the caller is gone.
          }
        }
        releaseSignals();
        // Stream over — flush before the platform freezes the sandbox (the reference's
        // `trace_stream` flushes in its own `finally` the same way).
        await flushTelemetry();
      }
    };

    const keepAliveMs = sseKeepAliveSeconds() * 1000;
    return new Response(toSseStream(numbered(), { keepAliveMs }), {
      status: 200,
      headers: { ...SSE_HEADERS, [HEADERS.sessionId]: sessionId },
    });
  }

  async #getResponse(id: string, url: URL, owner: ResponseOwner): Promise<Response> {
    const streamReplay = url.searchParams.get('stream') === 'true';
    // The cursor is validated before anything else the replay path could answer — stream
    // availability, even existence — so an invalid one always reports `param: "starting_after"`
    // (Python parses it first in the fallback path for exactly this reason).
    const startingAfter = streamReplay ? parseStartingAfter(url.searchParams.get('starting_after')) : -1;

    // An in-flight background run is publicly visible before anything is persisted (Python's
    // runtime-state-first lookup). A run belonging to someone else reads as absent, and the
    // store below gives the same caller the same 404.
    const run = this.#runFor(id, owner);
    if (run !== undefined) {
      if (!streamReplay) {
        // A cancel that is still inside its winddown grace has already promised `cancelled`, and
        // the reference refreshes the record's status from the cancel signal before answering any
        // GET (`_refresh_background_status`). Only the status is refreshed — the rest of the
        // snapshot, accumulated output included, stays the handler's until the cancel route
        // applies the actual cancelled terminal.
        const snapshot = run.tracker.response;
        if (run.cancelRequested && !TERMINAL_STATUSES.has(String(snapshot.status))) {
          return jsonResponse({ ...snapshot, status: 'cancelled' }, 200);
        }
        return jsonResponse(snapshot, 200);
      }
      if (!run.streamed) {
        throw invalidMode('This response cannot be streamed because it was not created with stream=true.');
      }
      if (run.overflowed) {
        throw invalidMode(REPLAY_UNAVAILABLE);
      }
      // Replay the retained prefix, then follow live to the terminal (the resilience contract's
      // reconnect clause: events strictly after the cursor, then live-tail).
      const keepAliveMs = sseKeepAliveSeconds() * 1000;
      return new Response(toSseStream(run.follow(startingAfter), { keepAliveMs }), {
        status: 200,
        headers: SSE_HEADERS,
      });
    }

    const stored = await this.#store.get(id, owner);
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
    if (this.#store.getEvents === undefined) {
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
    const events = await this.#store.getEvents(id, owner, stored.generation);
    if (events === undefined || events.length === 0) {
      throw invalidMode(REPLAY_UNAVAILABLE);
    }
    const replayable = events.filter((event) => sequenceOf(event) > startingAfter);
    // A finished stream replays as-is and closes; no keep-alive timer for a body that is already
    // complete (Python's fallback replay does not wrap `with_keep_alive` either).
    return new Response(toSseStream(replayEvents(replayable)), { status: 200, headers: SSE_HEADERS });
  }

  async #deleteResponse(id: string, owner: ResponseOwner): Promise<Response> {
    const run = this.#runFor(id, owner);
    if (run !== undefined && !TERMINAL_STATUSES.has(runStatus(run))) {
      // Only a run that is *still working* is undeletable. Python refuses on the status —
      // `record.mode_flags.background and record.status in {"queued", "in_progress"}` — not on
      // the record's mere presence, and the difference is a real window here: the registration
      // outlives the terminal state by however long the replay log takes to store, and during it
      // the finished turn is already in the store and perfectly deletable.
      throw new ProtocolError(400, 'Cannot delete an in-flight response.', {
        code: 'invalid_request_error',
        param: 'response_id',
      });
    }
    const deleted = await this.#store.delete(id, owner);
    if (!deleted) {
      throw notFound(id);
    }
    // The runtime record goes with the response (Python `_RuntimeState.delete`), so a deleted id
    // does not keep answering `GET` out of the run that is still winding down. The run's own
    // deferred writes are guarded on the claim this drops, so the winddown cannot land them in
    // whatever turn takes the id next.
    const claim = this.#claims.get(id);
    if (run !== undefined && claim?.run === run) {
      this.#claims.delete(id);
    }
    const body: DeletedResponse = { id, object: 'response', deleted: true };
    return jsonResponse(body, 200);
  }

  async #cancel(id: string, owner: ResponseOwner): Promise<Response> {
    const run = this.#runFor(id, owner);
    if (run !== undefined) {
      // A registered run is not necessarily a running one, so the *status* decides — the same
      // order the reference decides it in (`_refresh_background_status`, then
      // `_check_cancel_terminal_status`): a terminal state refuses with its own message, and
      // `cancelled` is idempotent rather than an error.
      const status = runStatus(run);
      const refusal = CANCEL_TERMINAL_ERRORS[status];
      if (refusal !== undefined) {
        throw new ProtocolError(400, refusal, { code: 'invalid_request_error', param: 'response_id' });
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

    const stored = await this.#store.get(id, owner);
    if (stored === undefined) {
      throw notFound(id);
    }
    if (stored.response.background !== true) {
      throw new ProtocolError(400, 'Cannot cancel a synchronous response.', {
        code: 'invalid_request_error',
        param: 'response_id',
      });
    }
    const message = CANCEL_TERMINAL_ERRORS[String(stored.response.status)];
    if (message !== undefined) {
      throw new ProtocolError(400, message, { code: 'invalid_request_error', param: 'response_id' });
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

  async #inputItems(id: string, url: URL, owner: ResponseOwner): Promise<Response> {
    const stored = await this.#store.get(id, owner);
    let source: readonly OutputItem[];
    if (stored !== undefined) {
      source = stored.inputItems ?? [];
    } else {
      // An in-flight background response is publicly visible, and so are its input items
      // (Python's runtime-state fallback in `handle_input_items`).
      const run = this.#runFor(id, owner);
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

  /** Adds the headers the platform expects on every response. */
  #withStandardHeaders(response: Response, context: RequestContext): Response {
    response.headers.set(HEADERS.requestId, context.requestId);
    response.headers.set(HEADERS.serverVersion, serverIdentity());
    // Routes other than `POST /responses` have no request to derive a session from, so they report
    // the container's own, when the platform assigned one (Python `_session_headers`).
    const ambient = agentSessionId();
    if (ambient !== undefined && !response.headers.has(HEADERS.sessionId)) {
      response.headers.set(HEADERS.sessionId, ambient);
    }
    return response;
  }

  /** Renders a {@link ProtocolError} as the wire envelope, with diagnostics kept out of the body. */
  #errorResponse(error: ProtocolError, context: RequestContext): Response {
    const headers: Record<string, string> = {
      [HEADERS.requestId]: context.requestId,
      [HEADERS.serverVersion]: serverIdentity(),
      [HEADERS.errorSource]: error.source,
    };
    // Only a `platform`-source error carries its diagnostics on the header — user and upstream
    // failures are not the platform's to explain (Python `error_response`, .NET
    // `ResponsesExceptionFilter` both gate the detail header the same way).
    if (error.detail !== undefined && error.source === 'platform') {
      headers[HEADERS.errorDetail] = toHeaderValue(error.detail);
    }
    if (error.allow !== undefined) {
      headers.allow = error.allow;
    }
    const ambient = agentSessionId();
    if (ambient !== undefined) {
      headers[HEADERS.sessionId] = ambient;
    }
    return jsonResponse(error.toResponse(context.requestId), error.status, headers);
  }
}
