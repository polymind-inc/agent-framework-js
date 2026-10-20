import type {
  Content,
  FunctionResultContent,
  HostedTool,
  HostedToolCallContent,
  HostedToolResultContent,
  Message,
  ResponseFormat,
  Role,
  Tool,
  ToolChoice,
} from '@polymind-inc/agent-framework-core';
import {
  deserializeContent,
  isFunctionTool,
  resolveResponseFormat,
  serializeContent,
  textOfContents,
} from '@polymind-inc/agent-framework-core';
import {
  answeredCallIds,
  isRecord,
  safeStringify,
  topLevelMediaType,
} from '@polymind-inc/agent-framework-core/internal';
import { MCP_SERVER_SPEC_TYPE } from './hosted-tools.js';

/** A Messages API content block, kept loose so unmodelled block types pass through. */
export type AnthropicBlock = Record<string, unknown>;

/** A Messages API message. */
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[] | string;
}

/**
 * Role mapping, matching Python `ROLE_MAP`.
 *
 * Messages API only knows `user` and `assistant`: system prompts travel in the top-level `system`
 * parameter, and tool results are user turns.
 */
const ROLE_MAP: Record<Role, 'user' | 'assistant'> = {
  user: 'user',
  assistant: 'assistant',
  system: 'user',
  tool: 'user',
};

/** Blocks that only make sense on an assistant turn. */
const ASSISTANT_BLOCKS = new Set(['tool_use', 'mcp_tool_use', 'server_tool_use']);
/** Blocks that only make sense on a user turn. */
const USER_BLOCKS = new Set(['tool_result', 'mcp_tool_result']);

/**
 * The object the Messages API wants as `tool_use.input`.
 *
 * Anything that is not an object is carried under a single `raw` key rather than erased. A
 * transcript reaches this function from places the model never wrote — an interrupted stream, a
 * restored session, arguments another provider produced — and there an empty object is not the
 * safe reading: a tool whose parameters are all optional receives `{}` as a legitimately valid
 * call, so erasing a corrupted payload turns it into a different invocation that nothing
 * downstream can tell apart from the real one. Keeping the payload makes the corruption visible
 * to whoever reads the transcript, and the API accepts the extra key: it does not validate a
 * replayed `tool_use.input` against the tool's schema, not even with `strict` and
 * `additionalProperties: false`.
 *
 * A tool that declares `raw` as a parameter of its own is the one case where this is ambiguous to
 * the model. That is a naming collision in what the model reads, not a transport error.
 *
 * The empty string maps to `{}` because a call with no arguments at all is not corrupted. Every
 * other unparseable text keeps its original characters, untrimmed.
 */
function toolInput(args: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof args === 'string') {
    if (args === '') {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(args);
      return isRecord(parsed) ? parsed : { raw: parsed };
    } catch {
      return { raw: args };
    }
  }
  // The declared type says this is already an object, but nothing validates it: a session
  // deserialized from JSON can hold an array or a number here, and the API answers a non-object
  // `input` with 400 `Input should be an object`.
  return isRecord(args) ? args : { raw: args };
}

/** The base64 payload of a `data:` URI, or `undefined` when it is not base64-encoded. */
function base64Payload(uri: string): string | undefined {
  const marker = ';base64,';
  const index = uri.indexOf(marker);
  return index === -1 ? undefined : uri.slice(index + marker.length);
}

/** An image block from `data` (base64 inline) or `uri` (by URL). */
function imageBlock(content: Content): AnthropicBlock | undefined {
  if (content.type === 'data' && topLevelMediaType(content.mediaType) === 'image') {
    const data = base64Payload(content.uri);
    return data === undefined
      ? undefined
      : { type: 'image', source: { type: 'base64', media_type: content.mediaType, data } };
  }
  if (content.type === 'uri' && topLevelMediaType(content.mediaType) === 'image') {
    return { type: 'image', source: { type: 'url', url: content.uri } };
  }
  return undefined;
}

/** Renders a `function_result` payload into what `tool_result.content` accepts. */
function toolResultContent(result: unknown): AnthropicBlock[] | string {
  if (result === undefined || result === null) {
    return '';
  }
  if (typeof result === 'string') {
    return result;
  }
  if (Array.isArray(result)) {
    const blocks: AnthropicBlock[] = [];
    for (const item of result as Content[]) {
      if (typeof item !== 'object' || item === null || !('type' in item)) {
        continue;
      }
      if (item.type === 'text') {
        blocks.push({ type: 'text', text: item.text });
        continue;
      }
      const image = imageBlock(item);
      if (image !== undefined) {
        blocks.push(image);
      }
      // Anything else has no tool_result representation; dropping it matches Python.
    }
    return blocks.length > 0 ? blocks : '';
  }
  // Caller-built or replayed transcripts can carry results JSON cannot encode (circular
  // references, bigints, symbols); degrade to the value's string form rather than failing the
  // whole request, as Python does with json.dumps falling back to str().
  return safeStringify(result);
}

