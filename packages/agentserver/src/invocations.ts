import { context as otelContext } from '@opentelemetry/api';
import { agentSessionId, serverIdentity, sseKeepAliveSeconds } from './config.js';
import type { RequestContext } from './context.js';
import { createRequestContext, HEADERS, runWithRequestContext } from './context.js';
import {
  methodNotAllowed,
  ProtocolError,
  routeNotFound,
  toHeaderValue,
  toProtocolError,
  unavailable,
  upstreamError,
} from './errors.js';
import {
  decodeSegment,
  errorResponse,
  jsonResponse,
  stripPrefix,
  trimTrailingSlashes,
  withStandardHeaders,
} from './http.js';
import { flushTelemetry } from './observability/flush.js';
import { extractTraceContext, withInvocationBaggage } from './observability/trace-context.js';
import { SSE_KEEPALIVE } from './sse.js';

/**
 * The header carrying the caller's invocation id, echoed back on every response.
 *
 * Local to this protocol rather than part of {@link HEADERS}: the shared table is the container
 * contract every protocol answers, and this header exists only for `/invocations` (both
 * references keep the constant inside their Invocations package for the same reason).
 */
export const INVOCATION_ID_HEADER = 'x-agent-invocation-id';

/** The protocol identifier reported on `x-platform-server`. */
const PROTOCOL = 'invocations-2.0.0';

/** One chunk read from a handler's body stream. */
type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

/**
 * The bound the references sanitize ids against: at most 256 characters of `[A-Za-z0-9._:-]`.
 *
 * A value that fails is replaced, not rejected — the id is diagnostic, and refusing the request
 * over it would turn a cosmetic problem into an outage (Python `_sanitize_id`).
 */
const MAX_ID_LENGTH = 256;
const VALID_ID = /^[A-Za-z0-9._:-]+$/;

function sanitizeId(value: string | null): string | undefined {
  if (value === null || value === '' || value.length > MAX_ID_LENGTH || !VALID_ID.test(value)) {
    return undefined;
  }
  return value;
}

/**
 * The session id for one invocation: the `agent_session_id` query parameter, then the
 * platform-assigned `FOUNDRY_AGENT_SESSION_ID`, then a fresh UUID.
 *
 * The query parameter is caller-supplied and sanitized; the environment variable is
 * platform-injected and trusted as-is, like every other platform header. The references disagree
 * on the read routes — .NET ignores the query there where Python honours it — and this
 * implementation applies one rule everywhere: a caller that pins its session on the create is
 * answered consistently when it pins the same session on a read.
 */
function resolveInvocationSessionId(url: URL): string {
  return sanitizeId(url.searchParams.get('agent_session_id')) ?? agentSessionId() ?? crypto.randomUUID();
}

/** What the server resolved for the turn, echoed on the response — including an error response. */
interface TurnIdentity {
  invocationId?: string;
  sessionId?: string;
  /** Whether the turn's body was wrapped, making the wrapper the one that flushes telemetry. */
  streamed?: boolean;
}

function turnHeaders(turn: TurnIdentity): Record<string, string> {
  const headers: Record<string, string> = {};
  if (turn.invocationId !== undefined) {
    // `toHeaderValue` because a GET's invocation id comes straight off the path: the references
    // echo it unvalidated, and a value `Headers.set` cannot represent must degrade to a readable
    // approximation rather than crash the response that reports it.
    headers[INVOCATION_ID_HEADER] = toHeaderValue(turn.invocationId);
  }
  if (turn.sessionId !== undefined) {
    headers[HEADERS.sessionId] = toHeaderValue(turn.sessionId);
  }
  return headers;
}

/** What an {@link InvocationHandler} is told about the request it is answering. */
export interface InvocationContext {
  /**
   * The invocation's id.
   *
   * On `POST /invocations`: the sanitized `x-agent-invocation-id` header, or a generated UUID.
   * On the read and cancel routes: the id from the path, as the caller sent it.
   */
  readonly invocationId: string;
  /** The resolved session id; see the resolution order on {@link InvocationsServer}. */
  readonly sessionId: string;
  /** The platform identity and correlation headers, also ambient via `getRequestContext()`. */
  readonly request: RequestContext;
  /**
   * Aborted when the caller disconnects or the container starts shutting down.
   *
   * The only cancellation this layer wires up: there is no request timeout (the reference removed
   * one deliberately), and the cancel route runs the registered handler rather than aborting
   * anything itself.
   */
  readonly signal: AbortSignal;
}

