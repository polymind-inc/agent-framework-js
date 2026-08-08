import type {
  Annotation,
  ChatResponse,
  ChatResponseUpdate,
  ChatResponseUpdateInit,
  Content,
  ErrorContent,
  FinishReason,
  UsageDetails,
} from '@polymind-inc/agent-framework-core';
import {
  chatResponse,
  chatResponseUpdate,
  decodeBase64,
  unknownContent,
} from '@polymind-inc/agent-framework-core';
import type {
  Response,
  ResponseCodeInterpreterToolCall,
  ResponseFileSearchToolCall,
  ResponseFunctionWebSearch,
  ResponseOutputItem,
  ResponseOutputText,
  ResponseReasoningItem,
  ResponseStreamEvent,
  ResponseUsage,
} from 'openai/resources/responses/responses';

/**
 * A wire-shaped view of an SDK type: every declared field optional, undeclared fields reachable
 * as `unknown`.
 *
 * The mapping reads the wire through the SDK's Responses types, but never trusts them to be
 * complete or current — the service can send items and fields a given SDK version does not model,
 * and those must round-trip untouched. `Partial` keeps every read guarded the way the runtime
 * checks already are; the index signature keeps fields outside the SDK type reachable without
 * `any`.
 */
type Wire<T> = Partial<T> & Record<string, unknown>;

/** Context the mapping needs but that is not on the wire object itself. */
export interface ParseContext {
  /** The configured model, used until the response reports the served one. */
  model?: string;
  /**
   * The model the `x-ms-served-model` response header named, when there was one.
   *
   * Azure OpenAI puts the *deployment alias* in `response.model` and the snapshot that actually
   * ran in the header, so this **overrides** the body rather than filling in for it (Python
   * `_extract_served_model`).
   */
  servedModel?: string;
  /** The request's `store` flag; `false` suppresses conversation-id propagation. */
  store?: boolean;
}

/** The model to report: the served snapshot wins, then the body, then the configured model. */
function effectiveModel(
  response: Partial<Response> | null | undefined,
  ctx: ParseContext,
): string | undefined {
  if (ctx.servedModel !== undefined) {
    return ctx.servedModel;
  }
  return typeof response?.model === 'string' ? response.model : ctx.model;
}

/** Mutable state threaded through {@link parseStreamEvent} for one stream. */
export interface StreamParseState {
  /** `output_index` → the call id and name announced by `response.output_item.added`. */
  functionCalls: Map<number, { callId: string; name: string }>;
  /** Reasoning items that already produced a delta, so the `done` event does not duplicate them. */
  seenReasoningDeltas: Set<string>;
}

/** Creates the initial {@link StreamParseState}. */
export function createStreamParseState(): StreamParseState {
  return { functionCalls: new Map(), seenReasoningDeltas: new Set() };
}

function toIsoTimestamp(createdAt: unknown): string | undefined {
  return typeof createdAt === 'number' ? new Date(createdAt * 1000).toISOString() : undefined;
}

/** Maps the Responses API usage object onto {@link UsageDetails}. */
export function parseUsage(usage: unknown): UsageDetails | undefined {
  if (usage === undefined || usage === null) {
    return undefined;
  }
  const raw = usage as Partial<ResponseUsage>;
  const details: UsageDetails = {};
  if (typeof raw.input_tokens === 'number') details.inputTokenCount = raw.input_tokens;
  if (typeof raw.output_tokens === 'number') details.outputTokenCount = raw.output_tokens;
  if (typeof raw.total_tokens === 'number') details.totalTokenCount = raw.total_tokens;

  const cached = raw.input_tokens_details?.cached_tokens;
  if (typeof cached === 'number') {
    details.cacheReadInputTokenCount = cached;
    details['openai.cached_input_tokens'] = cached;
  }
  const cacheWrite = raw.input_tokens_details?.cache_write_tokens;
  if (typeof cacheWrite === 'number') {
    details.cacheCreationInputTokenCount = cacheWrite;
    details['openai.cache_write_tokens'] = cacheWrite;
  }
  const reasoning = raw.output_tokens_details?.reasoning_tokens;
  if (typeof reasoning === 'number') {
    details.reasoningOutputTokenCount = reasoning;
    details['openai.reasoning_tokens'] = reasoning;
  }
  return Object.keys(details).length === 0 ? undefined : details;
}