/** The blocks a provider-run code-execution call and its result arrive as. */
const PROVIDER_EXECUTED_BLOCKS = new Set([
  'tool_use',
  'server_tool_use',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
]);

/**
 * The block to replay for content describing a call the provider ran itself.
 *
 * These contents model an outcome, not a request the caller can make: the result blocks have to
 * go back on the assistant turn that produced them rather than as a `tool_result` answering a
 * call the transcript no longer contains. The block the API sent is replayed when it is still
 * held — it is the exact bytes — and a restored transcript, whose raw representations were
 * stripped by serialization, falls back to rebuilding the block from the typed contents (the
 * `code_interpreter_tool_call` … cases below), so an exchange that used code execution survives
 * the next request either way.
 */
function providerExecutedBlock(content: Content): AnthropicBlock | undefined {
  if (
    content.type !== 'code_interpreter_tool_call' &&
    content.type !== 'code_interpreter_tool_result' &&
    content.type !== 'shell_tool_result' &&
    content.type !== 'function_result'
  ) {
    return undefined;
  }
  const raw = content.rawRepresentation;
  if (!isRecord(raw) || typeof raw.type !== 'string' || !PROVIDER_EXECUTED_BLOCKS.has(raw.type)) {
    return undefined;
  }
  return raw;
}

/**
 * The `additionalProperties` key under which a code-execution, bash or text-editor result records
 * the `type` of the payload it was read from.
 */
export const PAYLOAD_TYPE_KEY = 'payloadType';

/** The `additionalProperties` key under which a code-execution result records a non-zero `return_code`. */
export const RETURN_CODE_KEY = 'returnCode';

/**
 * The `additionalProperties` key under which a str_replace line-span citation records which span it
 * is, `'replaced'` or `'inserted'`.
 */
export const LINE_SPAN_KEY = 'lineSpan';

/**
 * The payload variant a result recorded on receive, or `undefined` for a transcript stored before
 * the record existed — which the rebuild then reads back off the typed outputs alone.
 */
function recordedPayloadType(content: Content): string | undefined {
  const type = content.additionalProperties?.[PAYLOAD_TYPE_KEY];
  return typeof type === 'string' ? type : undefined;
}

/** The `code_execution_tool_result` payload variants the receive side models. */
const MODELLED_CODE_EXECUTION_PAYLOADS = new Set([
  'code_execution_tool_result_error',
  'code_execution_result',
  'encrypted_code_execution_result',
]);

/** The wire names of the code-execution tool family, as `server_tool_use.name` carries them. */
type CodeExecutionFamily = 'code_execution' | 'bash_code_execution' | 'text_editor_code_execution';

/** What the transcript-wide passes computed for the per-content conversion. */
interface ConversionContext {
  /** The `callId`s a `function_result` anywhere in the transcript answers. */
  answered: ReadonlySet<string>;
  /** Provider-executed call ids → the tool family inferred from the content answering them. */
  families: ReadonlyMap<string, CodeExecutionFamily>;
  /**
   * The blocks emitted for provider-executed calls, filled in as the conversion runs. A call can go
   * out as `server_tool_use` or — replayed raw — as the `tool_use` it arrived as, so it is known by
   * the content it came from, never by its block type alone.
   */
  providerCalls: Set<AnthropicBlock>;
}

/** Whether a request message carries only local `tool_result` blocks. */
function isLocalResults(msg: AnthropicMessage): boolean {
  return (
    Array.isArray(msg.content) &&
    msg.content.length > 0 &&
    msg.content.every((block) => block.type === 'tool_result')
  );
}

/**
 * The request messages without the server calls that no result answers and whose turn has closed.
 *
 * A server call legitimately lacks its result in one place only: the open turn — the trailing run
 * of assistant messages, with nothing after it but local `tool_result` messages. A `pause_turn`
 * response ends there on a call the API has not run yet, and a call made alongside a local tool
 * waits there for the local results; the API runs it on the next request. Anywhere else the turn is
 * over without the result — a stream abandoned mid-call — and the API refuses the whole request
 * over it, so the call is omitted instead, the same defined omission an unanswered local
 * `function_call` gets. The turns are read off the messages the request will carry, not the
 * framework messages they came from: a framework message can split into several turns, and one
 * that sends nothing (usage metadata, say) is not a turn at all.
 */
