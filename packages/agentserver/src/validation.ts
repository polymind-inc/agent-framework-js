import { badRequest } from './errors.js';
import { ID_PREFIX, isValidId } from './ids.js';
import type { ApiErrorDetail, CreateResponseRequest, JsonObject } from './wire.js';

const MAX_METADATA_KEYS = 16;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_VALUE_LENGTH = 512;

/**
 * An id that is used as a storage key — and therefore, with a file-backed store, as a file name —
 * is bounded so a pathological value cannot become an unbounded path component.
 */
const MAX_STORE_ID_LENGTH = 256;

// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate — store ids must not carry control characters (path/log/header safety)
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** `agent_session_id` is answered on the `x-agent-session-id` header, so it must be a header-safe token. */
const SESSION_ID_SHAPE = /^[ -~]+$/;

/** The conversation id a request refers to, in either of the two shapes the field allows. */
export function conversationIdOf(request: CreateResponseRequest): string | undefined {
  const conversation = request.conversation;
  if (typeof conversation === 'string') {
    return conversation === '' ? undefined : conversation;
  }
  if (typeof conversation === 'object' && conversation !== null && typeof conversation.id === 'string') {
    return conversation.id === '' ? undefined : conversation.id;
  }
  return undefined;
}

/**
 * Rejects a value that cannot safely be a storage key.
 *
 * Every id this server resolves — a response id from the path, `previous_response_id`, a
 * conversation id, a client-chosen `response_id` — ends up as a lookup key, and with
 * `FileResponseProvider` as a file name under the state root. `resolveUnder` would refuse a
 * traversal attempt anyway, but only with an opaque 500 at whatever point the store is touched —
 * possibly *after* the handler ran. Checking here makes the same input a 400 before any work is
 * done, keeps the observed behaviour identical across store implementations, and (by rejecting
 * control characters) makes the id safe to echo in a 404 message.
 *
 * @throws {ProtocolError} 400 `invalid_parameters` when `id` is empty, too long, contains a path
 * separator, NUL or another control character, is only dots, or is drive-qualified.
 */
export function validateStoreId(id: string, param: string): void {
  if (
    id === '' ||
    id.length > MAX_STORE_ID_LENGTH ||
    CONTROL_CHARACTERS.test(id) ||
    id.includes('/') ||
    id.includes('\\') ||
    id.replaceAll('.', '') === '' ||
    /^[a-zA-Z]:/.test(id)
  ) {
    // The message stays generic on purpose: echoing the id back would reflect caller input.
    throw badRequest('Malformed identifier.', { code: 'invalid_parameters', param });
  }
}

