import type { ApiError, ApiErrorDetail, ApiErrorResponse } from './wire.js';

/** Where a failure came from, reported on `x-platform-error-source`. */
export type ErrorSource = 'user' | 'platform' | 'upstream';

/** `x-platform-error-detail` is truncated to this, so a stack trace cannot flood platform logs. */
export const MAX_ERROR_DETAIL_LENGTH = 2048;

/**
 * What a handler exception is reported as.
 *
 * Fixed on purpose. An exception message can carry a connection string, an internal hostname or a
 * fragment of someone else's prompt, and this envelope goes to the caller.
 */
export const SERVER_ERROR_MESSAGE = 'internal server error';

/** Options for {@link ProtocolError}. */
export interface ProtocolErrorOptions extends ErrorOptions {
  /** Machine-readable code, for example `unsupported_parameter`. */
  code?: string;
  /** The offending request parameter. */
  param?: string;
  /**
   * Error category. Defaults to `invalid_request_error` for 4xx — Python's
   * `RequestValidationError` carries that `type` whatever the `code` says (models/errors.py) —
   * and to `code` otherwise.
   */
  type?: string;
  /** Field-level problems. */
  details?: ApiErrorDetail[];
  source?: ErrorSource;
  /** Internal diagnostics. Sent on `x-platform-error-detail` only, never in the body. */
  detail?: string;
  /** The `Allow` header value, for a 405. */
  allow?: string;
}

/** A failure with a defined HTTP status and error envelope. */
export class ProtocolError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: string;
  readonly param?: string;
  readonly details?: ApiErrorDetail[];
  readonly source: ErrorSource;
  readonly detail?: string;
  readonly allow?: string;

  constructor(status: number, message: string, options: ProtocolErrorOptions = {}) {
    super(message, options);
    this.name = 'ProtocolError';
    this.status = status;
    this.code = options.code ?? 'invalid_request_error';
    // A 4xx is a request the caller can fix, and the reference reports every one of those as
    // `invalid_request_error` regardless of its more specific `code` (models/errors.py).
    this.type = options.type ?? (status >= 400 && status < 500 ? 'invalid_request_error' : this.code);
    if (options.param !== undefined) this.param = options.param;
    if (options.details !== undefined) this.details = options.details;
    this.source = options.source ?? (status >= 500 ? 'platform' : 'user');
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.allow !== undefined) this.allow = options.allow;
  }

  /** The wire envelope for this error. */
  toResponse(requestId?: string): ApiErrorResponse {
    const error: ApiError = { code: this.code, message: this.message, type: this.type };
    error.param = this.param ?? null;
    if (this.details !== undefined) {
      // Every detail entry is itself typed `invalid_request_error`, with `code` defaulting to
      // `invalid_value` (Python `RequestValidationError.to_error`).
      error.details = this.details.map((detail) => ({
        code: detail.code ?? 'invalid_value',
        message: detail.message,
        ...(detail.param === undefined ? {} : { param: detail.param }),
        type: 'invalid_request_error',
      }));
    }
    if (requestId !== undefined) error.additionalInfo = { request_id: requestId };
    return { error };
  }
}

/** A request that failed validation: 400 with field-level `details`. */
export function badRequest(
  message: string,
  options: Omit<ProtocolErrorOptions, 'source'> = {},
): ProtocolError {
  return new ProtocolError(400, message, { code: 'invalid_request', ...options, source: 'user' });
}

/** A response that does not exist: 404. */
export function notFound(resourceId: string, param = 'response_id'): ProtocolError {
  return new ProtocolError(404, `response '${resourceId}' was not found`, {
    code: 'invalid_request_error',
    param,
    source: 'user',
  });
}

/**
 * A request that collides with something this container is already working on: 409.
 *
 * The reference keeps a distinct envelope for exactly this class of refusal rather than folding
 * it into `invalid_request_error` — `_endpoint_handler` answers `conversation_locked` and
 * `conversation_fork_not_supported` as `409` with `type: "conflict"` — because the request is not
 * malformed and will succeed once the conflicting work is done.
 */