function withoutAbandonedServerCalls(
  messages: readonly AnthropicMessage[],
  providerCalls: ReadonlySet<AnthropicBlock>,
): { messages: AnthropicMessage[]; pending: boolean } {
  const answered = new Set<string>();
  for (const msg of messages) {
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      // Every provider-executed result names its call; a local `tool_result` answers a `tool_use`.
      if (block.type !== 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id !== '') {
        answered.add(block.tool_use_id);
      }
    }
  }
  let openEnd = messages.length;
  while (openEnd > 0 && isLocalResults(messages[openEnd - 1] as AnthropicMessage)) {
    openEnd--;
  }
  let openStart = openEnd;
  while (openStart > 0 && messages[openStart - 1]?.role === 'assistant') {
    openStart--;
  }
  const isPending = (block: AnthropicBlock): boolean =>
    providerCalls.has(block) && !(typeof block.id === 'string' && answered.has(block.id));
  // Whether the open turn still waits on a call — which a closing user turn would leave unanswered.
  const pending = messages
    .slice(openStart, openEnd)
    .some((msg) => Array.isArray(msg.content) && msg.content.some(isPending));
  const kept = messages.flatMap((msg, index) => {
    if ((index >= openStart && index < openEnd) || !Array.isArray(msg.content)) {
      return [msg];
    }
    const content = msg.content.filter((block) => !isPending(block));
    if (content.length === msg.content.length) {
      return [msg];
    }
    return content.length === 0 ? [] : [{ ...msg, content }];
  });
  return { messages: kept, pending };
}

/**
 * Which code-execution family each provider-executed call belongs to.
 *
 * The typed `code_interpreter_tool_call` does not say which of the three code-execution tools
 * ran — the receive side folds all of them into one content kind — but the kind of the content
 * answering the call does: a `code_interpreter_tool_result` answers `code_execution`, a
 * `shell_tool_result` answers `bash_code_execution`, and a `function_result` answers
 * `text_editor_code_execution`. A call nothing answers reads as plain `code_execution`.
 */
function codeExecutionFamilies(messages: readonly Message[]): Map<string, CodeExecutionFamily> {
  // Only a non-empty callId is an identity two contents can share — the same rule the unanswered-
  // call filter applies. Keying `''` would let unrelated keyless contents correlate, flipping the
  // rebuilt family of one degenerate call because a different keyless result happened to exist.
  const families = new Map<string, CodeExecutionFamily>();
  for (const msg of messages) {
    for (const content of msg.contents) {
      if (
        content.type === 'code_interpreter_tool_call' &&
        content.callId !== undefined &&
        content.callId !== ''
      ) {
        families.set(content.callId, 'code_execution');
      }
    }
  }
  for (const msg of messages) {
    for (const content of msg.contents) {
      const callId = 'callId' in content ? content.callId : undefined;
      if (typeof callId !== 'string' || callId === '' || !families.has(callId)) {
        continue;
      }
      if (content.type === 'shell_tool_result') {
        families.set(callId, 'bash_code_execution');
      } else if (content.type === 'function_result') {
        families.set(callId, 'text_editor_code_execution');
      }
    }
  }
  return families;
}

/** The `error_code` values each result schema accepts; anything else in that slot is prose. */
const CODE_EXECUTION_ERROR_CODES = new Set([
  'invalid_tool_input',
  'unavailable',
  'too_many_requests',
  'execution_time_exceeded',
]);
const BASH_ERROR_CODES = new Set([...CODE_EXECUTION_ERROR_CODES, 'output_file_too_large']);
const TEXT_EDITOR_ERROR_CODES = new Set([...CODE_EXECUTION_ERROR_CODES, 'file_not_found']);

/** Rebuilds the `server_tool_use` block of a provider-executed call from its typed content. */
function rebuiltServerToolUse(content: HostedToolCallContent, family: CodeExecutionFamily): AnthropicBlock {
  const text = content.inputs?.find((item) => item.type === 'text')?.text ?? '';
  // The receive side records an object input as its JSON and a string input as itself, so the
  // faithful inverse parses when it can and otherwise sends the text back as the string it was.
  // `server_tool_use.input` is `unknown` in the request schema, so a non-object round-trips as
  // itself — unlike a local `tool_use.input`, whose object requirement is what the `raw` wrapping
  // elsewhere serves. (A string input that happens to be valid JSON parses; the two spellings are
  // indistinguishable once typed, and the parsed reading matches what an object input produced.)
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    input = text;
  }
  return { type: 'server_tool_use', id: content.callId ?? '', name: family, input };
}

/** The file entries a rebuilt result payload lists for its `hosted_file` and preserved contents. */
function rebuiltFileEntries(items: readonly Content[], entryType: string): AnthropicBlock[] {
  const entries: AnthropicBlock[] = [];
  for (const item of items) {
    if (item.type === 'hosted_file' && item.fileId !== undefined && item.fileId !== '') {
      entries.push({ type: entryType, file_id: item.fileId });
    } else if (item.type === 'unknown' && item.unknownType !== '') {
      // A malformed entry — one naming no fetchable file — is preserved verbatim by the receive
      // side; it goes back where it sat, so a restored replay carries the same list the wire did.
      entries.push(serializeContent(item) as AnthropicBlock);
    }
  }
  return entries;
}

