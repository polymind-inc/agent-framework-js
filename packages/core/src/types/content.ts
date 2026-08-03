import { encodeBase64 } from './base64.js';
import type { UsageDetails } from './usage.js';

/** A span of text an {@link Annotation} refers to. */
export interface TextSpanRegion {
  type: 'text_span';
  startIndex?: number;
  endIndex?: number;
}

/** Citation-style metadata attached to a {@link Content} item. */
export interface Annotation {
  type: 'citation' | (string & {});
  title?: string;
  url?: string;
  fileId?: string;
  toolName?: string;
  snippet?: string;
  annotatedRegions?: TextSpanRegion[];
  additionalProperties?: Record<string, unknown>;
  /** Provider-specific raw object. Never serialized. */
  rawRepresentation?: unknown;
}

/** Fields shared by every {@link Content} variant. */
export interface ContentBase {
  /**
   * The provider-specific object this content was parsed from.
   *
   * Never serialized (see `serializeMessage`) and never compared. Use it for debugging or to
   * reach provider features the framework does not model.
   */
  rawRepresentation?: unknown;
  /** Free-form metadata that round-trips through serialization. */
  additionalProperties?: Record<string, unknown>;
  /** Citations and other span annotations. */
  annotations?: Annotation[];
  /**
   * `true` when this content asks the human for a decision before the run can continue
   * (approval requests, OAuth consent). Matches Python's `user_input_request` base field: it is
   * serialized, and `AgentResponse.userInputRequests` on every implementation filters on it.
   */
  userInputRequest?: boolean;
}

/** Plain assistant/user text. */
export interface TextContent extends ContentBase {
  type: 'text';
  text: string;
}

/** Model reasoning ("thinking") text, optionally carrying an opaque provider payload. */
export interface TextReasoningContent extends ContentBase {
  type: 'text_reasoning';
  /** Provider-issued id for the reasoning item this fragment belongs to. */
  id?: string;
  text?: string;
  /**
   * Opaque provider data (for example an encrypted reasoning payload) that must be replayed
   * verbatim for stateless continuation.
   */
  protectedData?: string;
}

/** Inline binary or textual data, carried as a `data:` URI. */
export interface DataContent extends ContentBase {
  type: 'data';
  /** A `data:` URI. */
  uri: string;
  mediaType: string;
  name?: string;
}

/** A reference to externally hosted content. */
export interface UriContent extends ContentBase {
  type: 'uri';
  uri: string;
  mediaType?: string;
  name?: string;
}

/** A model request to invoke a tool. */
export interface FunctionCallContent extends ContentBase {
  type: 'function_call';
  /** Correlates this call with its {@link FunctionResultContent}. */
  callId: string;
  name: string;
  /**
   * Arguments as an object, or as a (possibly partial) JSON string while streaming.
   * Streaming fragments are concatenated by `mergeUpdates` / `coalesceContents`.
   */
  arguments: Record<string, unknown> | string;
  /**
   * `true` when the call is reported for information only and must not be executed locally —
   * for example because the service already executed it and returned the result.
   */
  informationalOnly?: boolean;
}

/** The outcome of a tool invocation. */
export interface FunctionResultContent extends ContentBase {
  type: 'function_result';
  /** The {@link FunctionCallContent.callId} this result answers. */
  callId: string;
  result?: unknown;
  /**
   * The tool's return value as content items, when it returned rich output.
   *
   * Set alongside `result` whenever a tool returns a `Content[]`, so a provider that accepts image
   * or file parts in a tool result can send them as parts rather than as JSON text — Python's
   * `from_function_result` populates the same field, and its OpenAI client renders it when
   * `SUPPORTS_RICH_FUNCTION_OUTPUT`. A provider that only takes text keeps using `result`.
   */
  items?: Content[];
  /** Human-readable failure description when the invocation failed. */
  exception?: string;
}

/** A non-fatal error surfaced to the model or the caller. */
export interface ErrorContent extends ContentBase {
  type: 'error';
  message?: string;
  errorCode?: string;
  errorDetails?: string;
}

/** Token usage reported alongside a response. */
export interface UsageContent extends ContentBase {
  type: 'usage';
  usageDetails: UsageDetails;
}

/** A pending human approval for a tool call. Producers set `userInputRequest: true` (Python parity). */
export interface FunctionApprovalRequestContent extends ContentBase {
  type: 'function_approval_request';
  id: string;
  /** The enclosing agent-tool call this nested request suspends, when applicable. */
  callId?: string;
  functionCall: FunctionCallContent;
}

/** A human decision about a {@link FunctionApprovalRequestContent}. */
export interface FunctionApprovalResponseContent extends ContentBase {
  type: 'function_approval_response';
  id: string;
  approved: boolean;
  functionCall: FunctionCallContent;
  /**
   * Why the human decided as they did.
   *
   * A first-class field, matching .NET's `Reason` — it is part of the decision, and a rejection
   * reason is appended to what the model is told so it can adapt rather than retry blindly.
   * `additionalProperties.reason` is still read for transcripts written before this field existed.
   */
  reason?: string;
}