/**
 * Answers one invocation. The request body, the response body, its status and its content type
 * are all the handler's to choose — the protocol prescribes none of them.
 */
export type InvocationHandler = (
  request: Request,
  context: InvocationContext,
) => Response | Promise<Response>;

/** Construction options for {@link InvocationsServer}. */
export interface InvocationsServerConfig {
  /** Answers `POST /invocations`. Required — a server with nothing to invoke serves nothing. */
  handler: InvocationHandler;
  /** Answers `GET /invocations/{id}`. Absent, the route is a 404, as in the references. */
  getHandler?: InvocationHandler;
  /** Answers `POST /invocations/{id}/cancel`. Absent, the route is a 404, as in the references. */
  cancelHandler?: InvocationHandler;
  /** Mounts the routes under a path prefix. Defaults to none, the hosted layout. */
  prefix?: string;
}

/**
 * A Foundry Invocations protocol server.
 *
 * The counterpart of {@link ResponsesServer} for the `/invocations` contract: where Responses
 * prescribes the payload, the execution modes and the event stream, Invocations prescribes only
 * the routes and the headers. The body is passed to the handler unread, and whatever `Response`
 * the handler returns is what the caller gets — this layer adds the platform's correlation
 * headers, propagates cancellation and trace context, and injects SSE keep-alives when the
 * handler streams `text/event-stream` and `SSE_KEEPALIVE_INTERVAL` asks for them.
 *
 * Routes: `POST /invocations`, `GET /invocations/{id}`, `POST /invocations/{id}/cancel`, and
 * `GET /readiness`. The read and cancel routes answer 404 until their handlers are registered;
 * the platform does not require them.
 *
 * ## Security considerations
 *
 * - **Inbound requests are not authenticated here.** The Foundry gateway is the authorization
 *   boundary, exactly as for {@link ResponsesServer}.
 * - **Handler exceptions are opaque to the caller.** A 500 body says only `internal server
 *   error`, classified `upstream` on `x-platform-error-source`.
 * - **`x-agent-user-id` never leaves.** See {@link RequestContext.platformHeaders}.
 */
export class InvocationsServer {
  readonly #handler: InvocationHandler;
  readonly #getHandler: InvocationHandler | undefined;
  readonly #cancelHandler: InvocationHandler | undefined;
  readonly #prefix: string;
  readonly #shutdown = new AbortController();
  #draining = false;

  constructor(options: InvocationsServerConfig) {
    this.#handler = options.handler;
    this.#getHandler = options.getHandler;
    this.#cancelHandler = options.cancelHandler;
    this.#prefix = trimTrailingSlashes(options.prefix ?? '');
  }

  /**
   * Refuses new work and aborts the signal every in-flight handler holds.
   *
   * Resolved immediately: an invocation has no detached execution — every turn lives inside its
   * HTTP request, and the Node adapter's shutdown already waits for open connections to finish.
   */
  drain(): Promise<void> {
    this.#draining = true;
    this.#shutdown.abort();
    return Promise.resolve();
  }

  /** The `fetch` handler. */
  get fetch(): (request: Request) => Promise<Response> {
    return (request) => this.handle(request);
  }