/** Whether a content item is a bash file entry the receive side placed before its shell result. */
function isBashFileSibling(content: Content | undefined): boolean {
  return (
    content?.type === 'hosted_file' ||
    (content?.type === 'unknown' && content.unknownType === 'bash_code_execution_output')
  );
}

/**
 * Whether this preserved entry is folded into the shell result that follows it.
 *
 * The receive side lists a bash run's file entries — malformed ones preserved as unknown content —
 * as siblings *before* the `shell_tool_result`. Those are the shell payload's to carry: the
 * rebuilt payload lists them again, and a raw replay already holds them inside the raw block, so
 * emitting them standalone here would duplicate them at the top level.
 */
function foldsIntoFollowingShellResult(contents: readonly Content[], index: number): boolean {
  const item = contents[index];
  if (item?.type !== 'unknown' || item.unknownType !== 'bash_code_execution_output') {
    return false;
  }
  for (let cursor = index + 1; cursor < contents.length; cursor++) {
    if (isBashFileSibling(contents[cursor])) {
      continue;
    }
    return contents[cursor]?.type === 'shell_tool_result';
  }
  return false;
}

/**
 * The payload a result block carried, when the receive side kept it as unknown content.
 *
 * A payload variant this build does not model is preserved whole rather than read for fields it
 * may not have. It goes back exactly as it arrived — the forward-compatible rule unknown content
 * follows everywhere — rather than as a modelled variant invented from fields it never had.
 */
function preservedPayload(item: Content | undefined): AnthropicBlock | undefined {
  if (item?.type !== 'unknown' || item.unknownType === '') {
    return undefined;
  }
  return serializeContent(item) as AnthropicBlock;
}

/**
 * Rebuilds the payload of a `code_execution_tool_result` from the typed outputs.
 *
 * The variant the result recorded on receive decides the payload shape: an unmodelled one goes
 * back whole, and any other unknown output is a malformed file entry, which goes back inside the
 * result. A transcript stored before the record existed is read back off the outputs alone.
 */
function rebuiltCodeExecutionPayload(content: HostedToolResultContent): AnthropicBlock {
  const outputs = content.outputs ?? [];
  const variant = recordedPayloadType(content);
  const [only] = outputs;
  if (variant !== undefined && !MODELLED_CODE_EXECUTION_PAYLOADS.has(variant)) {
    return preservedPayload(only) ?? { type: variant };
  }
  // Without the record, a stored `errorCode` marks the error variant, and a legacy session without
  // the stored code is recognized by its message carrying a known code, since the receive side
  // wrote the code as the message; a prose-only lone error stays a result payload, because that is
  // how a stderr-only run reads back.
  const isError =
    variant === undefined
      ? outputs.length === 1 &&
        only?.type === 'error' &&
        (only.errorCode !== undefined || CODE_EXECUTION_ERROR_CODES.has(only.message ?? ''))
      : variant === 'code_execution_tool_result_error';
  if (isError) {
    // A code the schema does not know degrades to `unavailable`, the same way the text-editor path
    // degrades, rather than flipping the payload into a success-shaped result.
    const stored = only?.type === 'error' ? (only.errorCode ?? only.message ?? '') : '';
    return {
      type: 'code_execution_tool_result_error',
      error_code: CODE_EXECUTION_ERROR_CODES.has(stored) ? stored : 'unavailable',
    };
  }
  // Ciphertext goes back under the key it arrived in; sent as plain stdout, the model would read
  // the encrypted blob as the program's output.
  const encrypted = variant === 'encrypted_code_execution_result';
  const returnCode = content.additionalProperties?.[RETURN_CODE_KEY];
  return {
    type: encrypted ? 'encrypted_code_execution_result' : 'code_execution_result',
    [encrypted ? 'encrypted_stdout' : 'stdout']: outputs
      .filter((item): item is Content & { type: 'text' } => item.type === 'text')
      .map((item) => item.text)
      .join(''),
    stderr: outputs
      .filter((item): item is Content & { type: 'error' } => item.type === 'error')
      .map((item) => item.message ?? '')
      .join('\n'),
    // Zero is the default the receive side leaves unrecorded.
    return_code: typeof returnCode === 'number' ? returnCode : 0,
    content: rebuiltFileEntries(outputs, 'code_execution_output'),
  };
}

