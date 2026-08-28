import type {
  Annotation,
  ChatResponse,
  ChatResponseUpdate,
  Content,
  FinishReason,
  UsageDetails,
} from '@polymind-inc/agent-framework-core';
import { chatResponse, chatResponseUpdate, unknownContent } from '@polymind-inc/agent-framework-core';
import type { AnthropicBlock } from './to-anthropic.js';

/**
 * Stop-reason mapping, matching Python `FINISH_REASON_MAP`.
 *
 * `refusal` maps to `content_filter`: the model answered, it just declined, so it is a finish
 * reason rather than a failed request.
 */
const FINISH_REASONS: Record<string, FinishReason> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  pause_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

/** Maps a Messages API `stop_reason`. Unknown values pass through unchanged. */
function parseFinishReason(stopReason: unknown): FinishReason | undefined {
  if (typeof stopReason !== 'string' || stopReason === '') {
    return undefined;
  }
  return FINISH_REASONS[stopReason] ?? stopReason;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Maps the citation metadata attached to a complete Anthropic text block. */
function parseCitations(block: AnthropicBlock): Annotation[] | undefined {
  if (!Array.isArray(block.citations) || block.citations.length === 0) {
    return undefined;
  }
  const annotations: Annotation[] = [];
  for (const candidate of block.citations) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const citation = candidate as AnthropicBlock;
    const annotation: Annotation = {
      type: 'citation',
      rawRepresentation: candidate,
    };
    const snippet = typeof citation.cited_text === 'string' ? citation.cited_text : undefined;
    if (snippet !== undefined) annotation.snippet = snippet;
    if (typeof citation.file_id === 'string' && citation.file_id !== '') annotation.fileId = citation.file_id;

    let start: number | undefined;
    let end: number | undefined;
    switch (citation.type) {
      case 'char_location':
        if (typeof citation.title === 'string') annotation.title = citation.title;
        start = asNumber(citation.start_char_index);
        end = asNumber(citation.end_char_index);
        break;
      case 'page_location':
        if (typeof citation.document_title === 'string') annotation.title = citation.document_title;
        start = asNumber(citation.start_page_number);
        end = asNumber(citation.end_page_number);
        break;
      case 'content_block_location':
        if (typeof citation.document_title === 'string') annotation.title = citation.document_title;
        start = asNumber(citation.start_block_index);
        end = asNumber(citation.end_block_index);
        break;
      case 'web_search_result_location':
      case 'web_fetch_result_location':
        if (typeof citation.title === 'string') annotation.title = citation.title;
        if (typeof citation.url === 'string') annotation.url = citation.url;
        break;
      case 'search_result_location':
        if (typeof citation.title === 'string') annotation.title = citation.title;
        if (typeof citation.source === 'string') annotation.url = citation.source;
        start = asNumber(citation.start_block_index);
        end = asNumber(citation.end_block_index);
        break;
    }
    if (start !== undefined || end !== undefined) {
      annotation.annotatedRegions = [
        {
          type: 'text_span',
          ...(start === undefined ? {} : { startIndex: start }),
          ...(end === undefined ? {} : { endIndex: end }),
        },
      ];
    }
    annotations.push(annotation);
  }
  return annotations.length === 0 ? undefined : annotations;
}

/**
 * Maps a Messages API `usage` object.
 *
 * Anthropic's cache counters are reported under the framework's own names rather than duplicated
 * behind an `anthropic.` prefix as Python does for backwards compatibility.
 */
function parseUsage(usage: unknown): UsageDetails | undefined {
  if (typeof usage !== 'object' || usage === null) {
    return undefined;
  }
  const raw = usage as Record<string, unknown>;
  const details: UsageDetails = {};
  const input = asNumber(raw.input_tokens);
  const output = asNumber(raw.output_tokens);
  const cacheCreation = asNumber(raw.cache_creation_input_tokens);
  const cacheRead = asNumber(raw.cache_read_input_tokens);
  if (input !== undefined) details.inputTokenCount = input;
  if (output !== undefined) details.outputTokenCount = output;
  if (cacheCreation !== undefined) details.cacheCreationInputTokenCount = cacheCreation;
  if (cacheRead !== undefined) details.cacheReadInputTokenCount = cacheRead;
  return Object.keys(details).length === 0 ? undefined : details;
}

/**
 * The `arguments` a tool-call block opens with.
 *
 * While streaming, `content_block_start` carries `input: {}` as a placeholder and the real
 * arguments arrive as `input_json_delta` fragments. The framework's coalescer only concatenates
 * string fragments into a run that *starts* with a string, so an empty placeholder object would
 * swallow every fragment that follows it — the call would reach the tool loop with no arguments.
 */
function openingArguments(
  input: unknown,
  state: StreamParseState | undefined,
): Record<string, unknown> | string {
  if (typeof input === 'object' && input !== null && Object.keys(input).length > 0) {
    return input as Record<string, unknown>;
  }
  return state === undefined ? {} : '';
}