  /** Routes and answers one request. */
  async handle(request: Request): Promise<Response> {
    const context = createRequestContext(request.headers);
    const turn: TurnIdentity = {};
    try {
      // The caller's W3C trace context becomes the ambient OTel context for the turn, so the
      // handler's spans parent under the calling service's trace. No server span — the
      // references dropped theirs deliberately.
      const response = await otelContext.with(extractTraceContext(request.headers), () =>
        runWithRequestContext(context, async () => this.#route(request, context, turn)),
      );
      return withStandardHeaders(response, context, serverIdentity(PROTOCOL));
    } catch (error) {
      return errorResponse(toProtocolError(error), context, serverIdentity(PROTOCOL), turnHeaders(turn));
    } finally {
      // A wrapped body outlives this scope, and its turn's spans with it; the stream wrapper
      // flushes when the body ends instead (the same split Responses makes for SSE).
      if (turn.streamed !== true) {
        await flushTelemetry();
      }
    }
  }

  async #route(request: Request, context: RequestContext, turn: TurnIdentity): Promise<Response> {
    const url = new URL(request.url);
    const path = trimTrailingSlashes(url.pathname) || '/';

    if (path === '/readiness') {
      // Answered even while draining, so the platform can watch the container leave rotation.
      return jsonResponse({ status: 'healthy' }, 200);
    }

    const relative = stripPrefix(path, this.#prefix);
    // Whole-segment match only: `/invocationsfoo` shares the prefix but is not this protocol.
    if (relative === undefined || (relative !== '/invocations' && !relative.startsWith('/invocations/'))) {
      throw routeNotFound();
    }

    if (this.#draining) {
      throw unavailable('the container is shutting down');
    }

    const rest = relative.slice('/invocations'.length);
    if (rest === '' || rest === '/') {
      if (request.method !== 'POST') {
        throw methodNotAllowed('POST');
      }
      const invocationId = sanitizeId(request.headers.get(INVOCATION_ID_HEADER)) ?? crypto.randomUUID();
      const sessionId = this.#resolveTurn(url, turn, invocationId);
      return this.#dispatch(this.#handler, request, context, turn, invocationId, sessionId);
    }

    const segments = rest.split('/').filter((segment) => segment !== '');
    if (segments.length > 2) {
      throw routeNotFound();
    }
    // Passed through as the caller sent it, like the references: this layer never uses the id as
    // a key, so there is nothing a malformed one could corrupt — the handler that does use it is
    // the place to validate it.
    const id = decodeSegment(segments[0] ?? '', 'invocation_id');
    const action = segments[1];

    if (action === 'cancel') {
      if (request.method !== 'POST') throw methodNotAllowed('POST');
      return this.#dispatchOptional(
        this.#cancelHandler,
        'cancel_invocation',
        request,
        url,
        context,
        turn,
        id,
      );
    }
    if (action !== undefined) {
      throw routeNotFound();
    }
    if (request.method !== 'GET') throw methodNotAllowed('GET');
    return this.#dispatchOptional(this.#getHandler, 'get_invocation', request, url, context, turn, id);
  }

