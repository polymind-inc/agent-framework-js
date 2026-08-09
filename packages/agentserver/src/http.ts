/**
 * HTTP plumbing shared by every protocol server in this package.
 *
 * The Responses and Invocations servers answer different routes with different payloads, but the
 * container contract they sit behind is one contract: the same correlation headers on every
 * response, the same error envelope, the same prefix handling. Keeping the implementations here —
 * rather than one copy per server — is what keeps the two protocols from drifting apart on the
 * parts that must not differ.
 */

import { agentSessionId } from './config.js';
import type { RequestContext } from './context.js';
import { HEADERS } from './context.js';
import type { ProtocolError } from './errors.js';
import { badRequest, toHeaderValue } from './errors.js';

/** A JSON body with the right content type. */
export function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
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
export function decodeSegment(segment: string, param: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw badRequest('Malformed identifier.', { code: 'invalid_parameters', param });
  }
}

/**
 * Drops trailing `/` characters, scanning once from the end.
 *
 * Deliberately not `/\/+$/`: that pattern retries the run from every start position, so a request
 * path made of slashes that does not end in one costs time quadratic in its length. The path comes
 * off the wire, which makes the difference a denial-of-service lever rather than a micro-optimization.
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

/**
 * The part of `path` under `prefix`, or `undefined` when `path` is outside it.
 *
 * `startsWith` alone is not a prefix match: with `prefix = '/api'` it would also claim
 * `/apiary/responses`. Only the whole segment counts. An empty prefix claims everything.
 */
export function stripPrefix(path: string, prefix: string): string | undefined {
  if (prefix === '') {
    return path;
  }
  if (path === prefix) {
    return '/';
  }
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : undefined;
}

/** Adds the headers the platform expects on every response. */
export function withStandardHeaders(
  response: Response,
  context: RequestContext,
  serverVersion: string,
): Response {
  response.headers.set(HEADERS.requestId, context.requestId);
  response.headers.set(HEADERS.serverVersion, serverVersion);
  // Routes that resolved no session of their own report the container's, when the platform
  // assigned one (Python `_session_headers`).
  const ambient = agentSessionId();
  if (ambient !== undefined && !response.headers.has(HEADERS.sessionId)) {
    response.headers.set(HEADERS.sessionId, ambient);
  }
  return response;
}

/** Renders a {@link ProtocolError} as the wire envelope, with diagnostics kept out of the body. */
export function errorResponse(
  error: ProtocolError,
  context: RequestContext,
  serverVersion: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers: Record<string, string> = {
    [HEADERS.requestId]: context.requestId,
    [HEADERS.serverVersion]: serverVersion,
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
  Object.assign(headers, extraHeaders);
  return jsonResponse(error.toResponse(context.requestId), error.status, headers);
}
