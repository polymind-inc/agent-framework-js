import type {
  Annotation,
  ChatResponse,
  ChatResponseUpdate,
  Content,
  FinishReason,
  UsageDetails,
} from '@polymind-inc/agent-framework-core';
import { chatResponse, chatResponseUpdate, unknownContent } from '@polymind-inc/agent-framework-core';
import { isRecord, safeStringify } from '@polymind-inc/agent-framework-core/internal';
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
  /** The provider-executed call whose block is open, and the input fragments seen so far. */
  pendingCall?: { block: AnthropicBlock; json: string };
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

/** A nested wire payload, or `undefined` when the block does not carry one as an object. */
function asBlock(value: unknown): AnthropicBlock | undefined {
  return isRecord(value) ? value : undefined;
}

/** A wire string, or `undefined` when it is absent or empty — the fields Python treats as unset. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Whether a call block names one of Anthropic's code-execution tools.
 *
 * A substring test, as in Python: the tool's name is caller-chosen and the versioned defaults
 * (`code_execution`, `bash_code_execution`, `text_editor_code_execution`) all carry it.
 */
function isCodeExecutionName(name: unknown): boolean {
  return typeof name === 'string' && name.includes('code_execution');
}

/**
 * The `inputs` of a code-interpreter call: the code and data the interpreter was handed.
 *
 * A string input is carried through as it stands; anything else is rendered as JSON, which is also
 * what the streamed `input_json_delta` fragments spell out, so both paths report the same text.
 */
function codeInterpreterInputs(block: AnthropicBlock): Content[] {
  const input = block.input ?? {};
  return [
    {
      type: 'text',
      text: typeof input === 'string' ? input : safeStringify(input),
      rawRepresentation: block,
    },
  ];
}

/**
 * The `hosted_file` items a code-execution or bash result lists under `content`.
 *
 * An entry naming no file is not a hosted file: coercing it would put an item with an empty id in
 * the transcript, where nothing can fetch it and nothing says why. It is kept as unknown content
 * instead — the same treatment an unrecognized result payload gets — so it round-trips verbatim and
 * stays visible for whoever has to explain it. Python reads these off a typed SDK model whose
 * `file_id` is required, so it never meets the case; this reads the wire.
 */
function hostedFiles(result: AnthropicBlock): Content[] {
  const files: Content[] = [];
  for (const candidate of Array.isArray(result.content) ? result.content : []) {
    const file = asBlock(candidate);
    if (file === undefined) {
      continue;
    }
    const fileId = file.file_id;
    files.push(
      typeof fileId === 'string' && fileId !== ''
        ? { type: 'hosted_file', fileId, rawRepresentation: file }
        : unknownContent(file),
    );
  }
  return files;
}

/** The outputs of a `code_execution_tool_result` payload. */
function codeExecutionOutputs(result: AnthropicBlock): Content[] {
  switch (result.type) {
    case 'code_execution_tool_result_error':
      return [{ type: 'error', message: String(result.error_code ?? ''), rawRepresentation: result }];
    case 'code_execution_result':
    case 'encrypted_code_execution_result': {
      const outputs: Content[] = [];
      // The encrypted variant reports its stdout under a different key and never a plain one.
      const stdout = nonEmptyString(
        result.type === 'code_execution_result' ? result.stdout : result.encrypted_stdout,
      );
      if (stdout !== undefined) {
        outputs.push({ type: 'text', text: stdout, rawRepresentation: result });
      }
      const stderr = nonEmptyString(result.stderr);
      if (stderr !== undefined) {
        outputs.push({ type: 'error', message: stderr, rawRepresentation: result });
      }
      outputs.push(...hostedFiles(result));
      return outputs;
    }
    default:
      // A payload variant this build does not model is kept whole rather than read for fields it
      // may not have; the unknown-content round trip carries it verbatim.
      return [unknownContent(result)];
  }
}

/** The command output and the hosted files of a `bash_code_execution_tool_result` payload. */
function bashExecutionOutputs(result: AnthropicBlock): { outputs: Content[]; files: Content[] } {
  switch (result.type) {
    case 'bash_code_execution_tool_result_error': {
      const errorCode = String(result.error_code ?? '');
      return {
        outputs: [
          {
            type: 'shell_command_output',
            stderr: errorCode,
            // The one error code that is a timeout rather than a failure of the command itself.
            timedOut: errorCode === 'execution_time_exceeded',
            rawRepresentation: result,
          },
        ],
        files: [],
      };
    }
    case 'bash_code_execution_result': {
      const stdout = nonEmptyString(result.stdout);
      const stderr = nonEmptyString(result.stderr);
      const exitCode = asNumber(result.return_code);
      return {
        outputs: [
          {
            type: 'shell_command_output',
            ...(stdout === undefined ? {} : { stdout }),
            ...(stderr === undefined ? {} : { stderr }),
            ...(exitCode === undefined ? {} : { exitCode }),
            timedOut: false,
            rawRepresentation: result,
          },
        ],
        files: hostedFiles(result),
      };
    }
    default:
      return { outputs: [unknownContent(result)], files: [] };
  }
}