  /**
   * Resolves the turn's identity and records it for the response — including an error response.
   *
   * Resolved exactly once per turn: the session fallback is a generated UUID, so a second
   * resolution would echo a different id than the one the handler saw.
   */
  #resolveTurn(url: URL, turn: TurnIdentity, invocationId: string): string {
    const sessionId = resolveInvocationSessionId(url);
    turn.invocationId = invocationId;
    turn.sessionId = sessionId;
    return sessionId;
  }

  /** The read and cancel routes: registered handlers answer, unregistered ones are a 404. */
  #dispatchOptional(
    handler: InvocationHandler | undefined,
    name: string,
    request: Request,
    url: URL,
    context: RequestContext,
    turn: TurnIdentity,
    invocationId: string,
  ): Promise<Response> {
    // Resolved before the not-implemented check: the 404 carries the same identity headers as
    // every other answer on these routes — the caller correlating a failure needs them most.
    const sessionId = this.#resolveTurn(url, turn, invocationId);
    if (handler === undefined) {
      // 404 rather than 405: the route is defined by the protocol but not offered by this
      // container. `upstream` because what is missing is application code, not platform plumbing
      // (Python answers the same way).
      throw new ProtocolError(404, `${name} is not implemented by this container`, {
        code: 'not_found',
        type: 'not_found',
        source: 'upstream',
      });
    }
    return this.#dispatch(handler, request, context, turn, invocationId, sessionId);
  }

  async #dispatch(
    handler: InvocationHandler,
    request: Request,
    context: RequestContext,
    turn: TurnIdentity,
    invocationId: string,
    sessionId: string,
  ): Promise<Response> {
    const abort = new AbortController();
    const onShutdown = (): void => abort.abort();
    this.#shutdown.signal.addEventListener('abort', onShutdown, { once: true });
    request.signal.addEventListener('abort', onShutdown, { once: true });
    const releaseSignals = (): void => {
      this.#shutdown.signal.removeEventListener('abort', onShutdown);
      request.signal.removeEventListener('abort', onShutdown);
    };
    // `addEventListener` is not a subscription to *state*: a signal that aborted before the
    // listener existed never fires it. Re-read after registration so neither the edge nor the
    // state can be missed.
    if (this.#shutdown.signal.aborted || request.signal.aborted) {
      onShutdown();
    }

    const invocationContext: InvocationContext = {
      invocationId,
      sessionId,
      request: context,
      signal: abort.signal,
    };

    // The server's own baggage stamp, on top of whatever the caller propagated — what ties the
    // handler's spans to this invocation whether or not the caller speaks W3C baggage.
    const turnContext = withInvocationBaggage(otelContext.active(), { invocationId, sessionId });

    let response: Response;
    try {
      response = await otelContext.with(turnContext, () => handler(request, invocationContext));
    } catch (error) {
      releaseSignals();
      throw error instanceof ProtocolError ? error : upstreamError(error);
    }

    // Rebuilt rather than mutated: a handler may return a `Response` whose headers are immutable
    // (one obtained from `fetch`, for instance), and the identity headers must win over anything
    // the handler set — the server's resolution is the one the platform routed by.
    const headers = new Headers(response.headers);
    // `toHeaderValue` because a read route's id comes straight off the path: a value `Headers.set`
    // cannot represent must degrade to a readable approximation rather than crash the response.
    headers.set(INVOCATION_ID_HEADER, toHeaderValue(invocationId));
    headers.set(HEADERS.sessionId, toHeaderValue(sessionId));

    if (response.body === null) {
      releaseSignals();
      return new Response(null, { status: response.status, statusText: response.statusText, headers });
    }
    turn.streamed = true;
    return new Response(this.#wrapBody(response, turnContext, context, releaseSignals), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  /**
   * Wraps a handler's body stream for the life it leads after this request scope closes.
   *
   * Every pull re-enters the turn's OTel context and request context — a stream is consumed by
   * the socket writer, and work the handler still does while it drains must keep its trace and
   * its platform headers. When the handler declared `text/event-stream` and
   * `SSE_KEEPALIVE_INTERVAL` is set, a keep-alive comment goes out after each interval of
   * silence; the wrapper reads at most one chunk ahead, so a slow consumer still exerts
   * backpressure on the handler (the reference's one-item lookahead). Any other content type is
   * passed through untouched — a comment injected into an NDJSON stream would corrupt it.
   */
  #wrapBody(
    response: Response,
    turnContext: ReturnType<typeof otelContext.active>,
    context: RequestContext,
    releaseSignals: () => void,
  ): ReadableStream<Uint8Array> {
    const contentType = response.headers.get('content-type') ?? '';
    const keepAliveMs = contentType.toLowerCase().startsWith('text/event-stream')
      ? sseKeepAliveSeconds() * 1000
      : 0;
    // biome-ignore lint/style/noNonNullAssertion: callers checked `body !== null`.
    const reader = response.body!.getReader();
    const keepAliveBytes = new TextEncoder().encode(SSE_KEEPALIVE);

    let pending: Promise<ReadResult> | undefined;
    let finished = false;
    const finish = async (): Promise<void> => {
      if (finished) {
        return;
      }
      finished = true;
      releaseSignals();
      // The turn's spans leave with the body, not with a batch timer that may never fire in a
      // sandbox frozen right after the last byte.
      await flushTelemetry();
    };

    return new ReadableStream<Uint8Array>({
      pull: async (controller): Promise<void> => {
        // The read starts inside the turn's scopes; `AsyncLocalStorage` and the OTel context
        // follow the async flow from here into the handler's own pull callback.
        pending ??= otelContext.with(turnContext, () => runWithRequestContext(context, () => reader.read()));
        let result: ReadResult;
        try {
          if (keepAliveMs > 0) {
            const raced = await raceRead(pending, keepAliveMs);
            if (raced === undefined) {
              // Silence, not the end: comfort the proxies and keep waiting on the same read.
              controller.enqueue(keepAliveBytes);
              return;
            }
            result = raced;
          } else {
            result = await pending;
          }
        } catch (error) {
          pending = undefined;
          await finish();
          throw error;
        }
        pending = undefined;
        if (result.done) {
          controller.close();
          await finish();
          return;
        }
        controller.enqueue(result.value);
      },
      cancel: async (reason: unknown): Promise<void> => {
        // The client hung up: stop the handler rather than let it stream to nobody. The cancel
        // re-enters the turn's scopes for the same reason the pulls do — the handler's stream
        // teardown runs from here, and it must still see the turn's trace and request context.
        try {
          await otelContext.with(turnContext, () =>
            runWithRequestContext(context, () => reader.cancel(reason)),
          );
        } finally {
          await finish();
        }
      },
    });
  }
}

/**
 * `read`, or `undefined` when it has not settled within `ms`.
 *
 * Losing the race abandons the wait, not the read: the caller keeps the same promise and waits
 * again, which is what makes the keep-alive loop read only one chunk ahead.
 */
function raceRead<T>(read: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    read.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
