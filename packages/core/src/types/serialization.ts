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

const KNOWN_CONTENT_TYPES: ReadonlySet<string> = new Set<ContentType>([
  'text',
  'text_reasoning',
  'data',
  'uri',
  'error',
  'function_call',
  'function_result',
  'usage',
  'function_approval_request',
  'function_approval_response',
  'hosted_file',
  'hosted_vector_store',
  'code_interpreter_tool_call',
  'code_interpreter_tool_result',
  'image_generation_tool_call',
  'image_generation_tool_result',
  'mcp_server_tool_call',
  'mcp_server_tool_result',
  'search_tool_call',
  'search_tool_result',
  'shell_tool_call',
  'shell_tool_result',
  'shell_command_output',
  'oauth_consent_request',
]);

/**
 * Content keys whose values are themselves content items or lists of content items.
 *
 * Both {@link serializeContent} and {@link deserializeContent} recurse through exactly these keys,
 * so the list is what makes `rawRepresentation` stripping and {@link UnknownContent} restoration
 * hold at every level. Python recurses structurally instead (`_serialize_value` tests
 * `isinstance(value, Content)`); TypeScript has no runtime equivalent, so the key list is a
 * deliberate stand-in.
 *
 * **Adding a field to {@link Content} that holds a `Content` or `Content[]`? Add its key here**,
 * otherwise nested `rawRepresentation` leaks into persisted session state and nested unknown
 * content never round-trips back to its wire `type`. Keep this in sync with the `Content`-valued
 * entries of Python's `Content.to_dict` `fields_to_capture`.
 */
const NESTED_CONTENT_KEYS = ['functionCall', 'inputs', 'output', 'outputs', 'items'] as const;

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
  for (const key of NESTED_CONTENT_KEYS) {
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