/** Rejects a response id that is not both canonical and safe as a storage key. */
export function validateResponseId(id: string, param = 'response_id'): void {
  if (!isValidId(id, [ID_PREFIX.response])) {
    // The message stays generic on purpose: echoing the id back would reflect caller input.
    throw badRequest('Malformed identifier.', { code: 'invalid_parameters', param });
  }
  validateStoreId(id, param);
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural validation of a `POST /responses` body.
 *
 * Mirrors what Python gets from its generated `validate_create_response_payload`: every field the
 * protocol names is type-checked up front, and all problems are reported together as field-level
 * `details` on one 400 (`$`-rooted JSON paths, `code: 'invalid_value'`). Without this, a
 * mistyped field would flow into the handler and surface as an opaque 500 — or worse, be silently
 * misread: `store: 0` is *falsy* but not `false`, so one code path would treat it as "don't
 * store" and another as "store".
 */
function schemaDetails(request: JsonObject): ApiErrorDetail[] {
  const details: ApiErrorDetail[] = [];
  const wrong = (path: string, expected: string): void => {
    details.push({ code: 'invalid_value', message: `must be ${expected}`, param: path });
  };

  for (const name of ['stream', 'background', 'store', 'parallel_tool_calls']) {
    if (request[name] !== undefined && typeof request[name] !== 'boolean') wrong(`$.${name}`, 'a boolean');
  }
  for (const name of ['model', 'instructions', 'previous_response_id', 'response_id', 'agent_session_id']) {
    if (request[name] !== undefined && typeof request[name] !== 'string') wrong(`$.${name}`, 'a string');
  }
  for (const name of ['temperature', 'top_p', 'max_output_tokens']) {
    if (request[name] !== undefined && typeof request[name] !== 'number') wrong(`$.${name}`, 'a number');
  }
  for (const name of ['stream_options', 'text', 'structured_inputs']) {
    if (request[name] !== undefined && !isPlainObject(request[name])) wrong(`$.${name}`, 'an object');
  }

  const input = request.input;
  if (input !== undefined && typeof input !== 'string' && !Array.isArray(input)) {
    wrong('$.input', 'a string or an array of items');
  }
  if (Array.isArray(input)) {
    input.forEach((item, index) => {
      if (!isPlainObject(item) || typeof item.type !== 'string') {
        wrong(`$.input[${index}]`, "an object with a string 'type'");
      }
    });
  }

  const conversation = request.conversation;
  if (conversation !== undefined && typeof conversation !== 'string' && !isPlainObject(conversation)) {
    wrong('$.conversation', 'a string or an object');
  }
  if (isPlainObject(conversation) && conversation.id !== undefined && typeof conversation.id !== 'string') {
    wrong('$.conversation.id', 'a string');
  }

  const metadata = request.metadata;
  if (metadata !== undefined && !isPlainObject(metadata)) {
    wrong('$.metadata', 'an object');
  }
  if (isPlainObject(metadata)) {
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value !== 'string')
        wrong(`$.metadata['${key.slice(0, MAX_METADATA_KEY_LENGTH)}']`, 'a string');
    }
  }

  const tools = request.tools;
  if (tools !== undefined && !Array.isArray(tools)) {
    wrong('$.tools', 'an array');
  }
  if (Array.isArray(tools)) {
    tools.forEach((tool, index) => {
      if (!isPlainObject(tool)) wrong(`$.tools[${index}]`, 'an object');
    });
  }

  const include = request.include;
  if (include !== undefined && !Array.isArray(include)) {
    wrong('$.include', 'an array of strings');
  }
  if (Array.isArray(include)) {
    include.forEach((entry, index) => {
      if (typeof entry !== 'string') wrong(`$.include[${index}]`, 'a string');
    });
  }

  const agentReference = request.agent_reference;
  if (agentReference !== undefined && !isPlainObject(agentReference)) {
    wrong('$.agent_reference', 'an object');
  }
  if (isPlainObject(agentReference)) {
    if (typeof agentReference.name !== 'string') wrong('$.agent_reference.name', 'a string');
    if (agentReference.version !== undefined && typeof agentReference.version !== 'string') {
      wrong('$.agent_reference.version', 'a string');
    }
  }

  return details;
}

/** Optional limits for {@link parseCreateRequest}. */
export interface ParseCreateRequestLimits {
  /** Maximum number of items an `input` array may carry. */
  maxInputItems?: number;
}

/**
 * Parses and validates a `POST /responses` body.
 *
 * Everything checked here is a precondition the handler is entitled to assume, so each failure is
 * a 400 with the offending `param` rather than something a handler has to re-check. Structural
 * problems are reported first (the counterpart of Python's generated schema-validation pass, as
 * field-level `details[]` with JSON paths), then the semantic constraints.
 *
 * @throws {ProtocolError} 400 when the body is not an object or breaks a documented constraint.
 */
export function parseCreateRequest(
  payload: unknown,
  limits: ParseCreateRequestLimits = {},
): CreateResponseRequest {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw badRequest('request body must be a JSON object');
  }

  const details = schemaDetails(payload as JsonObject);
  if (details.length > 0) {
    throw badRequest('request body failed schema validation', { code: 'invalid_request', details });
  }

  const request = payload as CreateResponseRequest;

  // After the schema pass `store` is a boolean or absent, so `!== false` here and the
  // `=== false` persistence check in the server agree — there is no third, falsy-but-not-false
  // state left for the two to disagree about.
  const store = request.store !== false;
  if (request.background === true && !store) {
    throw badRequest('background=true requires store=true', {
      code: 'unsupported_parameter',
      param: 'background',
    });
  }

  if (request.stream_options !== undefined && request.stream !== true) {
    throw badRequest('stream_options requires stream=true', { code: 'invalid_mode', param: 'stream' });
  }

  validateMetadata(request.metadata);

  const maxInputItems = limits.maxInputItems;
  if (maxInputItems !== undefined && Array.isArray(request.input) && request.input.length > maxInputItems) {
    throw badRequest(`input must have at most ${maxInputItems} items`, { param: 'input' });
  }

  const previous = request.previous_response_id;
  if (typeof previous === 'string' && previous !== '') {
    validateResponseId(previous, 'previous_response_id');
  }

  // A client-chosen `response_id` becomes the id this turn is *stored* under and a path segment on
  // every route that reads it back, so it gets the same check as the one the caller reads from.
  const chosen = request.response_id;
  if (typeof chosen === 'string' && chosen !== '') {
    validateResponseId(chosen);
  }

  // The conversation id is caller-chosen and unconstrained by the protocol, but it is a storage
  // key exactly like the two ids above — without this check its fate would depend on which store
  // implementation happens to be plugged in (file: opaque 500, memory: accepted).
  const conversationId = conversationIdOf(request);
  if (conversationId !== undefined) {
    validateStoreId(conversationId, 'conversation');
  }

  // `agent_session_id` is echoed on the `x-agent-session-id` response header; a value the header
  // encoder rejects (a newline, non-ASCII) would otherwise become a 500 *after* the handler ran.
  const sessionId = request.agent_session_id;
  if (typeof sessionId === 'string' && sessionId.trim() !== '') {
    const trimmed = sessionId.trim();
    if (trimmed.length > MAX_STORE_ID_LENGTH || !SESSION_ID_SHAPE.test(trimmed)) {
      throw badRequest('Malformed identifier.', { code: 'invalid_parameters', param: 'agent_session_id' });
    }
  }

  return request;
}