/** Rebuilds the payload of a `bash_code_execution_tool_result` from the shell output and files. */
function rebuiltBashPayload(content: HostedToolResultContent, files: readonly Content[]): AnthropicBlock {
  const outputs = content.outputs ?? [];
  // A shell result lists its files beside itself, so an unknown output is only ever an unmodelled
  // payload.
  const preserved = outputs.length === 1 ? preservedPayload(outputs[0]) : undefined;
  if (preserved !== undefined) {
    return preserved;
  }
  const output = outputs.find(
    (item): item is Content & { type: 'shell_command_output' } => item.type === 'shell_command_output',
  );
  const variant = recordedPayloadType(content);
  // Without the record, the error variant is recognized by its shape: the receive side reports it
  // as a shell output whose stderr carries the code and nothing else, while a result always
  // reports its exit code.
  const isError =
    variant === undefined
      ? output !== undefined &&
        (output.timedOut === true ||
          (output.stdout === undefined && output.exitCode === undefined && output.stderr !== undefined))
      : variant === 'bash_code_execution_tool_result_error';
  if (isError) {
    // As on the code-execution path, a code the schema does not know degrades to `unavailable`
    // rather than reading as a successful run.
    const stored = output?.timedOut === true ? 'execution_time_exceeded' : (output?.stderr ?? '');
    return {
      type: 'bash_code_execution_tool_result_error',
      error_code: BASH_ERROR_CODES.has(stored) ? stored : 'unavailable',
    };
  }
  return {
    type: 'bash_code_execution_result',
    stdout: output?.stdout ?? '',
    stderr: output?.stderr ?? '',
    return_code: output?.exitCode ?? 0,
    content: rebuiltFileEntries(files, 'bash_code_execution_output'),
  };
}

/** The `[start, lines]` span a line-range citation covers, or `undefined`. */
function citedSpan(annotation: {
  annotatedRegions?: readonly { type?: string; startIndex?: number; endIndex?: number }[];
}): { start: number; lines: number } | undefined {
  const region = annotation.annotatedRegions?.[0];
  if (region?.type !== 'text_span' || region.startIndex === undefined || region.endIndex === undefined) {
    return undefined;
  }
  return { start: region.startIndex, lines: region.endIndex - region.startIndex };
}

/**
 * Rebuilds a `text_editor_code_execution_tool_result` block from the `function_result` the text
 * editor maps to.
 *
 * The variant the result recorded on receive decides the payload shape. A transcript stored before
 * the record existed has only the typed outcome, so its variant is read back off what each one
 * alone produces: the fixed `File update:` text of a create, an error content, a replaced/inserted
 * line-span pair for a str_replace, and a single viewed span otherwise. The fields the receive side
 * does not model default to what a text view reports (`file_type: 'text'`), and an error whose
 * stored code is not one the schema accepts degrades to `unavailable` with the message preserved,
 * rather than an invalid request.
 */
function rebuiltTextEditorResult(content: FunctionResultContent): AnthropicBlock {
  const items = Array.isArray(content.result) ? (content.result as Content[]) : [];
  const first = items[0];
  // Deserialization does not restore `result` as content, so in a restored session an unmodelled
  // payload sits under its wire type rather than as unknown content. One trip through the content
  // codec reads the restored and the in-memory spellings alike.
  const preserved = preservedPayload(
    isRecord(first) && typeof first.type === 'string'
      ? deserializeContent(serializeContent(first))
      : undefined,
  );
  const text = first?.type === 'text' ? first : undefined;
  const spans = (text?.annotations ?? []).flatMap((annotation) => {
    const span = citedSpan(annotation);
    return span === undefined
      ? []
      : [{ span, snippet: 'snippet' in annotation, role: annotation.additionalProperties?.[LINE_SPAN_KEY] }];
  });
  const variant =
    recordedPayloadType(content) ??
    (first?.type === 'error'
      ? 'text_editor_code_execution_tool_result_error'
      : text !== undefined && /^File update: (true|false)$/.test(text.text)
        ? 'text_editor_code_execution_create_result'
        : spans.length >= 2 || spans.some((entry) => entry.snippet)
          ? 'text_editor_code_execution_str_replace_result'
          : 'text_editor_code_execution_view_result');
  let payload: AnthropicBlock;
  if (preserved !== undefined) {
    payload = preserved;
  } else if (variant === 'text_editor_code_execution_tool_result_error') {
    const error = first?.type === 'error' ? first : undefined;
    const stored = error?.errorCode ?? '';
    payload = {
      type: variant,
      error_code: TEXT_EDITOR_ERROR_CODES.has(stored) ? stored : 'unavailable',
      ...(error?.message === undefined || error.message === '' ? {} : { error_message: error.message }),
    };
  } else if (variant === 'text_editor_code_execution_create_result') {
    payload = { type: variant, is_file_update: text?.text === 'File update: true' };
  } else if (variant === 'text_editor_code_execution_str_replace_result') {
    // Each span records which one it is. Without the record, two spans are the replaced and the
    // inserted one, in that order, and a lone span is the inserted one when it quotes the new lines
    // — the receive side attaches the snippet to that span only, whenever there are lines to quote
    // — and the replaced one otherwise; with no lines to tell them apart, it reads as the inserted.
    const lines = text?.text ?? '';
    const [only] = spans;
    const [oldSpan, newSpan] = spans.some((entry) => entry.role !== undefined)
      ? [spans.find((entry) => entry.role === 'replaced'), spans.find((entry) => entry.role === 'inserted')]
      : spans.length >= 2
        ? [spans[0], spans[1]]
        : only !== undefined && !only.snippet && lines !== ''
          ? [only, undefined]
          : [undefined, only];
    payload = {
      type: variant,
      ...(lines === '' ? {} : { lines: lines.split('\n') }),
      ...(oldSpan === undefined ? {} : { old_start: oldSpan.span.start, old_lines: oldSpan.span.lines }),
      ...(newSpan === undefined ? {} : { new_start: newSpan.span.start, new_lines: newSpan.span.lines }),
    };
  } else {
    // A view — or, with nothing typed to rebuild from, an empty view, which says "the editor
    // reported nothing" without inventing an outcome.
    const viewed = spans[0]?.span;
    payload = {
      type: 'text_editor_code_execution_view_result',
      content: text?.text ?? '',
      file_type: 'text',
      ...(viewed === undefined ? {} : { start_line: viewed.start, num_lines: viewed.lines }),
    };
  }
  return { type: 'text_editor_code_execution_tool_result', tool_use_id: content.callId, content: payload };
}