export function conflict(message: string, code: string, param?: string): ProtocolError {
  return new ProtocolError(409, message, {
    code,
    type: 'conflict',
    source: 'user',
    ...(param === undefined ? {} : { param }),
  });
}

/**
 * Something this container cannot do at all: 501.
 *
 * Used for the protocol-version fail-closed check, and for execution modes that are not
 * implemented yet.
 */
export function notImplemented(message: string, code = 'not_implemented'): ProtocolError {
  return new ProtocolError(501, message, { code, source: 'platform' });
}

/** A request body larger than the configured bound: 413, before any of it is processed. */
export function requestTooLarge(limitBytes: number): ProtocolError {
  return new ProtocolError(413, `request body exceeds the maximum size of ${limitBytes} bytes`, {
    code: 'request_too_large',
    type: 'invalid_request_error',
    source: 'user',
  });
}

/** The container is draining and cannot take new work: 503. */
export function unavailable(message: string): ProtocolError {
  return new ProtocolError(503, message, {
    code: 'service_unavailable',
    type: 'server_error',
    source: 'platform',
  });
}

/** A path that matches no route: 404, saying nothing about what the caller asked for. */
export function routeNotFound(): ProtocolError {
  return new ProtocolError(404, 'not found', { code: 'not_found', type: 'not_found', source: 'user' });
}

/** A known path reached with the wrong verb: 405. The caller is told which verbs it accepts. */
export function methodNotAllowed(allowed: string): ProtocolError {
  return new ProtocolError(405, 'method not allowed', {
    code: 'method_not_allowed',
    type: 'invalid_request_error',
    source: 'user',
    allow: allowed,
  });
}

function opaque500(cause: unknown, source: ErrorSource): ProtocolError {
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return new ProtocolError(500, SERVER_ERROR_MESSAGE, {
    code: 'server_error',
    type: 'server_error',
    source,
    detail,
    cause,
  });
}

/**
 * Wraps any thrown value as a 500 whose body says nothing about it.
 *
 * The real message survives in {@link ProtocolError.detail}, which the server puts on
 * `x-platform-error-detail` for operators — only for `platform`-source errors, and never in the
 * response the caller reads.
 */
export function serverError(cause: unknown): ProtocolError {
  return opaque500(cause, 'platform');
}

/**
 * Wraps an exception that escaped the *handler* as a 500.
 *
 * The body is as opaque as {@link serverError}'s; only the `x-platform-error-source`
 * classification differs. An uncaught exception from the developer's agent code — or a service
 * it called — is `upstream`, not `platform`, so the platform routes it to the right team (.NET
 * `ResponsesExceptionFilter`, Python `_validation.error_response`).
 */
export function upstreamError(cause: unknown): ProtocolError {
  return opaque500(cause, 'upstream');
}

/** Normalizes anything thrown by a route or a handler into a {@link ProtocolError}. */
export function toProtocolError(error: unknown): ProtocolError {
  return error instanceof ProtocolError ? error : serverError(error);
}

/**
 * Makes a diagnostic string safe to put in an HTTP header, and bounds it.
 *
 * Header values are byte strings: a message containing non-Latin-1 text — a localized exception,
 * a user's prompt echoed into an error — would otherwise throw while *building the error
 * response*, turning a clean 500 into a dropped connection.
 */
export function toHeaderValue(detail: string): string {
  let out = '';
  for (const char of detail.slice(0, MAX_ERROR_DETAIL_LENGTH)) {
    const code = char.codePointAt(0) ?? 0;
    out += code >= 0x20 && code <= 0x7e ? char : '?';
  }
  // Marked rather than silently cut, so an operator reading the header knows the message goes on.
  return detail.length > MAX_ERROR_DETAIL_LENGTH ? `${out}...[truncated]` : out;
}