/**
 * Derives the framework {@link FinishReason} from a terminal Responses API response.
 *
 * Matches Python's `_get_finish_reason_from_openai_response`: an incomplete response reports why
 * it was cut short, a completed response containing function calls reports `tool_calls`, and a
 * response still in flight reports nothing.
 */
export function parseFinishReason(response: unknown): FinishReason | undefined {
  const raw = response as Partial<Response> | null | undefined;
  const incomplete = raw?.incomplete_details?.reason;
  if (incomplete === 'content_filter') return 'content_filter';
  if (incomplete === 'max_output_tokens') return 'length';
  if (raw?.status !== 'completed') return undefined;
  const output = raw.output ?? [];
  return output.some((item) => item?.type === 'function_call') ? 'tool_calls' : 'stop';
}

/** The substitute diagnostic for a failure the wire does not describe. */
const DEFAULT_FAILURE_MESSAGE = 'The agent run failed.';
const DEFAULT_FAILURE_CODE = 'failed';

/**
 * The `error` content a failed response reports, or `undefined` when the response did not fail.
 *
 * The Responses API marks failure with `status: "failed"` and describes it in `response.error`;
 * either signal alone counts, so a failure is surfaced to the caller rather than dropped (.NET's
 * MEAI Responses client and Go `responsesFailureContent` report the same content). When the wire
 * carries no usable message or code, generic substitutes keep the failure from being silent.
 */
function failureContent(response: Partial<Response> | null | undefined, rawEvent: unknown): ErrorContent | undefined {
  const error = response?.error;
  const message = typeof error?.message === 'string' ? error.message : '';
  const code = typeof error?.code === 'string' ? error.code : '';
  if (response?.status !== 'failed' && message === '' && code === '') {
    return undefined;
  }
  return {
    type: 'error',
    message: message.trim() === '' ? DEFAULT_FAILURE_MESSAGE : message,
    errorCode: code === '' ? DEFAULT_FAILURE_CODE : code,
    rawRepresentation: rawEvent,
  };
}

/**
 * The log probabilities the service attached to a piece of output, if any.
 *
 * Port of Python `_get_metadata_from_response`: logprobs are response *metadata*, not transcript
 * content, so they ride `additionalProperties` rather than becoming a {@link Content} item — a
 * per-token score array is not something a downstream model should ever be replayed. They only
 * appear when the request asked for them (`include: ['message.output_text.logprobs']`), which is
 * why the empty case is indistinguishable from "not requested" and adds nothing (Python's
 * `if logprobs := ...` skips a falsy value the same way).
 */
function logprobsOf(source: unknown): Record<string, unknown> | undefined {
  const logprobs = (source as Record<string, unknown> | null | undefined)?.logprobs;
  if (logprobs === undefined || logprobs === null || (Array.isArray(logprobs) && logprobs.length === 0)) {
    return undefined;
  }
  return { logprobs };
}

/** A conversation id is only meaningful when the service stores the response. */
function parseConversationId(
  response: Partial<Response> | null | undefined,
  store: boolean | undefined,
): string | undefined {
  if (store === false) {
    return undefined;
  }
  const conversationId = response?.conversation?.id;
  if (typeof conversationId === 'string' && conversationId !== '') {
    return conversationId;
  }
  return typeof response?.id === 'string' ? response.id : undefined;
}

/** The four citation forms the Responses API attaches to `output_text`. */
type WireAnnotation = Wire<
  | ResponseOutputText.FileCitation
  | ResponseOutputText.URLCitation
  | ResponseOutputText.ContainerFileCitation
  | ResponseOutputText.FilePath
>;

/**
 * Maps Responses API `output_text` annotations onto framework citations.
 *
 * Follows Python `_parse_response_from_openai`: each of the four wire forms keeps the fields the
 * replay side (`toWireAnnotations`) needs to rebuild it — `index` for `file_citation` /
 * `file_path`, `container_id` for `container_file_citation` — in `additionalProperties`.
 * Annotation types the framework does not know are dropped, as Python does.
 */