/** A citation covering `[start, start + lines)`, or `undefined` when the wire reported neither. */
function lineSpanAnnotation(start: unknown, lines: unknown, result: AnthropicBlock): Annotation | undefined {
  const startIndex = asNumber(start);
  const lineCount = asNumber(lines);
  if (startIndex === undefined || lineCount === undefined) {
    return undefined;
  }
  return {
    type: 'citation',
    annotatedRegions: [{ type: 'text_span', startIndex, endIndex: startIndex + lineCount }],
    rawRepresentation: result,
  };
}

/** The outputs of a `text_editor_code_execution_tool_result` payload. */
function textEditorOutputs(result: AnthropicBlock): Content[] {
  switch (result.type) {
    case 'text_editor_code_execution_tool_result_error': {
      // The error code gates the message, as in Python: a payload that reports a code but no
      // message describes itself through the raw representation rather than through prose.
      const errorCode = String(result.error_code ?? '');
      const errorMessage = errorCode === '' ? '' : (nonEmptyString(result.error_message) ?? '');
      return [{ type: 'error', message: errorMessage, rawRepresentation: result }];
    }
    case 'text_editor_code_execution_view_result': {
      const annotation = lineSpanAnnotation(result.start_line, result.num_lines, result);
      return [
        {
          type: 'text',
          text: String(result.content ?? ''),
          ...(annotation === undefined ? {} : { annotations: [annotation] }),
          rawRepresentation: result,
        },
      ];
    }
    case 'text_editor_code_execution_str_replace_result': {
      const lines = Array.isArray(result.lines) ? result.lines.map(String) : [];
      const text = lines.join('\n');
      const annotations: Annotation[] = [];
      const replaced = lineSpanAnnotation(result.old_start, result.old_lines, result);
      if (replaced !== undefined) {
        annotations.push(replaced);
      }
      const inserted = lineSpanAnnotation(result.new_start, result.new_lines, result);
      if (inserted !== undefined) {
        // Only the new span quotes what is now there; the old one points at lines that are gone.
        annotations.push(text === '' ? inserted : { ...inserted, snippet: text });
      }
      return [
        {
          type: 'text',
          text,
          ...(annotations.length === 0 ? {} : { annotations }),
          rawRepresentation: result,
        },
      ];
    }
    case 'text_editor_code_execution_create_result':
      return [
        {
          type: 'text',
          text: `File update: ${result.is_file_update === true}`,
          rawRepresentation: result,
        },
      ];
    default:
      return [unknownContent(result)];
  }
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
        const codeExecution = isCodeExecutionName(block.name);
        if (state !== undefined) {
          // Only a local `tool_use` streams its arguments onwards; a code-execution call is
          // reported whole, so its fragments must not be attributed to a function call.
          state.currentCall = { callId, blockType: codeExecution ? 'code_execution' : String(block.type) };
        }
        if (codeExecution) {
          contents.push({
            type: 'code_interpreter_tool_call',
            callId,
            inputs: codeInterpreterInputs(block),
            rawRepresentation: block,
          });
          break;
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
      case 'code_execution_tool_result': {
        const result = asBlock(block.content);
        contents.push({
          type: 'code_interpreter_tool_result',
          callId: String(block.tool_use_id ?? ''),
          outputs: result === undefined ? [] : codeExecutionOutputs(result),
          rawRepresentation: block,
        });
        break;
      }
      case 'bash_code_execution_tool_result': {
        const result = asBlock(block.content);
        const parsed = result === undefined ? { outputs: [], files: [] } : bashExecutionOutputs(result);
        // The files a bash run produced are siblings of the shell result rather than outputs
        // nested inside it, matching Python — they surface directly on the response that way.
        contents.push(...parsed.files);
        contents.push({
          type: 'shell_tool_result',
          callId: String(block.tool_use_id ?? ''),
          outputs: parsed.outputs,
          rawRepresentation: block,
        });
        break;
      }
      case 'text_editor_code_execution_tool_result': {
        // The text editor has no hosted-tool content of its own: Python reports its outcome as an
        // ordinary function result answering the call, and so does this.
        const result = asBlock(block.content);
        contents.push({
          type: 'function_result',
          callId: String(block.tool_use_id ?? ''),
          result: result === undefined ? [] : textEditorOutputs(result),
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
 * Whether the provider, not the framework, runs this call.
 *
 * Such a call is modelled as one whole content item — a hosted call or an informational function
 * call — so it has no fragment form to stream. Its `input_json_delta` fragments are accumulated
 * and the call is converted once its block closes, which is what makes a streamed transcript carry
 * the same arguments as an awaited one. A local `tool_use` keeps streaming its fragments, because
 * the function-calling loop consumes them as they arrive.
 */
function isProviderExecutedCall(block: AnthropicBlock): boolean {
  return (
    block.type === 'server_tool_use' ||
    block.type === 'mcp_tool_use' ||
    (block.type === 'tool_use' && isCodeExecutionName(block.name))
  );
}

/**
 * The accumulated fragments parsed back into the input they spell, or `undefined` when they spell
 * no complete JSON value.
 *
 * Any JSON value, not only an object: a code-execution call carries its program as a plain string,
 * and reading only objects would leave the streamed form holding the opening placeholder while the
 * awaited form held the program. The result is wrapped so that a literal `null` — itself valid
 * JSON — stays distinguishable from fragments that parsed into nothing.
 */
function parsedInput(json: string): { value: unknown } | undefined {
  if (json.trim() === '') {
    return undefined;
  }
  try {
    return { value: JSON.parse(json) as unknown };
  } catch {
    // A truncated stream leaves half a JSON document behind; the opening placeholder is closer to
    // the model's intent than a fragment that cannot be parsed back into an input.
    return undefined;
  }
}

/** Converts the provider-executed call left open, if there is one, and clears it. */
function flushPendingCall(state: StreamParseState): Content[] {
  const pending = state.pendingCall;
  if (pending === undefined) {
    return [];
  }
  delete state.pendingCall;
  const input = parsedInput(pending.json);
  // Converted without the streaming state, so the completed block reads exactly as the same block
  // does in an awaited response.
  return parseContentBlocks([input === undefined ? pending.block : { ...pending.block, input: input.value }]);
}

function contentUpdate(contents: Content[], event: unknown): ChatResponseUpdate | undefined {
  return contents.length === 0
    ? undefined
    : chatResponseUpdate({ role: 'assistant', contents, rawRepresentation: event });
}

/**
 * Converts one streaming event, or `undefined` for the events that carry nothing.
 *
 * `message_stop` and `content_block_stop` are otherwise pure framing — the framework's fold already
 * knows where a message ends — but they are where a deferred provider-executed call is emitted.
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
      // Only the event that ends the message closes a block still open. A `message_delta` carrying
      // nothing but a usage snapshot is not the end of anything, and converting the call there
      // would clear it while its fragments were still arriving — they would then belong to no
      // call and be dropped, leaving the folded transcript holding a call without its input.
      const pending = finishReason === undefined ? [] : flushPendingCall(state);
      return chatResponseUpdate({
        role: 'assistant',
        contents: [...pending, ...(usage === undefined ? [] : [usage])],
        ...(finishReason === undefined ? {} : { finishReason }),
        rawRepresentation: event,
      });
    }
    // A stream that ends without closing its last block still reports the call it opened.
    case 'content_block_stop':
    case 'message_stop':
      return contentUpdate(flushPendingCall(state), event);
    case 'content_block_start': {
      const block = asBlock(raw.content_block);
      const pending = flushPendingCall(state);
      if (block !== undefined && isProviderExecutedCall(block)) {
        state.pendingCall = { block, json: '' };
        // Fragments now belong to the pending call, not to any call announced before it.
        delete state.currentCall;
        return contentUpdate(pending, event);
      }
      return contentUpdate([...pending, ...parseContentBlocks([block], state)], event);
    }
    case 'content_block_delta': {
      const delta = asBlock(raw.delta);
      if (delta?.type === 'input_json_delta' && state.pendingCall !== undefined) {
        state.pendingCall.json += String(delta.partial_json ?? '');
        return undefined;
      }
      if (
        delta?.type !== 'text_delta' &&
        delta?.type !== 'thinking_delta' &&
        delta?.type !== 'signature_delta' &&
        delta?.type !== 'input_json_delta'
      ) {
        // A delta is a fragment, not a replayable Messages API content block. Preserving an
        // unknown fragment as UnknownContent would send that fragment as a whole block on the
        // next turn and permanently poison the transcript.
        return undefined;
      }
      return contentUpdate(parseContentBlocks([delta], state), event);
    }
    default:
      return undefined;
  }
}
