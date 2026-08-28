import { context as otelContext } from '@opentelemetry/api';
import { startBackground } from './background-driver.js';
import { type IdClaim, newClaim } from './background-run.js';
import { readJsonBody } from './body.js';
import { isHosted, maxBodyBytes, maxInputItems, maxStreamEvents, serverIdentity } from './config.js';
import type { RequestContext } from './context.js';
import { createRequestContext, HEADERS, runWithRequestContext } from './context.js';
import {
  conflict,
  methodNotAllowed,
  notFound,
  notImplemented,
  ProtocolError,
  routeNotFound,
  toProtocolError,
  unavailable,
  upstreamError,
} from './errors.js';
import { collectResponse, streamResponse } from './foreground.js';
import {
  decodeSegment,
  errorResponse,
  jsonResponse,
  linkedAbort,
  stripPrefix,
  trimTrailingSlashes,
  withStandardHeaders,
} from './http.js';
import { ID_PREFIX, itemIdPrefix, newId, newResponseId } from './ids.js';
import type { LifecycleViolation } from './lifecycle.js';
import { enforceLifecycle, ResponseTracker } from './lifecycle.js';
import { flushTelemetry } from './observability/flush.js';
import { bindIterable, extractTraceContext, withResponseBaggage } from './observability/trace-context.js';
import {
  cancelResponse,
  deleteResponse,
  getResponse,
  listInputItems,
  type ResourceRouteState,
} from './resource-routes.js';
import { resolveAgentReference, resolveAgentSessionId } from './session-id.js';
import { InMemoryResponseProvider } from './store/memory.js';
import type { ResponseGeneration, ResponseProvider } from './store/provider.js';
import { sameOwner } from './store/provider.js';
import { conversationIdOf, parseCreateRequest, positiveLimit, validateResponseId } from './validation.js';
import type {
  AgentReference,
  CreateResponseRequest,
  OutputItem,
  ResponseEvent,
  ResponseObject,
} from './wire.js';

/** What a handler is told about the request it is answering. */
export interface HandlerContext {
  /** The id this response will be stored under. Already partition-inherited. */
  readonly responseId: string;
  /** The conversation this turn belongs to, when the request named one. */
  readonly conversationId: string | undefined;
  /** The platform request context: user id, call id, correlation id. */
  readonly request: RequestContext;
  /**
   * Which agent this turn resolved to. Always carries a non-empty name — the same resolution
   * stamped on the response resource, so a handler routing between agents reads it here instead
   * of re-deriving it from the request.
   */
  readonly agentReference: AgentReference;
  /**
   * The sandbox session this turn runs in, as returned on `x-agent-session-id`. Container-scoped,
   * not conversation-scoped: one value serves every conversation and user this container hosts,
   * so it must never key per-conversation or per-user state.
   */
  readonly agentSessionId: string;
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

// jsonResponse, decodeSegment, trimTrailingSlashes and the prefix/header/error plumbing live in
// http.ts, shared with the Invocations server: the container contract is one contract, and the
// parts of it every protocol answers identically must have one implementation. The same split
// carries through the rest of the protocol: the terminal-persistence contract is in terminal.ts,
// the foreground execution modes in foreground.ts, the detached background driver in
// background-driver.ts, and the id-addressed routes in resource-routes.ts.

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
   * instant a create settles on its id and carries a `BackgroundRun` from the moment the run
   * starts. See {@link IdClaim}.
   */
  readonly #claims = new Map<string, IdClaim>();
  /** What the id-addressed routes (`GET`, `DELETE`, `/cancel`, `/input_items`) read. */
  readonly #resources: ResourceRouteState;
  #draining = false;