function parseAnnotations(annotations: readonly unknown[] | undefined): Content['annotations'] {
  if (annotations === undefined || annotations.length === 0) {
    return undefined;
  }
  const mapped: Annotation[] = [];
  for (const candidate of annotations) {
    const annotation = candidate as WireAnnotation | null | undefined;
    const span: Annotation['annotatedRegions'] =
      typeof annotation?.start_index === 'number' && typeof annotation?.end_index === 'number'
        ? [{ type: 'text_span', startIndex: annotation.start_index, endIndex: annotation.end_index }]
        : undefined;
    switch (annotation?.type) {
      case 'file_path': {
        const entry: Annotation = {
          type: 'citation',
          rawRepresentation: annotation,
          additionalProperties: { index: annotation.index ?? null },
        };
        if (typeof annotation.file_id === 'string') entry.fileId = annotation.file_id;
        mapped.push(entry);
        break;
      }
      case 'file_citation': {
        const entry: Annotation = {
          type: 'citation',
          rawRepresentation: annotation,
          additionalProperties: { index: annotation.index ?? null },
        };
        if (typeof annotation.filename === 'string') entry.url = annotation.filename;
        if (typeof annotation.file_id === 'string') entry.fileId = annotation.file_id;
        mapped.push(entry);
        break;
      }
      case 'url_citation': {
        const entry: Annotation = { type: 'citation', rawRepresentation: annotation };
        if (typeof annotation.title === 'string') entry.title = annotation.title;
        if (typeof annotation.url === 'string') entry.url = annotation.url;
        if (span !== undefined) entry.annotatedRegions = span;
        mapped.push(entry);
        break;
      }
      case 'container_file_citation': {
        const entry: Annotation = {
          type: 'citation',
          rawRepresentation: annotation,
          additionalProperties: { container_id: annotation.container_id ?? null },
        };
        if (typeof annotation.file_id === 'string') entry.fileId = annotation.file_id;
        if (typeof annotation.filename === 'string') entry.url = annotation.filename;
        if (span !== undefined) entry.annotatedRegions = span;
        mapped.push(entry);
        break;
      }
      default:
        // Unknown annotation forms have no replayable framework shape (Python debug-logs and
        // drops them the same way).
        break;
    }
  }
  return mapped.length === 0 ? undefined : mapped;
}

/**
 * Detects the media type of base64 data from its magic bytes.
 *
 * Port of Python `detect_media_type_from_base64`: only the leading bytes are inspected, so
 * decoding a short prefix of the base64 string is equivalent to decoding the whole payload.
 * Returns `undefined` when the signature is not recognised.
 */
function detectMediaTypeFromBase64(data: string): string | undefined {
  // 24 base64 characters decode to 18 bytes; the longest signature ends at byte 12.
  const bytes = decodeBase64(data.slice(0, 24));
  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...bytes.slice(offset, offset + length));
  const startsWithBytes = (...signature: number[]): boolean =>
    signature.every((byte, i) => bytes[i] === byte);

  if (startsWithBytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (startsWithBytes(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && bytes.length > 11 && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(0, 2) === 'BM') return 'image/bmp';
  if (ascii(0, 4) === '<svg' || ascii(0, 5) === '<?xml') return 'image/svg+xml';
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(0, 4) === 'RIFF' && bytes.length > 11 && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(0, 3) === 'ID3' || startsWithBytes(0xff, 0xfb) || startsWithBytes(0xff, 0xf3)) {
    return 'audio/mpeg';
  }
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  return undefined;
}

/**
 * Converts the output items of a reasoning entry into `text_reasoning` contents.
 *
 * Private reasoning (`content`) and its public summary (`summary`) stay separate items — merging
 * them would replay the summary as the model's private text — but the
 * private fragment also records the summary sitting at the same index in `additionalProperties`,
 * which is the only place that pairing survives once the wire item is gone. Nothing in the
 * framework reads it back (`prepareReasoningItems` rebuilds `summary` from the summary items
 * themselves, as Python's `_prepare_reasoning_items_for_openai` does); it is informational
 * metadata that Python attaches on both the awaited and the streamed path, so dropping it here
 * would make a streamed transcript carry more than an awaited one.
 */