/** A file held by the provider. */
export interface HostedFileContent extends ContentBase {
  type: 'hosted_file';
  fileId: string;
  mediaType?: string;
  name?: string;
}

/** A vector store held by the provider. */
export interface HostedVectorStoreContent extends ContentBase {
  type: 'hosted_vector_store';
  vectorStoreId: string;
}

/**
 * A tool call the provider executed itself; the framework only reports it.
 *
 * One interface covers every hosted kind; each field is populated exactly as the Python factory
 * for that kind does (`from_code_interpreter_tool_call` … `from_shell_tool_call`), so a per-kind
 * doc note marks which fields apply.
 */
export interface HostedToolCallContent extends ContentBase {
  type:
    | 'code_interpreter_tool_call'
    | 'image_generation_tool_call'
    | 'mcp_server_tool_call'
    | 'search_tool_call'
    | 'shell_tool_call';
  /** All kinds except `image_generation_tool_call`, which is keyed by {@link imageId} instead. */
  callId?: string;
  /** `image_generation_tool_call`: correlates the call with its result. */
  imageId?: string;
  /** `mcp_server_tool_call` / `search_tool_call`. */
  toolName?: string;
  /** `mcp_server_tool_call`. */
  serverName?: string;
  /** `mcp_server_tool_call` / `search_tool_call`. */
  arguments?: Record<string, unknown> | string;
  /** `code_interpreter_tool_call`: the code and data the interpreter ran. */
  inputs?: Content[];
  /** `shell_tool_call`: the commands the provider shell ran. */
  commands?: string[];
  /** `shell_tool_call`. */
  timeoutMs?: number;
  /** `shell_tool_call`. */
  maxOutputLength?: number;
  /** `search_tool_call` / `shell_tool_call`: provider-reported status. */
  status?: string;
}

/**
 * The result of a provider-executed tool call.
 *
 * Field population per kind mirrors the matching Python factory — see
 * {@link HostedToolCallContent}.
 */
export interface HostedToolResultContent extends ContentBase {
  type:
    | 'code_interpreter_tool_result'
    | 'image_generation_tool_result'
    | 'mcp_server_tool_result'
    | 'search_tool_result'
    | 'shell_tool_result'
    | 'shell_command_output';
  /** All kinds except `image_generation_tool_result` (keyed by {@link imageId}) and `shell_command_output`. */
  callId?: string;
  /** `image_generation_tool_result`. */
  imageId?: string;
  /** `search_tool_result`. */
  toolName?: string;
  /** Rich outputs: logs, generated images, retrieved documents. */
  outputs?: Content[];
  /** `search_tool_result`: the provider's raw result payload when it is structured rather than content. */
  result?: unknown;
  /** `search_tool_result`: retrieved documents as content items. */
  items?: Content[];
  /**
   * `mcp_server_tool_result`: the MCP call output (Python carries a `Content` list here).
   *
   * Typed `unknown` because providers have also been observed putting a scalar here; the
   * serializer recurses into it only when it is a content item or a list of them.
   */
  output?: unknown;
  /** `search_tool_result`: provider-reported status. */
  status?: string;
  /** `shell_tool_result`. */
  maxOutputLength?: number;
  /** `shell_command_output`. */
  stdout?: string;
  /** `shell_command_output`. */
  stderr?: string;
  /** `shell_command_output`. */
  exitCode?: number;
  /** `shell_command_output`. */
  timedOut?: boolean;
}

/**
 * A provider request for the user to grant OAuth consent before a tool can run.
 * Producers set `userInputRequest: true` (Python parity).
 */
export interface OAuthConsentRequestContent extends ContentBase {
  type: 'oauth_consent_request';
  /** Provider/framework request identity, synthesized from {@link callId} when absent. */
  id?: string;
  /** The enclosing agent-tool call this nested request suspends, when applicable. */
  callId?: string;
  /** The URL the user must visit to complete OAuth consent (Python `consent_link`). */
  consentLink: string;
}

/**
 * Content that suspends the run until a human responds — what
 * `AgentResponse.userInputRequests` surfaces (.NET `UserInputRequestContent`).
 */
export type UserInputRequestContent = FunctionApprovalRequestContent | OAuthConsentRequestContent;

/**
 * A content item whose wire `type` this version of the framework does not know.
 *
 * Deserialization never drops data: the original wire `type` is kept in
 * {@link UnknownContent.unknownType} and every other field is preserved verbatim, so
 * `deserializeMessage(serializeMessage(m))` is lossless even for content produced by a newer
 * provider or a newer framework version.
 *
 * @remarks
 * Modelling this as `type: string & {}` would silently defeat discriminated-union narrowing for
 * the entire {@link Content} union (`switch (c.type)` stops narrowing), so the wire type is
 * carried in a separate field instead.
 */