/**
 * Converts one framework content item into Messages API blocks.
 *
 * `blocks` is passed in rather than returned because a signature-only `text_reasoning` attaches to
 * the `thinking` block before it instead of producing one of its own (Python
 * `_prepare_message_for_anthropic`).
 */
function appendContent(
  blocks: AnthropicBlock[],
  contents: readonly Content[],
  index: number,
  ctx: ConversionContext,
): void {
  const content = contents[index] as Content;
  const providerExecuted = providerExecutedBlock(content);
  if (providerExecuted !== undefined) {
    if (content.type === 'code_interpreter_tool_call') {
      ctx.providerCalls.add(providerExecuted);
    }
    blocks.push(providerExecuted);
    return;
  }
  switch (content.type) {
    case 'code_interpreter_tool_call': {
      // Reached only without a raw block — a restored transcript — since the raw path above
      // replays the exact bytes otherwise. The same holds for the result cases below.
      const block = rebuiltServerToolUse(content, ctx.families.get(content.callId ?? '') ?? 'code_execution');
      ctx.providerCalls.add(block);
      blocks.push(block);
      return;
    }
    case 'code_interpreter_tool_result': {
      blocks.push({
        type: 'code_execution_tool_result',
        tool_use_id: content.callId ?? '',
        content: rebuiltCodeExecutionPayload(content),
      });
      return;
    }
    case 'shell_tool_result': {
      // The files a bash run produced sit as siblings *before* the shell result — that is where
      // the receive side put them, malformed entries preserved as unknown content included — so
      // the rebuilt payload gathers the contiguous run immediately preceding this content.
      const files: Content[] = [];
      for (let cursor = index - 1; cursor >= 0; cursor--) {
        const sibling = contents[cursor];
        if (!isBashFileSibling(sibling)) {
          break;
        }
        files.unshift(sibling as Content);
      }
      blocks.push({
        type: 'bash_code_execution_tool_result',
        tool_use_id: content.callId ?? '',
        content: rebuiltBashPayload(content, files),
      });
      return;
    }
    case 'text': {
      // The API rejects empty text blocks.
      if (content.text !== '') {
        blocks.push({ type: 'text', text: content.text });
      }
      return;
    }
    case 'text_reasoning': {
      const signature = content.protectedData;
      if (content.text === undefined || content.text === '') {
        const previous = blocks[blocks.length - 1];
        if (
          typeof signature === 'string' &&
          previous !== undefined &&
          previous.type === 'thinking' &&
          previous.signature === undefined
        ) {
          previous.signature = signature;
        }
        return;
      }
      if (content.id !== undefined && signature === undefined) {
        // A summary carries no signature and cannot be replayed as thinking.
        blocks.push({ type: 'text', text: content.text });
        return;
      }
      blocks.push({
        type: 'thinking',
        thinking: content.text,
        ...(typeof signature === 'string' ? { signature } : {}),
      });
      return;
    }
    case 'function_call': {
      // A call that no `function_result` anywhere in the transcript answers is omitted: the Messages
      // API refuses the request outright when a `tool_use` has no `tool_result` — so the choice is
      // not between sending and filtering but between a defined omission and a provider 400. A
      // transcript legitimately holds such a call (an approval pause, the iteration limit, an
      // abandoned stream, a fatal middleware abort, a declaration-only tool), and the OpenAI
      // conversion already filters it the same way, so one rule governs every provider. An empty
      // callId is never a pairable identity and is dropped on the same grounds.
      if (content.callId === '' || !ctx.answered.has(content.callId)) {
        return;
      }
      blocks.push({
        type: 'tool_use',
        id: content.callId,
        name: content.name,
        input: toolInput(content.arguments),
      });
      return;
    }
    case 'function_result': {
      // The same grounds the empty-id call is dropped on: an empty id is not a pairable
      // identity, and with its call omitted above this `tool_result` would answer nothing —
      // exactly the shape the API refuses from the other direction.
      if (content.callId === '') {
        return;
      }
      if (ctx.families.get(content.callId) === 'text_editor_code_execution') {
        // The text editor's outcome is typed as an ordinary function result, but it answers a
        // provider-executed call: a restored transcript rebuilds the provider's own result block,
        // since a `tool_result` would answer a `tool_use` the request no longer contains.
        blocks.push(rebuiltTextEditorResult(content));
        return;
      }
      blocks.push({
        type: 'tool_result',
        tool_use_id: content.callId,
        content: toolResultContent(content.result),
        is_error: content.exception !== undefined,
      });
      return;
    }
    case 'data':
    case 'uri': {
      const image = imageBlock(content);
      if (image !== undefined) {
        blocks.push(image);
      }
      return;
    }
    case 'mcp_server_tool_call': {
      blocks.push({
        type: 'mcp_tool_use',
        id: content.callId ?? '',
        name: content.toolName ?? '',
        server_name: content.serverName ?? '',
        input: toolInput(content.arguments ?? {}),
      });
      return;
    }
    case 'mcp_server_tool_result': {
      blocks.push({
        type: 'mcp_tool_result',
        tool_use_id: content.callId ?? '',
        content: toolResultContent(content.output),
      });
      return;
    }
    case 'unknown': {
      if (foldsIntoFollowingShellResult(contents, index)) {
        return;
      }
      // Forward compatibility: a block this build does not model is replayed
      // exactly as it arrived, so a transcript survives a round trip through the framework.
      const raw = content.rawRepresentation;
      if (typeof raw === 'object' && raw !== null && typeof (raw as { type?: unknown }).type === 'string') {
        blocks.push(raw as AnthropicBlock);
        return;
      }
      // `rawRepresentation` is stripped by serialization, so a transcript that went through a
      // session store arrives here with the block's fields only. Rebuilding it through
      // `serializeContent` — the very function that dropped the raw object — is what makes the
      // round trip closed: a `redacted_thinking` payload survives persistence instead of being
      // dropped, which the API needs back to continue an extended-thinking turn.
      if (content.unknownType !== '') {
        blocks.push(serializeContent(content) as AnthropicBlock);
      }
      return;
    }
    default:
      // usage, error, approval control items and the remaining hosted kinds have no Messages API
      // representation; they are framework-side concepts.
      return;
  }
}