function reasoningContents(item: Wire<ResponseReasoningItem>): Content[] {
  const encrypted = typeof item.encrypted_content === 'string' ? item.encrypted_content : undefined;
  const contents: Content[] = [];
  const push = (text: string, raw: unknown, props: Record<string, unknown> | undefined): void => {
    const content: Content = { type: 'text_reasoning', text, rawRepresentation: raw };
    if (typeof item.id === 'string') content.id = item.id;
    // Only the first fragment carries the opaque payload; replaying it once is enough.
    if (encrypted !== undefined && contents.length === 0) content.protectedData = encrypted;
    if (props !== undefined) content.additionalProperties = props;
    contents.push(content);
  };

  const summaries: readonly unknown[] = item.summary ?? [];
  const entries: readonly unknown[] = item.content ?? [];
  entries.forEach((entry, index) => {
    const props: Record<string, unknown> = { reasoning_text: true };
    if (index < summaries.length) props.summary = summaries[index];
    const record = entry as Wire<ResponseReasoningItem.Content> | null | undefined;
    push(typeof record?.text === 'string' ? record.text : '', entry, props);
  });
  for (const summary of summaries) {
    const record = summary as Wire<ResponseReasoningItem.Summary> | null | undefined;
    push(typeof record?.text === 'string' ? record.text : '', summary, undefined);
  }
  if (contents.length === 0) {
    // An encrypted-only reasoning item still has to be preserved for stateless replay.
    push('', item, undefined);
  }
  return contents;
}

/** Output items produced by provider-run tools, which only exist once the item is done. */
const HOSTED_ITEM_TYPES: ReadonlySet<string> = new Set([
  'web_search_call',
  'file_search_call',
  'code_interpreter_call',
  'mcp_call',
  'mcp_approval_request',
  'image_generation_call',
]);

/**
 * Item types the streaming path reconstructs from their own delta events.
 *
 * Everything else that reaches `response.output_item.done` has no streamed representation, so it
 * is preserved there as `unknown` content — otherwise a streamed run would silently drop what an
 * awaited run keeps, breaking the "streamed = awaited transcript" invariant.
 */
const STREAMED_ITEM_TYPES: ReadonlySet<string> = new Set(['message', 'function_call', 'reasoning']);

/** `web_search_call` and `file_search_call` share one framework content type. */
function searchToolName(itemType: string | undefined): string {
  return itemType === 'web_search_call' ? 'web_search' : 'file_search';
}

/** Both halves of a provider-run search: what was asked, and what came back. */
function searchContents(item: Wire<ResponseFunctionWebSearch> | Wire<ResponseFileSearchToolCall>): Content[] {
  // `call_id` is not declared on the SDK's search-call items; the fallback keeps whatever the
  // wire carried, since the framework has no other correlation key to offer.
  const callId = (item.id ?? item.call_id ?? '') as string;
  const toolName = searchToolName(item.type);
  const isWeb = item.type === 'web_search_call';
  const action: unknown = item.action;
  const status = item.status;
  return [
    {
      type: 'search_tool_call',
      callId,
      toolName,
      arguments: isWeb ? (action as Record<string, unknown>) : { queries: item.queries ?? [] },
      ...(status === undefined ? {} : { additionalProperties: { status } }),
      rawRepresentation: item,
    },
    {
      type: 'search_tool_result',
      callId,
      toolName,
      result: isWeb ? { action } : { results: item.results },
      ...(status === undefined ? {} : { additionalProperties: { status } }),
      rawRepresentation: item,
    },
  ];
}

/** The sandbox's stdout and any images it produced. */
function codeInterpreterOutputs(item: Wire<ResponseCodeInterpreterToolCall>): Content[] {
  const outputs: Content[] = [];
  for (const output of item.outputs ?? []) {
    if (output?.type === 'logs') {
      outputs.push({ type: 'text', text: output.logs ?? '', rawRepresentation: output });
    } else if (output?.type === 'image' && typeof output.url === 'string') {
      outputs.push({ type: 'uri', uri: output.url, mediaType: 'image', rawRepresentation: output });
    }
  }
  return outputs;
}