export interface UnknownContent extends ContentBase {
  type: 'unknown';
  /** The `type` value as it appeared on the wire. */
  unknownType: string;
  [key: string]: unknown;
}

/**
 * Every content variant the framework models.
 *
 * @remarks
 * Fields that hold a nested `Content` or `Content[]` are serialized by recursing through the
 * `NESTED_CONTENT_KEYS` list in `serialization.ts` — see the note there before adding such a
 * field to any variant.
 */
export type Content =
  | TextContent
  | TextReasoningContent
  | DataContent
  | UriContent
  | FunctionCallContent
  | FunctionResultContent
  | ErrorContent
  | UsageContent
  | FunctionApprovalRequestContent
  | FunctionApprovalResponseContent
  | HostedFileContent
  | HostedVectorStoreContent
  | HostedToolCallContent
  | HostedToolResultContent
  | OAuthConsentRequestContent
  | UnknownContent;

/** The `type` discriminant of {@link Content}. Values match the Python wire literals. */
export type ContentType = Content['type'];

// region factories

/** Creates a {@link TextContent}. */
export function textContent(text: string, options?: Omit<TextContent, 'type' | 'text'>): TextContent {
  return { ...options, type: 'text', text };
}

/**
 * Wraps a wire object this version does not model as {@link UnknownContent}.
 *
 * **Provider packages must build unknown content with this.** Every field of `wire` except `type`
 * is copied to the *top level*, which is the only shape {@link serializeContent} turns back into
 * the original object — and `serializeContent` is what a persisted session goes through.
 * `rawRepresentation` is debugging detail, not the round-trip channel: it is dropped on
 * serialization, so an item whose payload lived only there comes back from a session as a bare
 * `{type: '<wire type>'}` with the provider id and every provider-specific field gone.
 *
 * That is not a hypothetical. Three provider packages each invented their own version of this
 * function and **all three got it wrong the same way** — nesting the payload under a key of their
 * own (`data`), which serializes to `{type: '<wire type>', data: {…}}`, an object the provider
 * never sent. Hence one implementation, here, next to the serializer whose contract it exists to
 * satisfy.
 *
 * `unknownType` is `''` when `wire` carries no string `type` — the same sentinel
 * {@link deserializeContent} uses, so a value taken off the wire and one restored from a snapshot
 * are indistinguishable. A non-object `wire` (null, a string, an array) yields an empty unknown
 * rather than throwing: providers pass whatever arrived, and a malformed payload must not take
 * the run down.
 *
 * ```ts
 * // In a provider's parser, for a block/item this build does not model:
 * return unknownContent(block);
 * ```
 */
export function unknownContent(wire: unknown): UnknownContent {
  const record =
    typeof wire === 'object' && wire !== null && !Array.isArray(wire)
      ? (wire as Record<string, unknown>)
      : {};
  const { type, ...rest } = record;
  return {
    ...rest,
    // After the spread, so a wire field of the same name cannot shadow what core owns here.
    type: 'unknown',
    unknownType: typeof type === 'string' ? type : '',
    rawRepresentation: wire,
  };
}

/**
 * Creates a {@link DataContent} from raw bytes or from an existing `data:` URI.
 *
 * @param data - Raw bytes, or a string that is already a `data:` URI.
 * @param mediaType - IANA media type, for example `'image/png'`.
 */
export function dataContent(
  data: Uint8Array | string,
  mediaType: string,
  options?: Omit<DataContent, 'type' | 'uri' | 'mediaType'>,
): DataContent {
  const uri =
    typeof data === 'string'
      ? data.startsWith('data:')
        ? data
        : `data:${mediaType};base64,${data}`
      : `data:${mediaType};base64,${encodeBase64(data)}`;
  return { ...options, type: 'data', uri, mediaType };
}

/**
 * Creates a {@link UriContent}, or a {@link DataContent} when `uri` is a `data:` URI.
 *
 * Matching Python's `Content.from_uri`, a `data:` URI is re-typed as `data` content so that
 * downstream code has a single representation for inline payloads.
 */
export function uriContent(
  uri: string,
  mediaType?: string,
  options?: Omit<UriContent, 'type' | 'uri' | 'mediaType'>,
): UriContent | DataContent {
  if (uri.startsWith('data:')) {
    const resolved = mediaType ?? uri.slice('data:'.length).split(';')[0]?.split(',')[0] ?? '';
    return { ...options, type: 'data', uri, mediaType: resolved };
  }
  return mediaType === undefined
    ? { ...options, type: 'uri', uri }
    : { ...options, type: 'uri', uri, mediaType };
}

// endregion

/** Concatenates the text of every {@link TextContent} in `contents`. */
export function textOfContents(contents: readonly Content[]): string {
  let out = '';
  for (const content of contents) {
    if (content.type === 'text') {
      out += content.text;
    }
  }
  return out;
}