/** The role a block must sit on, regardless of the message it came from. */
function roleForBlock(block: AnthropicBlock, fallback: 'user' | 'assistant'): 'user' | 'assistant' {
  const type = block.type;
  if (typeof type === 'string' && ASSISTANT_BLOCKS.has(type)) {
    return 'assistant';
  }
  if (typeof type === 'string' && USER_BLOCKS.has(type)) {
    return 'user';
  }
  return fallback;
}

/**
 * Splits one framework message into the Messages API messages its blocks require.
 *
 * A single assistant turn can hold both a `tool_use` and the `tool_result` answering it — the
 * framework models a whole exchange as content — but Messages API insists that tool calls are
 * assistant turns and results are user turns (Python `_prepare_message_groups_for_anthropic`).
 */
function messageGroups(msg: Message, ctx: ConversionContext): AnthropicMessage[] {
  const fallback = ROLE_MAP[msg.role] ?? 'user';
  const blocks: AnthropicBlock[] = [];
  for (let index = 0; index < msg.contents.length; index++) {
    appendContent(blocks, msg.contents, index, ctx);
  }
  if (blocks.length === 0) {
    return [];
  }

  const groups: AnthropicMessage[] = [];
  let role: 'user' | 'assistant' | undefined;
  let current: AnthropicBlock[] = [];
  for (const block of blocks) {
    const blockRole = roleForBlock(block, fallback);
    if (current.length > 0 && role !== blockRole) {
      groups.push({ role: role ?? fallback, content: current });
      current = [];
    }
    role = blockRole;
    current.push(block);
  }
  if (current.length > 0) {
    groups.push({ role: role ?? fallback, content: current });
  }
  return groups;
}

function hasToolUse(msg: AnthropicMessage): boolean {
  return (
    Array.isArray(msg.content) &&
    msg.content.some((block) => {
      const type = block.type;
      return typeof type === 'string' && ASSISTANT_BLOCKS.has(type);
    })
  );
}

/**
 * Converts the framework transcript into the Messages API `messages` array.
 *
 * A leading system message is *not* included: it belongs in the `system` request parameter (see
 * {@link toAnthropicSystem}). A local `function_call` that no `function_result` in the transcript
 * answers is omitted — see the `function_call` case in {@link appendContent}. A conversation that would end
 * on an assistant turn gets a synthetic `"Continue"` user turn, because Messages API requires the
 * last message to be a user one — unless that turn still holds a `tool_use` block (a hosted or
 * raw-replayed call), where appending would break the call/result pairing (Python
 * `_prepare_messages_for_anthropic`).
 */