/** Converts one Responses API output item into framework contents. */
function outputItemToContents(item: unknown): Content[] {
  const raw = item as Wire<ResponseOutputItem> | null | undefined;
  switch (raw?.type) {
    case 'message': {
      const contents: Content[] = [];
      for (const part of raw.content ?? []) {
        if (part?.type === 'output_text') {
          const content: Content = { type: 'text', text: part.text ?? '', rawRepresentation: part };
          const annotations = parseAnnotations(part.annotations);
          if (annotations !== undefined) content.annotations = annotations;
          contents.push(content);
        } else if (part?.type === 'refusal') {
          contents.push({ type: 'text', text: part.refusal ?? '', rawRepresentation: part });
        }
      }
      return contents;
    }
    case 'reasoning':
      return reasoningContents(raw);
    case 'function_call':
      return [
        {
          type: 'function_call',
          callId: raw.call_id ?? raw.id ?? '',
          name: raw.name ?? '',
          arguments: raw.arguments ?? '',
          additionalProperties: { fc_id: raw.id, status: raw.status },
          rawRepresentation: raw,
        },
      ];

    case 'web_search_call':
    case 'file_search_call':
      return searchContents(raw);

    case 'code_interpreter_call': {
      // `call_id` is not declared on the SDK item; keep the wire's value when it carries one.
      const callId = (raw.call_id ?? raw.id ?? '') as string;
      const contents: Content[] = [];
      if (typeof raw.code === 'string' && raw.code !== '') {
        contents.push({
          type: 'code_interpreter_tool_call',
          callId,
          inputs: [{ type: 'text', text: raw.code, rawRepresentation: raw }],
          rawRepresentation: raw,
        });
      }
      contents.push({
        type: 'code_interpreter_tool_result',
        callId,
        outputs: codeInterpreterOutputs(raw),
        rawRepresentation: raw,
      });
      return contents;
    }

    case 'mcp_call': {
      // `call_id` is not declared on the SDK item; keep the wire's value when it carries one.
      const callId = (raw.id ?? raw.call_id ?? '') as string;
      const contents: Content[] = [
        {
          type: 'mcp_server_tool_call',
          callId,
          toolName: raw.name ?? '',
          serverName: raw.server_label ?? '',
          arguments: raw.arguments ?? '',
          rawRepresentation: raw,
        },
      ];
      if (raw.output !== undefined && raw.output !== null) {
        // Python: `from_mcp_server_tool_result(output=[Content.from_text(item.output)])` — the
        // payload lives in `output` as a content list, not in `outputs`.
        contents.push({
          type: 'mcp_server_tool_result',
          callId,
          output: [{ type: 'text', text: String(raw.output), rawRepresentation: raw }],
          rawRepresentation: raw,
        });
      }
      return contents;
    }

    case 'mcp_approval_request':
      // A hosted MCP server asking for a human. `server_label` is what tells the approval layer
      // this call belongs to the provider rather than to a local tool.
      return [
        {
          type: 'function_approval_request',
          id: raw.id ?? '',
          userInputRequest: true,
          functionCall: {
            type: 'function_call',
            callId: raw.id ?? '',
            name: raw.name ?? '',
            arguments: raw.arguments ?? '',
            additionalProperties: { server_label: raw.server_label },
            rawRepresentation: raw,
          },
          rawRepresentation: raw,
        },
      ];

    case 'image_generation_call': {
      const imageId = raw.id ?? '';
      // Python keys image generation items by `image_id`; there is no call_id on this kind.
      const contents: Content[] = [{ type: 'image_generation_tool_call', imageId, rawRepresentation: raw }];
      // The API returns bare base64 without a media type; detect it from the magic bytes and
      // fall back to png (Python `detect_media_type_from_base64(...) or "image/png"`).
      const mediaType =
        typeof raw.result === 'string' && raw.result !== ''
          ? (detectMediaTypeFromBase64(raw.result) ?? 'image/png')
          : 'image/png';
      const outputs: Content[] =
        typeof raw.result === 'string' && raw.result !== ''
          ? [
              {
                type: 'data',
                uri: `data:${mediaType};base64,${raw.result}`,
                mediaType,
                rawRepresentation: raw,
              },
            ]
          : [];
      contents.push({
        type: 'image_generation_tool_result',
        imageId,
        outputs,
        rawRepresentation: raw,
      });
      return contents;
    }

    default:
      // Item types this package does not model are preserved verbatim so nothing is lost on a
      // serialization round-trip. Both the awaited path (`parseResponse`) and the
      // streamed one (`response.output_item.done`) reach this through `outputItemToContents`.
      return [unknownContent(item)];
  }
}