/** Streaming state threaded across the events of one response. */
export interface StreamParseState {
  /** The call a following `input_json_delta` belongs to. */
  currentCall?: { callId: string; blockType: string };
  /** The cumulative usage already emitted, so snapshots can be turned into increments. */
  emittedUsage: Record<string, number>;
}

/** Creates the state {@link parseStreamEvent} threads across one response. */
export function createStreamParseState(): StreamParseState {
  return { emittedUsage: {} };
}

/**
 * Turns a cumulative usage snapshot into the increment since the last one.
 *
 * Anthropic streams cumulative usage — `message_start` seeds it and every `message_delta` reports
 * the running total — while the framework *sums* every `usage` content item when folding. Emitting
 * the raw snapshots would therefore count the earlier ones twice (Python `_incremental_usage`).
 */
function incrementalUsage(cumulative: UsageDetails, emitted: Record<string, number>): UsageDetails {
  const delta: UsageDetails = {};
  for (const [key, value] of Object.entries(cumulative)) {
    if (typeof value !== 'number') {
      continue;
    }
    const previous = emitted[key] ?? 0;
    delta[key] = value - previous;
    emitted[key] = value;
  }
  return delta;
}

function usageContent(usage: unknown, emitted: Record<string, number>): Content | undefined {
  const details = parseUsage(usage);
  if (details === undefined) {
    return undefined;
  }
  return {
    type: 'usage',
    usageDetails: incrementalUsage(details, emitted),
    rawRepresentation: usage,
  };
}

/** Fields a complete message and a streamed `message_start` read identically. */
interface ParsedMessageFields {
  raw: AnthropicBlock;
  contents: Content[];
  responseId?: string;
  model?: string;
  finishReason?: FinishReason;
}

/**
 * Reads the stable fields of a Messages API message.
 *
 * Usage deliberately stays with the callers: a complete response reports one snapshot directly,
 * while a stream must turn cumulative snapshots into increments before the framework folds them.
 */
function parseMessageFields(message: unknown, state?: StreamParseState): ParsedMessageFields {
  const raw = (typeof message === 'object' && message !== null ? message : {}) as AnthropicBlock;
  const fields: ParsedMessageFields = {
    raw,
    contents: parseContentBlocks(Array.isArray(raw.content) ? raw.content : [], state),
  };
  if (typeof raw.id === 'string') fields.responseId = raw.id;
  if (typeof raw.model === 'string') fields.model = raw.model;
  const finishReason = parseFinishReason(raw.stop_reason);
  if (finishReason !== undefined) fields.finishReason = finishReason;
  return fields;
}

/**
 * Converts Messages API content blocks into framework content.
 *
 * Handles both whole blocks (non-streaming, `content_block_start`) and deltas
 * (`content_block_delta`), because the two share their discriminator space and produce the same
 * content types — which is what keeps a streamed transcript identical to an awaited one.
 */
export function parseContentBlocks(blocks: readonly unknown[], state?: StreamParseState): Content[] {
  const contents: Content[] = [];
  for (const candidate of blocks) {
    if (typeof candidate !== 'object' || candidate === null) {
      continue;
    }
    const block = candidate as AnthropicBlock;
    switch (block.type) {
      case 'text':
      case 'text_delta': {
        const annotations = block.type === 'text' ? parseCitations(block) : undefined;
        contents.push({
          type: 'text',
          text: String(block.text ?? ''),
          ...(annotations === undefined ? {} : { annotations }),
          rawRepresentation: block,
        });
        break;
      }
      case 'thinking':
      case 'thinking_delta': {
        const signature = block.signature;
        contents.push({
          type: 'text_reasoning',
          text: String(block.thinking ?? ''),
          ...(typeof signature === 'string' ? { protectedData: signature } : {}),
          rawRepresentation: block,
        });
        break;
      }
      case 'signature_delta': {
        contents.push({
          type: 'text_reasoning',
          protectedData: String(block.signature ?? ''),
          rawRepresentation: block,
        });
        break;
      }
      case 'redacted_thinking': {
        // The encrypted payload must go back as its own `redacted_thinking` block — it is *not* a
        // signature for a neighbouring thinking block, so modelling it as a text-less
        // `text_reasoning` would corrupt the replay. The unknown-content round trip carries the
        // block verbatim instead (Python drops these; preserving them is deliberately better).
        contents.push(unknownContent(block));
        break;
      }
      case 'tool_use':
      case 'server_tool_use': {
        const callId = String(block.id ?? '');
        if (state !== undefined) {
          state.currentCall = { callId, blockType: String(block.type) };
        }
        contents.push({
          type: 'function_call',
          callId,
          name: String(block.name ?? ''),
          arguments: openingArguments(block.input, state),
          // A server tool ran on Anthropic's side; executing it locally would run it twice.
          ...(block.type === 'server_tool_use' ? { informationalOnly: true } : {}),
          rawRepresentation: block,
        });
        break;
      }
      case 'input_json_delta': {
        // Argument fragments belong to the call `content_block_start` announced. Server-side calls
        // are never executed here, so their fragments are noise.
        const call = state?.currentCall;
        if (call === undefined || call.blockType !== 'tool_use') {
          break;
        }
        contents.push({
          type: 'function_call',
          callId: call.callId,
          name: '',
          arguments: String(block.partial_json ?? ''),
          rawRepresentation: block,
        });
        break;
      }
      case 'mcp_tool_use': {
        const callId = String(block.id ?? '');
        if (state !== undefined) {
          state.currentCall = { callId, blockType: 'mcp_tool_use' };
        }
        contents.push({
          type: 'mcp_server_tool_call',
          callId,
          toolName: String(block.name ?? ''),
          serverName: String(block.server_name ?? ''),
          arguments: openingArguments(block.input, state),
          rawRepresentation: block,
        });
        break;
      }
      case 'mcp_tool_result': {
        const output = block.content;
        contents.push({
          type: 'mcp_server_tool_result',
          callId: String(block.tool_use_id ?? ''),
          output: Array.isArray(output)
            ? parseContentBlocks(output)
            : output === undefined || output === null
              ? []
              : [{ type: 'text', text: String(output) } satisfies Content],
          rawRepresentation: block,
        });
        break;
      }
      case 'web_search_tool_result':
      case 'web_fetch_tool_result': {
        // The provider ran the search and reported the result; it answers a `server_tool_use`.
        contents.push({
          type: 'function_result',
          callId: String(block.tool_use_id ?? ''),
          result: block.content,
          rawRepresentation: block,
        });
        break;
      }
      default: {
        contents.push(unknownContent(block));
        break;
      }
    }
  }
  return contents;
}