export function toAnthropicMessages(messages: readonly Message[]): AnthropicMessage[] {
  const rest = messages[0]?.role === 'system' ? messages.slice(1) : messages;
  // Collected across the whole transcript, so a call answered in a later message stays a call and
  // a provider-executed exchange is recognized wherever its halves sit.
  const families = codeExecutionFamilies(rest);
  const ctx: ConversionContext = {
    answered: answeredCallIds(rest),
    families,
    providerCalls: new Set(),
  };
  const { messages: out, pending } = withoutAbandonedServerCalls(
    rest.flatMap((msg) => messageGroups(msg, ctx)),
    ctx.providerCalls,
  );
  const last = out[out.length - 1];
  // A pending call anywhere on the open turn keeps it open, not only one in its last message.
  if (last !== undefined && last.role === 'assistant' && !hasToolUse(last) && !pending) {
    out.push({ role: 'user', content: 'Continue' });
  }
  return out;
}

/**
 * Builds the `system` parameter.
 *
 * Instructions and a leading system message are concatenated rather than one winning, so an agent's
 * instructions and a caller-supplied system message both reach the model (Python
 * `_prepare_text_instructions_for_anthropic`).
 */
export function toAnthropicSystem(
  messages: readonly Message[],
  instructions: string | undefined,
): string | undefined {
  const leading = messages[0]?.role === 'system' ? textOfContents(messages[0].contents) : undefined;
  const parts = [instructions, leading].filter((part): part is string => part !== undefined && part !== '');
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

/** The `tools` and `mcp_servers` halves of the request. */
export interface AnthropicToolsRequest {
  tools?: AnthropicBlock[];
  mcp_servers?: AnthropicBlock[];
}

/**
 * Converts declared tools.
 *
 * Function tools become `custom` tools; a hosted MCP tool is routed to the separate `mcp_servers`
 * parameter rather than to `tools`; anything else is passed through untouched so a caller can
 * declare a provider tool this build does not model.
 */
export function toAnthropicTools(tools: readonly Tool[] | undefined): AnthropicToolsRequest {
  if (tools === undefined || tools.length === 0) {
    return {};
  }
  const custom: AnthropicBlock[] = [];
  const servers: AnthropicBlock[] = [];
  for (const candidate of tools) {
    if (isFunctionTool(candidate)) {
      custom.push({
        type: 'custom',
        name: candidate.name,
        description: candidate.description,
        input_schema: candidate.jsonSchema,
      });
      continue;
    }
    const spec = (candidate as Partial<HostedTool>).spec;
    if (spec === undefined) {
      // Not a hosted tool and not a function tool: nothing sensible to send.
      continue;
    }
    if (spec.type === MCP_SERVER_SPEC_TYPE) {
      // Remote MCP servers travel in their own request field, not in `tools`.
      const { type: _marker, ...server } = spec;
      servers.push({ type: 'url', ...server });
      continue;
    }
    // A hosted tool this build does not model is sent verbatim, so a caller can reach a Messages
    // API tool the framework has not caught up with.
    custom.push(spec);
  }
  return {
    ...(custom.length > 0 ? { tools: custom } : {}),
    ...(servers.length > 0 ? { mcp_servers: servers } : {}),
  };
}

/**
 * Converts a tool choice.
 *
 * Messages API can force one specific tool but has no "one of these": a multi-name choice
 * silently degrades to `any`, the closest honest approximation. (Python logs a warning here;
 * this package has no logging surface, so the degradation is documented instead.)
 */
export function toAnthropicToolChoice(choice: ToolChoice | undefined): AnthropicBlock | undefined {
  if (choice === undefined) {
    return undefined;
  }
  if (choice === 'auto') {
    return { type: 'auto' };
  }
  if (choice === 'required') {
    return { type: 'any' };
  }
  if (choice === 'none') {
    return { type: 'none' };
  }
  const names = choice.required;
  if (names.length === 1) {
    return { type: 'tool', name: names[0] };
  }
  return { type: 'any' };
}

/**
 * Builds `output_config.format` from a `responseFormat` (the GA structured-output shape).
 *
 * Only `type` and `schema`: the API rejects anything else outright — `output_config.format.name:
 * Extra inputs are not permitted` — so the framework's `name` and `description`, which other
 * providers do put on the wire, are dropped here. `additionalProperties: false` is forced onto the
 * schema, as Python's `_prepare_response_format` does, because the strict decoder requires a
 * closed object.
 */
export function toAnthropicOutputFormat(format: ResponseFormat): Record<string, unknown> {
  const resolved = resolveResponseFormat(format);
  const schema =
    typeof resolved.schema === 'object' && resolved.schema !== null && !Array.isArray(resolved.schema)
      ? { ...(resolved.schema as Record<string, unknown>), additionalProperties: false }
      : resolved.schema;
  return { type: 'json_schema', schema };
}
