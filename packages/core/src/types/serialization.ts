import type { Annotation, Content, ContentType } from './content.js';
import type { Message } from './message.js';

/** A {@link Content} item in its wire form. */
export type SerializedContent = Record<string, unknown>;

/** A {@link Message} in its wire form. */
export interface SerializedMessage {
  role: string;
  contents: SerializedContent[];
  messageId?: string;
  authorName?: string;
  createdAt?: string;
  additionalProperties?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Every wire `type` literal this version models, keyed exhaustively so the compiler rejects both a
 * stray entry and a missing one whenever the {@link Content} union changes. A variant absent from
 * this record would otherwise deserialize as {@link UnknownContent} — its `type` silently moved to
 * `unknownType` — even though the build models it.
 */
const WIRE_CONTENT_TYPES: Record<Exclude<ContentType, 'unknown'>, true> = {
  text: true,
  text_reasoning: true,
  data: true,
  uri: true,
  error: true,
  function_call: true,
  function_result: true,
  usage: true,
  function_approval_request: true,
  function_approval_response: true,
  hosted_file: true,
  hosted_vector_store: true,
  code_interpreter_tool_call: true,
  code_interpreter_tool_result: true,
  image_generation_tool_call: true,
  image_generation_tool_result: true,
  mcp_server_tool_call: true,
  mcp_server_tool_result: true,
  search_tool_call: true,
  search_tool_result: true,
  shell_tool_call: true,
  shell_tool_result: true,
  shell_command_output: true,
  oauth_consent_request: true,
};

const KNOWN_CONTENT_TYPES: ReadonlySet<string> = new Set(Object.keys(WIRE_CONTENT_TYPES));

/**
 * Content keys whose values are themselves content items or lists of content items.
 *
 * {@link deserializeContent} recurses through exactly these keys; {@link serializeContent}
 * recurses through them plus `result` ({@link SERIALIZED_NESTED_CONTENT_KEYS}, which explains the
 * asymmetry). The lists are what make `rawRepresentation` stripping and {@link UnknownContent}
 * restoration hold at every level. Python recurses structurally instead (`_serialize_value` tests
 * `isinstance(value, Content)`); TypeScript has no runtime equivalent, so the key list is a
 * deliberate stand-in.
 *
 * **Adding a field to {@link Content} that holds a `Content` or `Content[]`? Add its key here**,
 * otherwise nested `rawRepresentation` leaks into persisted session state and nested unknown
 * content never round-trips back to its wire `type`. Keep this in sync with the `Content`-valued
 * entries of Python's `Content.to_dict` `fields_to_capture`.
 */
const NESTED_CONTENT_KEYS = ['functionCall', 'inputs', 'output', 'outputs', 'items'] as const;

/**
 * The keys {@link serializeContent} recurses through — the shared list plus `result`.
 *
 * The two directions are deliberately asymmetric about `result`, mirroring Python. `result` holds
 * whatever a tool returned. When that is Content (a rich tool result), serialization must still
 * strip `rawRepresentation` at every level — an SDK object stored there can be circular, and
 * persisting the session would throw (Python's `_serialize_value` recurses into it via its
 * `isinstance(Content)` test, so plain values pass through untouched). Deserialization must NOT
 * recurse into `result`: a plain-JSON tool result such as `[{type: 'row', id: 1}]` merely happens
 * to carry a `type` key, and rewriting it to `{type: 'unknown', unknownType: 'row', ...}` would
 * corrupt data the model reads when the restored session is re-sent. Python's `Content.from_dict`
 * draws the same line — it restores nested content only under `function_call`, `inputs`,
 * `outputs` and `items`, never under `result`.
 */
const SERIALIZED_NESTED_CONTENT_KEYS = [...NESTED_CONTENT_KEYS, 'result'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `value` is shaped like a content item, as opposed to arbitrary JSON.
 *
 * {@link HostedToolResultContent.output} is typed `unknown` and genuinely holds either — a Content
 * list from the MCP mapping, or whatever a tool returned. Recursing into *every* record turned
 * `{answer: 42}` into `{answer: 42, type: ''}`: with no `type` to read, it was taken for an
 * unmodelled content item and handed back a wire type it never had, breaking the round-trip
 * contract for unknown data.
 *
 * A string `type` is the whole test. A plain object that happens to carry one is indistinguishable
 * from an unmodelled content item, but it costs nothing: {@link UnknownContent} preserves every
 * other field and restores the wire `type`, so such a value round-trips unchanged either way.
 */
function isContentShaped(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.type === 'string';
}

function stripAnnotation(annotation: Annotation): Record<string, unknown> {
  const { rawRepresentation: _raw, ...rest } = annotation;
  return { ...rest };
}

/**
 * Converts a {@link Content} item to its wire form.
 *
 * `rawRepresentation` is dropped at every level and {@link UnknownContent} is
 * restored to the original wire `type`. Every other field — including fields this version does
 * not model — is preserved.
 */
export function serializeContent(content: Content): SerializedContent {
  const { rawRepresentation: _raw, ...rest } = content as Record<string, unknown> & { type: string };
  const out: SerializedContent = { ...rest };

  if (content.type === 'unknown') {
    out.type = content.unknownType;
    delete out.unknownType;
  }

  if (Array.isArray(out.annotations)) {
    out.annotations = (out.annotations as Annotation[]).map(stripAnnotation);
  }
  for (const key of SERIALIZED_NESTED_CONTENT_KEYS) {
    const value = out[key];
    if (Array.isArray(value)) {
      out[key] = value.map((item) => (isContentShaped(item) ? serializeContent(item as Content) : item));
    } else if (isContentShaped(value)) {
      out[key] = serializeContent(value as Content);
    }
  }
  return out;
}

/**
 * Restores a {@link Content} item from its wire form.
 *
 * A `type` this version does not know becomes {@link UnknownContent}: the wire type moves to
 * `unknownType` and every other field is carried through untouched, so a later
 * {@link serializeContent} reproduces the original object.
 */
export function deserializeContent(data: SerializedContent): Content {
  const type = data.type;
  const out: Record<string, unknown> = { ...data };

  if (Array.isArray(out.annotations)) {
    out.annotations = [...(out.annotations as unknown[])];
  }
  for (const key of NESTED_CONTENT_KEYS) {
    const value = out[key];
    if (Array.isArray(value)) {
      out[key] = value.map((item) => (isContentShaped(item) ? deserializeContent(item) : item));
    } else if (isContentShaped(value)) {
      out[key] = deserializeContent(value);
    }
  }

  if (typeof type === 'string' && KNOWN_CONTENT_TYPES.has(type)) {
    return out as unknown as Content;
  }
  out.type = 'unknown';
  out.unknownType = typeof type === 'string' ? type : '';
  return out as unknown as Content;
}

/**
 * Converts a {@link Message} to its wire form.
 *
 * `rawRepresentation` is dropped from the message and from every content item. The result is
 * plain JSON-safe data, so `JSON.stringify(serializeMessage(m))` is the complete serialization.
 */
export function serializeMessage(msg: Message): SerializedMessage {
  const { rawRepresentation: _raw, contents, ...rest } = msg;
  return { ...rest, role: msg.role, contents: contents.map(serializeContent) };
}

/** Restores a {@link Message} from its wire form, preserving unknown fields and unknown content types. */
export function deserializeMessage(data: SerializedMessage): Message {
  const { contents, ...rest } = data;
  return {
    ...rest,
    role: data.role,
    contents: Array.isArray(contents) ? contents.map(deserializeContent) : [],
  };
}

/** Convenience wrapper: {@link serializeMessage} applied to a list. */
export function serializeMessages(messages: readonly Message[]): SerializedMessage[] {
  return messages.map(serializeMessage);
}

/** Convenience wrapper: {@link deserializeMessage} applied to a list. */
export function deserializeMessages(data: readonly SerializedMessage[]): Message[] {
  return data.map(deserializeMessage);
}