/** Converts a completed Responses API response into a {@link ChatResponse}. */
export function parseResponse(response: unknown, ctx: ParseContext = {}): ChatResponse<undefined> {
  const raw = response as Wire<Response> | null | undefined;
  const contents: Content[] = [];
  // Python seeds the response metadata with `response.metadata` and merges each output part's
  // logprobs on top, so the last scored part wins (`_parse_response_from_openai`).
  const metadata: Record<string, unknown> = {};
  let hasMetadata = false;
  if (raw?.metadata !== undefined && raw.metadata !== null) {
    Object.assign(metadata, raw.metadata as Record<string, unknown>);
    hasMetadata = true;
  }
  for (const item of raw?.output ?? []) {
    contents.push(...outputItemToContents(item));
    if (item?.type !== 'message') {
      continue;
    }
    for (const part of item.content ?? []) {
      const logprobs = part?.type === 'output_text' ? logprobsOf(part) : undefined;
      if (logprobs !== undefined) {
        Object.assign(metadata, logprobs);
        hasMetadata = true;
      }
    }
  }
  const failure = failureContent(raw, response);
  if (failure !== undefined) {
    contents.push(failure);
  }

  const init: Parameters<typeof chatResponse<undefined>>[0] = {
    messages: [{ role: 'assistant', contents }],
    rawRepresentation: response,
  };
  if (typeof raw?.id === 'string') init.responseId = raw.id;
  const createdAt = toIsoTimestamp(raw?.created_at);
  if (createdAt !== undefined) init.createdAt = createdAt;
  const model = effectiveModel(raw, ctx);
  if (model !== undefined) init.model = model;
  const conversationId = parseConversationId(raw, ctx.store);
  if (conversationId !== undefined) init.conversationId = conversationId;
  const usage = parseUsage(raw?.usage);
  if (usage !== undefined) init.usageDetails = usage;
  const finishReason = parseFinishReason(raw);
  if (finishReason !== undefined) init.finishReason = finishReason;
  if (raw?.status === 'in_progress' || raw?.status === 'queued') {
    init.continuationToken = { responseId: raw.id };
  }
  if (hasMetadata) {
    init.additionalProperties = metadata;
  }
  return chatResponse<undefined>(init);
}

/**
 * Converts one Responses API stream event into a {@link ChatResponseUpdate}.
 *
 * Returns `undefined` for events that carry no framework-visible information (progress markers,
 * `*.done` echoes of content already streamed), so callers can skip them.
 */