function validateMetadata(metadata: JsonObject | undefined): void {
  if (typeof metadata !== 'object' || metadata === null) {
    return;
  }
  const entries = Object.entries(metadata);
  if (entries.length > MAX_METADATA_KEYS) {
    throw badRequest(`metadata must have at most ${MAX_METADATA_KEYS} key-value pairs`, {
      param: 'metadata',
    });
  }
  for (const [key, value] of entries) {
    if (key.length > MAX_METADATA_KEY_LENGTH) {
      throw badRequest(
        `metadata key '${key.slice(0, MAX_METADATA_KEY_LENGTH)}...' exceeds maximum length of ${MAX_METADATA_KEY_LENGTH} characters`,
        { param: 'metadata' },
      );
    }
    if (typeof value === 'string' && value.length > MAX_METADATA_VALUE_LENGTH) {
      throw badRequest(
        `metadata value for key '${key}' exceeds maximum length of ${MAX_METADATA_VALUE_LENGTH} characters`,
        { param: 'metadata' },
      );
    }
  }
}

/** A string Python's `int()` accepts: optional sign, digits, surrounding whitespace. */
const INTEGER_SHAPE = /^\s*[+-]?\d+\s*$/;

/**
 * Parses `limit` for `GET /responses/{id}/input_items`.
 *
 * Two distinct messages, matching Python (`_endpoint_handler.handle_input_items`): a value that
 * is not an integer at all — `Number.parseInt`'s partial parse of `"12abc"` must not slip
 * through where Python's `int()` raises — and an integer outside 1–100.
 */
export function parseLimit(raw: string | null): number {
  if (raw === null) {
    return 20;
  }
  if (!INTEGER_SHAPE.test(raw)) {
    throw badRequest('limit must be an integer between 1 and 100', { param: 'limit' });
  }
  const limit = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw badRequest('limit must be between 1 and 100', { param: 'limit' });
  }
  return limit;
}

/**
 * Parses `starting_after` for `GET /responses/{id}?stream=true`: a sequence-number cursor.
 *
 * Absent means "from the beginning", which Python spells `-1` (`_parse_starting_after`); any
 * negative value means the same, because the replay filter is strictly-greater-than. Validated
 * before stream availability is even considered, so an invalid cursor always reports
 * `param: "starting_after"` (Python validates it early in the fallback path for the same
 * reason).
 */
export function parseStartingAfter(raw: string | null): number {
  if (raw === null) {
    return -1;
  }
  if (!INTEGER_SHAPE.test(raw)) {
    throw badRequest('starting_after must be an integer', { param: 'starting_after' });
  }
  const cursor = Number.parseInt(raw, 10);
  if (Number.isSafeInteger(cursor)) {
    return cursor;
  }
  // Python's `int()` is arbitrary-precision: a cursor beyond every sequence number replays
  // nothing, and a hugely negative one replays everything. Clamp to the same effect.
  return cursor > 0 ? Number.MAX_SAFE_INTEGER : -1;
}

/**
 * Parses `order` for `GET /responses/{id}/input_items`.
 *
 * Defaults to `'desc'` and matches case-insensitively — Python reads
 * `request.query_params.get("order", "desc").lower()` (`_endpoint_handler.py`).
 */
export function parseOrder(raw: string | null): 'asc' | 'desc' {
  if (raw === null) {
    return 'desc';
  }
  const order = raw.toLowerCase();
  if (order === 'asc' || order === 'desc') {
    return order;
  }
  throw badRequest("order must be 'asc' or 'desc'", { param: 'order' });
}