/**
 * The `responseId` / `model` / `finishReason` init entries `fields` carries, each omitted rather
 * than set to `undefined` when the wire did not report it.
 */
function envelopeInit(fields: ParsedMessageFields): {
  responseId?: string;
  model?: string;
  finishReason?: FinishReason;
} {
  return {
    ...(fields.responseId === undefined ? {} : { responseId: fields.responseId }),
    ...(fields.model === undefined ? {} : { model: fields.model }),
    ...(fields.finishReason === undefined ? {} : { finishReason: fields.finishReason }),
  };
}

/** Converts a complete Messages API response. */
export function parseMessage(message: unknown): ChatResponse<undefined> {
  const fields = parseMessageFields(message);
  const usage = parseUsage(fields.raw.usage);
  return chatResponse<undefined>({
    messages: [{ role: 'assistant', contents: fields.contents, rawRepresentation: message }],
    ...envelopeInit(fields),
    ...(usage === undefined ? {} : { usageDetails: usage }),
    rawRepresentation: message,
  });
}

/**
 * Converts one streaming event, or `undefined` for the events that carry nothing.
 *
 * `message_stop` and `content_block_stop` are pure framing: the framework's fold already knows
 * where a message ends.
 */
export function parseStreamEvent(event: unknown, state: StreamParseState): ChatResponseUpdate | undefined {
  if (typeof event !== 'object' || event === null) {
    return undefined;
  }
  const raw = event as AnthropicBlock;
  switch (raw.type) {
    case 'message_start': {
      const fields = parseMessageFields(raw.message, state);
      const usage = usageContent(fields.raw.usage, state.emittedUsage);
      return chatResponseUpdate({
        role: 'assistant',
        contents: [...fields.contents, ...(usage === undefined ? [] : [usage])],
        ...envelopeInit(fields),
        rawRepresentation: event,
      });
    }
    case 'message_delta': {
      const usage = usageContent(raw.usage, state.emittedUsage);
      const delta = (raw.delta ?? {}) as AnthropicBlock;
      const finishReason = parseFinishReason(delta.stop_reason);
      return chatResponseUpdate({
        role: 'assistant',
        contents: usage === undefined ? [] : [usage],
        ...(finishReason === undefined ? {} : { finishReason }),
        rawRepresentation: event,
      });
    }
    case 'content_block_start':
    case 'content_block_delta': {
      const block = raw.type === 'content_block_start' ? raw.content_block : raw.delta;
      if (raw.type === 'content_block_delta') {
        const deltaType = (block as AnthropicBlock | null | undefined)?.type;
        if (
          deltaType !== 'text_delta' &&
          deltaType !== 'thinking_delta' &&
          deltaType !== 'signature_delta' &&
          deltaType !== 'input_json_delta'
        ) {
          // A delta is a fragment, not a replayable Messages API content block. Preserving an
          // unknown fragment as UnknownContent would send that fragment as a whole block on the
          // next turn and permanently poison the transcript.
          return undefined;
        }
      }
      const contents = parseContentBlocks([block], state);
      return contents.length === 0
        ? undefined
        : chatResponseUpdate({ role: 'assistant', contents, rawRepresentation: event });
    }
    default:
      return undefined;
  }
}