export function parseStreamEvent(
  event: unknown,
  state: StreamParseState,
  ctx: ParseContext = {},
): ChatResponseUpdate | undefined {
  const raw = event as Wire<ResponseStreamEvent> | null | undefined;
  const contents: Content[] = [];
  const init: ChatResponseUpdateInit = { contents, role: 'assistant', rawRepresentation: event };
  // Every update reports a model, not just the terminal one: Python seeds each chunk with the
  // configured model (`_parse_chunk_from_openai`: `model = self.model`) and lets `response.
  // completed`/`incomplete`/`failed` overwrite it with what the response reports. The fold takes
  // the *later* value (`orLater` in core `response.ts`), so the served snapshot still wins the
  // merged response — the seed only fills in the updates that arrive before it. Nothing is
  // reported when the endpoint is the one naming the model.
  const contextModel = effectiveModel(undefined, ctx);
  if (contextModel !== undefined) init.model = contextModel;

  switch (raw?.type) {
    case 'response.content_part.added': {
      // The part's initial text is usually empty, but Python emits whatever it carries so a
      // pre-filled part is not lost; deltas then stream the rest.
      const part = raw.part;
      if (part?.type === 'output_text') {
        contents.push({ type: 'text', text: part.text ?? '', rawRepresentation: event });
      } else if (part?.type === 'refusal') {
        contents.push({ type: 'text', text: part.refusal ?? '', rawRepresentation: event });
      } else {
        return undefined;
      }
      break;
    }

    case 'response.output_text.delta':
      contents.push({ type: 'text', text: raw.delta ?? '', rawRepresentation: event });
      break;

    case 'response.refusal.delta':
      contents.push({ type: 'text', text: raw.delta ?? '', rawRepresentation: event });
      break;

    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary_text.delta': {
      if (typeof raw.item_id === 'string') {
        state.seenReasoningDeltas.add(raw.item_id);
      }
      const content: Content = { type: 'text_reasoning', text: raw.delta ?? '', rawRepresentation: event };
      if (typeof raw.item_id === 'string') content.id = raw.item_id;
      if (raw.type === 'response.reasoning_text.delta') {
        content.additionalProperties = { reasoning_text: true };
      }
      contents.push(content);
      break;
    }

    case 'response.reasoning_text.done':
    case 'response.reasoning_summary_text.done': {
      // The done event repeats the whole text; emit it only when no delta was seen, otherwise the
      // fold would duplicate it.
      if (typeof raw.item_id === 'string' && state.seenReasoningDeltas.has(raw.item_id)) {
        return undefined;
      }
      const content: Content = { type: 'text_reasoning', text: raw.text ?? '', rawRepresentation: event };
      if (typeof raw.item_id === 'string') content.id = raw.item_id;
      if (raw.type === 'response.reasoning_text.done') {
        content.additionalProperties = { reasoning_text: true };
      }
      contents.push(content);
      break;
    }

    case 'response.output_text.annotation.added': {
      // Without this a streamed answer loses the citations the same answer
      // carries when awaited. The annotation rides an empty text content so the fold attaches it
      // to the surrounding text run (Python's `annotation.added` handling).
      const annotations = parseAnnotations([raw.annotation]);
      if (annotations === undefined) {
        return undefined;
      }
      contents.push({ type: 'text', text: '', annotations, rawRepresentation: event });
      break;
    }

    case 'response.output_item.added': {
      if (raw.item?.type === 'function_call') {
        // `output_index` is required by the SDK's event type; the cast keeps the map keyed by
        // whatever the wire carried, exactly as the matching delta lookup below reads it.
        state.functionCalls.set(raw.output_index as number, {
          callId: raw.item.call_id ?? raw.item.id ?? '',
          name: raw.item.name ?? '',
        });
        return undefined;
      }
      if (raw.item?.type === 'reasoning') {
        // A reasoning item always leaves a marker in the transcript, even when it never produces
        // visible text, so a streamed run matches the awaited one and downstream co-occurrence
        // checks (reasoning next to tool calls) see the item (Python `output_item.added`).
        const item = raw.item;
        const id = typeof item.id === 'string' && item.id !== '' ? item.id : undefined;
        const encrypted = typeof item.encrypted_content === 'string' ? item.encrypted_content : undefined;
        const entries: readonly unknown[] = item.content ?? [];
        let added = false;
        entries.forEach((entry, index) => {
          const props: Record<string, unknown> = { reasoning_text: true };
          if (Array.isArray(item.summary) && index < item.summary.length) {
            props.summary = item.summary[index];
          }
          const record = entry as Wire<ResponseReasoningItem.Content> | null | undefined;
          const content: Content = {
            type: 'text_reasoning',
            text: typeof record?.text === 'string' ? record.text : '',
            rawRepresentation: entry,
            additionalProperties: props,
          };
          if (id !== undefined) content.id = id;
          if (encrypted !== undefined) content.protectedData = encrypted;
          contents.push(content);
          added = true;
        });
        if (!added) {
          const content: Content = { type: 'text_reasoning', text: '', rawRepresentation: item };
          if (id !== undefined) content.id = id;
          if (encrypted !== undefined) content.protectedData = encrypted;
          contents.push(content);
        }
        break;
      }
      return undefined;
    }

    case 'response.function_call_arguments.delta': {
      const call = state.functionCalls.get(raw.output_index as number);
      if (call === undefined) {
        return undefined;
      }
      contents.push({
        type: 'function_call',
        callId: call.callId,
        name: call.name,
        arguments: raw.delta ?? '',
        additionalProperties: { output_index: raw.output_index, fc_id: raw.item_id },
        rawRepresentation: event,
      });
      break;
    }

    case 'response.image_generation_call.partial_image': {
      // A progressive frame of an image the provider is still drawing. It reaches the transcript
      // as the same call/result pair the finished `image_generation_call` item produces (Python
      // `_parse_chunk_from_openai`), with the preview flagged so a consumer can tell a refinement
      // from the final image — the last partial *is* the finished image, so an unmarked preview
      // would be indistinguishable from it. Each frame costs a full base64 image, but the event
      // only exists when the caller asked for it (`partial_images` on the image generation tool),
      // so a caller who did not opt in sees the awaited transcript unchanged.
      const data = typeof raw.partial_image_b64 === 'string' ? raw.partial_image_b64 : '';
      const mediaType = (data === '' ? undefined : detectMediaTypeFromBase64(data)) ?? 'image/png';
      const imageId = typeof raw.item_id === 'string' ? raw.item_id : '';
      contents.push({ type: 'image_generation_tool_call', imageId, rawRepresentation: event });
      contents.push({
        type: 'image_generation_tool_result',
        imageId,
        outputs: [
          {
            type: 'data',
            uri: `data:${mediaType};base64,${data}`,
            mediaType,
            additionalProperties: {
              partial_image_index: raw.partial_image_index,
              is_partial_image: true,
            },
            rawRepresentation: event,
          },
        ],
        rawRepresentation: event,
      });
      break;
    }

    case 'response.output_item.done': {
      // Reasoning payloads only appear on the completed item, and they are required to replay the
      // turn statelessly, so they are surfaced here rather than dropped.
      if (raw.item?.type === 'reasoning' && typeof raw.item.encrypted_content === 'string') {
        const content: Content = { type: 'text_reasoning', text: '', rawRepresentation: raw.item };
        if (typeof raw.item.id === 'string') content.id = raw.item.id;
        content.protectedData = raw.item.encrypted_content;
        contents.push(content);
        break;
      }
      // Provider-run tools report nothing while they work: the finished item is the only place
      // their call and result exist, so a streamed run reconstructs them from here.
      if (HOSTED_ITEM_TYPES.has(raw.item?.type as string)) {
        contents.push(...outputItemToContents(raw.item));
        break;
      }
      // An item type this package does not model, and that produced no delta events, only exists
      // here. The awaited path keeps it as `unknown` content, so the streamed path must too
      // (Python drops it on both paths; the TS invariant is the one that holds here).
      if (typeof raw.item?.type === 'string' && !STREAMED_ITEM_TYPES.has(raw.item.type)) {
        contents.push(...outputItemToContents(raw.item));
        break;
      }
      return undefined;
    }

    case 'response.created':
    case 'response.in_progress': {
      if (typeof raw.response?.id === 'string') init.responseId = raw.response.id;
      const conversationId = parseConversationId(raw.response, ctx.store);
      if (conversationId !== undefined) init.conversationId = conversationId;
      // A background response can outlive the connection, so the token is offered as soon as the
      // id exists. `response.completed` carries no token, which is what clears it on fold-up
      // (Python `_parse_chunk_from_openai`).
      const status = raw.response?.status;
      if (
        typeof raw.response?.id === 'string' &&
        (raw.type === 'response.in_progress' || status === 'in_progress' || status === 'queued')
      ) {
        init.continuationToken = { responseId: raw.response.id };
      }
      break;
    }

    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed': {
      const response = raw.response;
      if (typeof response?.id === 'string') init.responseId = response.id;
      const conversationId = parseConversationId(response, ctx.store);
      if (conversationId !== undefined) init.conversationId = conversationId;
      const model = effectiveModel(response, ctx);
      if (model !== undefined) init.model = model;
      const createdAt = toIsoTimestamp(response?.created_at);
      if (createdAt !== undefined) init.createdAt = createdAt;
      const finishReason = parseFinishReason(response);
      if (finishReason !== undefined) init.finishReason = finishReason;
      const usage = parseUsage(response?.usage);
      if (usage !== undefined) {
        contents.push({ type: 'usage', usageDetails: usage, rawRepresentation: event });
      }
      if (raw.type === 'response.failed') {
        const failure = failureContent(response, event);
        if (failure !== undefined) {
          contents.push(failure);
        }
      }
      break;
    }

    default:
      return undefined;
  }

  // Python calls `_get_metadata_from_response` on every event kind it maps, reading the part on
  // `content_part.added` and the event itself elsewhere; in practice only `output_text` carries
  // the field, so the single call here covers the same ground.
  const metadata = logprobsOf(raw.type === 'response.content_part.added' ? raw.part : event);
  if (metadata !== undefined) init.additionalProperties = metadata;

  return chatResponseUpdate(init);
}