  constructor(options: ResponsesServerConfig) {
    this.#handler = options.handler;
    this.#store = options.store ?? new InMemoryResponseProvider();
    this.#prefix = trimTrailingSlashes(options.prefix ?? '');
    this.#onViolation = options.onViolation;
    this.#hosted = options.hosted ?? isHosted();
    this.#limits = {
      maxBodyBytes: positiveLimit('maxBodyBytes', options.limits?.maxBodyBytes ?? maxBodyBytes()),
      maxInputItems: positiveLimit('maxInputItems', options.limits?.maxInputItems ?? maxInputItems()),
      maxStreamEvents: positiveLimit('maxStreamEvents', options.limits?.maxStreamEvents ?? maxStreamEvents()),
    };
    this.#resources = { store: this.#store, claims: this.#claims };
  }

  /**
   * Signals in-flight responses to wrap up. Used by the SIGTERM path.
   *
   * The returned promise settles once every detached background turn has wound down and persisted
   * its terminal state — the Python shutdown handler waits for its background records the same
   * way before letting the process exit. Callers that only need the signal may ignore it.
   *
   * "Turn", not "run": the wait covers a create that has reserved its id and is still in setup as
   * well as one that is already executing. Waiting on `BackgroundRun`s alone would miss the
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
   * Whether `claim` is still the current holder of `id` — the guard on every deferred write.
   *
   * Every create takes a claim, foreground turns included: they need the same exclusion as
   * detached ones or two model/tool runs can share one id.
   */
  #holds(id: string, claim: IdClaim): boolean {
    return this.#claims.get(id) === claim;
  }

  /** Drops `claim`, and only `claim`: whoever holds the id now keeps it. */
  #releaseClaim(id: string, claim: IdClaim): void {
    if (this.#claims.get(id) === claim) {
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
          return withStandardHeaders(response, context, serverIdentity());
        }),
      );
    } catch (error) {
      return errorResponse(toProtocolError(error), context, serverIdentity());
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

    const relative = stripPrefix(path, this.#prefix);
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
    const id = decodeSegment(segments[0] ?? '', 'response_id');
    // The id is about to become a storage key — with a file-backed store, a file name. Rejecting a
    // malformed one here keeps behaviour identical across store implementations (the file store
    // would otherwise throw an opaque 500 where the in-memory store answers 404) and makes the id
    // safe to echo in a 404 message.
    validateResponseId(id);
    const action = segments[1];

    if (action === 'cancel') {
      if (request.method !== 'POST') throw methodNotAllowed('POST');
      return cancelResponse(this.#resources, id, context.userId);
    }
    if (action === 'input_items') {
      if (request.method !== 'GET') throw methodNotAllowed('GET');
      return listInputItems(this.#resources, id, url, context.userId);
    }
    if (action !== undefined) {
      throw routeNotFound();
    }

    if (request.method === 'GET') return getResponse(this.#resources, id, url, context.userId);
    if (request.method === 'DELETE') return deleteResponse(this.#resources, id, context.userId);
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

  async #createResponse(
    request: Request,
    context: RequestContext,
    telemetry: TurnTelemetry,
  ): Promise<Response> {
    this.#assertProtocolVersion(context);

    const payload = await readJsonBody(request, this.#limits.maxBodyBytes);
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
    const claim = newClaim(context.userId, generation);
    this.#claims.set(responseId, claim);

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
      if (claim.run === undefined) {
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
    claim: IdClaim;
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
    // Which agent produced this response. Always resolved to a non-empty name: a service-side
    // store validates its presence on every write, and rejects one without it opaquely.
    const agentReference = resolveAgentReference(created.agent_reference);

    const initial: ResponseObject = {
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'queued',
      output: [],
      agent_reference: agentReference,
      // Persisted on the resource because the replay and cancel routes decide their answers by
      // it long after the run itself is gone.
      ...(background ? { background: true } : {}),
      ...(created.model === undefined ? {} : { model: created.model }),
      ...(created.metadata === undefined ? {} : { metadata: created.metadata }),
      ...(previousResponseId === undefined ? {} : { previous_response_id: previousResponseId }),
      ...(conversationId === undefined ? {} : { conversation: { id: conversationId } }),
    };

    // A background run is decoupled from the connection that started it: the caller hanging up
    // must not cancel work it was explicitly told would outlive the request — as in the Python
    // reference, "a consumer disconnect must NOT cancel it". Only the container's own shutdown
    // reaches it. `linkedAbort` re-reads the sources after registering, so an abort that landed
    // before this turn was routed is not missed.
    const { controller: abort, release } = linkedAbort(
      this.#shutdown.signal,
      background ? undefined : request.signal,
    );
    // Every exit path below releases the listeners and — for a turn that lives inside its
    // request — the claim. The paths that share this teardown can each reach it, so every step
    // is idempotent: removing a removed listener is a no-op, `#releaseClaim` only drops the
    // claim it is given, and a settled claim stays settled.
    const releaseSignals = (): void => {
      release();
      if (!background) {
        this.#releaseClaim(responseId, claim);
        claim.settle();
      }
    };

    const tracker = new ResponseTracker(initial);
    const handlerContext: HandlerContext = {
      responseId,
      conversationId,
      request: context,
      agentReference,
      agentSessionId: sessionId,
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
      // handler's later spans out of the caller's trace (and the baggage stamped just above with
      // them), and lose the platform headers a service-side store requires. Pinning both ambient
      // scopes to every pull keeps the whole turn under one trace and one request context.
      const turnContext = otelContext.active();
      events = bindIterable(events, (fn) =>
        otelContext.with(turnContext, () => runWithRequestContext(context, fn)),
      );

      // A string `input` is shorthand for one user message. Normalizing it here is what keeps it
      // in the stored transcript: left as-is it would simply vanish, and the next turn would
      // replay a conversation missing everything the caller actually said. An item array is
      // normalized too: callers — the Foundry Playground among them — send items with no ids,
      // and a service-side store refuses an id-less item (Foundry answers an opaque 500), which
      // would turn the whole persist into a `storage_error` terminal. An item that already
      // carries an id keeps it — replayed history is deduplicated against the store by exactly
      // that id — and an id-less item of a type with no known prefix stays out of persistence
      // (Python `to_output_item` drops unrecognized types the same way): no valid id can be
      // minted for it, and it already reached the model as input.
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
            ? (created.input as OutputItem[]).flatMap((item): OutputItem[] => {
                if (typeof item.id === 'string' && item.id !== '') {
                  return [item];
                }
                const prefix = itemIdPrefix(item.type);
                return prefix === undefined ? [] : [{ ...item, id: newId(prefix, responseId) }];
              })
            : [];
      const storedInputItems = [...history, ...inputItems];
      // The replayed history is already held by a service-side store under these very ids, so it
      // travels as references; only this turn's own items are new. A local store ignores the
      // split and keeps the merged list.
      const historyItemIds = history
        .map((item) => item.id)
        .filter((id): id is string => typeof id === 'string' && id !== '');
      // Bound to this turn's request context however it is reached: a foreground stream persists
      // from the SSE consumer's pull and a detached run from its winddown — both outside the
      // request's AsyncLocalStorage scope — and a service-side store needs the turn's platform
      // headers on every one of those writes.
      const persistSnapshot = (response: ResponseObject): Promise<void> =>
        runWithRequestContext(context, async (): Promise<void> => {
          if (!this.#holds(responseId, claim)) {
            // The id this turn was claiming now belongs to somebody else — `DELETE` frees a
            // terminal run's id while it is still winding down, and the next create takes it. A
            // detached run (or the cancel route's post-grace write) must not land its snapshot on
            // that turn.
            return;
          }
          const stored = {
            response,
            inputItems: storedInputItems,
            historyItemIds,
            // The turn's stamp travels with the record, so a later write addressed by this id
            // can be told apart from one made by whoever holds the id now.
            generation,
            ...(context.userId === undefined ? {} : { userId: context.userId }),
          };
          await this.#store.put(stored);
          if (
            conversationId !== undefined &&
            conversationId !== response.id &&
            this.#store.linksConversationsServiceSide !== true
          ) {
            // A conversation-addressed turn is also reachable by the conversation id, so the next
            // request can resolve it without knowing the response id. Local stores get that from
            // this alias record; a service-linked store resolves the conversation itself (and its
            // alias create would collide with the item ids the service already holds).
            await this.#store.put({
              ...stored,
              response: { ...response, id: conversationId },
              aliasOf: response.id,
            });
          }
        });
      const persist = async (): Promise<void> => {
        if (created.store === false) {
          return;
        }
        await persistSnapshot(tracker.response);
      };

      // A background run takes ownership of its claim until detached winddown. Foreground turns
      // release the same kind of claim through `releaseSignals` when collection or SSE ends.
      if (background) {
        const answer = await startBackground({
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
          store: this.#store,
          maxEvents: this.#limits.maxStreamEvents,
          // The run's deferred writes and its own deregistration act on the claim taken above;
          // handed over as closures so the driver never reaches into the registry itself.
          holdsClaim: () => this.#holds(responseId, claim),
          releaseClaim: () => this.#releaseClaim(responseId, claim),
        });
        // The detached run is the turn from here on, and it flushes when it winds down.
        telemetry.deferred = true;
        return answer;
      }

      if (created.stream === true) {
        // Set only once the 200 is real: a failure before the commit is answered by this request,
        // so this request is what has to flush the spans it produced.
        const answer = await streamResponse(
          events,
          tracker,
          persist,
          sessionId,
          releaseSignals,
          abort.signal,
        );
        telemetry.deferred = true;
        return answer;
      }
      try {
        return await collectResponse(events, tracker, persist, sessionId);
      } finally {
        releaseSignals();
      }
    });
  }
}
