import type { OutputItem, ResponseEvent } from '@polymind-inc/agent-framework-agentserver';
import { ID_PREFIX, isValidId, newId } from '@polymind-inc/agent-framework-agentserver';
import type {
  Content,
  FunctionApprovalRequestContent,
  TextReasoningContent,
} from '@polymind-inc/agent-framework-core';
import { isRecord } from '@polymind-inc/agent-framework-core/internal';
import { reasoningEncryptedContent, stringifyMcpOutput } from '@polymind-inc/agent-framework-openai/internal';
import type { ToolboxConsentRequest } from './consent.js';
import { AGENT_FRAMEWORK_SERVER_LABEL, encodeFunctionOutput } from './converters.js';

/**
 * Item id prefixes for shell items. Not part of the protocol package's {@link ID_PREFIX} set;
 * the values mirror the reference id generator (Python `_id_generator.py`:
 * `new_function_shell_call_item_id` / `new_function_shell_call_output_item_id`).
 */
const SHELL_CALL_ID_PREFIX = 'lsh';
const SHELL_CALL_OUTPUT_ID_PREFIX = 'lsho';

/** One approval surfaced this turn: the id it went out under, and the request behind it. */
export interface SurfacedApproval {
  /** The `mcpr_…` id the platform sees. */
  readonly wireId: string;
  /**
   * The framework request, **unmodified** — it still carries its `ficc_…` id.
   *
   * Rewriting the id here is what previously let a next turn re-bind an approved call to
   * different arguments: the decision would then match a request rebuilt from replayed history
   * rather than the one a human was shown.
   */
  readonly request: FunctionApprovalRequestContent;
}

/** Which kind of output item a content maps to. */
type ItemKind =
  | 'message'
  | 'function_call'
  | 'reasoning'
  | 'mcp_call'
  | 'mcp_approval_request'
  | 'search_call'
  | 'code_interpreter_call';

function kindOf(content: Content): ItemKind | undefined {
  switch (content.type) {
    case 'text':
      return 'message';
    case 'function_call':
      return 'function_call';
    case 'text_reasoning':
      return 'reasoning';
    case 'mcp_server_tool_call':
      return 'mcp_call';
    case 'function_approval_request':
      return 'mcp_approval_request';
    case 'search_tool_call':
      // Only the two searches with a wire item; an unknown search tool must not be guessed
      // into `web_search_call` semantics it never had.
      return content.toolName === 'web_search' || content.toolName === 'file_search'
        ? 'search_call'
        : undefined;
    case 'code_interpreter_tool_call':
      return 'code_interpreter_call';
    default:
      return undefined;
  }
}

/** One text run per message item, so the content index never moves. */
const TEXT_CONTENT_INDEX = 0;

/** The `output_text` part as the protocol wants it: every field present, empty. */
function emptyTextPart(): Record<string, unknown> {
  return { type: 'output_text', text: '', annotations: [], logprobs: [] };
}

interface OpenItem {
  kind: ItemKind;
  id: string;
  index: number;
  item: OutputItem;
  /** Accumulated text or arguments, so the `done` item carries the whole value. */
  buffer: string;
  /**
   * The provider's own call id, for `mcp_call`. Kept separately because the *item* id may have
   * been re-minted when the provider's did not satisfy this protocol's id format, and the result
   * content that follows still refers to the provider's.
   */
  callId?: string;
  /**
   * The opaque reasoning payload, for `reasoning`. It has to reach the `done` item as
   * `encrypted_content`: the replay path reads it back into `protectedData`
   * (`converters.itemToMessage`), and without it a provider's encrypted reasoning is permanently
   * dropped across hosted turns (Python `_reasoning_output_item`).
   */
  encryptedContent?: string;
}

/**
 * The wire `result` for an image generation call: the payload of the first data/uri output.
 *
 * A `data:` URI is reduced to its base64 payload (the wire field is "base64-encoded image
 * result"); a plain URL is passed through as the closest representation available. Python
 * stringifies the whole outputs list (`str(content.outputs)`), which round-trips nothing — the
 * per-output extraction here is the deliberate improvement over that.
 */
function imageGenerationResult(outputs: unknown): string {
  if (!Array.isArray(outputs)) {
    return '';
  }
  for (const output of outputs) {
    const uri = (output as { uri?: unknown } | null)?.uri;
    if (typeof uri === 'string' && uri !== '') {
      const comma = uri.startsWith('data:') ? uri.indexOf(',') : -1;
      return comma >= 0 ? uri.slice(comma + 1) : uri;
    }
  }
  return '';
}

/** One wire `shell_call_output.output` entry from a `shell_command_output` content. */
function shellOutputEntry(content: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): Record<string, unknown> {
  return {
    stdout: content.stdout ?? '',
    stderr: content.stderr ?? '',
    outcome: { type: 'exit', exit_code: content.exitCode ?? 0 },
  };
}

/**
 * A tool call's arguments as a structured object.
 *
 * While streaming, arguments commonly arrive as the concatenated JSON string rather than a parsed
 * object; both forms must produce the same wire item. A string that is not a JSON object (still
 * partial, or not JSON at all) yields an empty object rather than a crash or a dropped field.
 */
function argumentsRecord(args: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (typeof args === 'object' && args !== null) {
    return args;
  }
  if (typeof args === 'string' && args !== '') {
    try {
      const parsed: unknown = JSON.parse(args);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through to the empty object.
    }
  }
  return {};
}

/**
 * The wire form of a tool call's arguments: a string — possibly a partial streamed fragment —
 * passes through, a structured object is JSON-encoded.
 */
function argumentsText(args: Record<string, unknown> | string): string {
  return typeof args === 'string' ? args : JSON.stringify(args);
}

/** The code a `code_interpreter_tool_call` ran: the concatenated text of its inputs. */
function codeOfInputs(inputs: unknown): string {
  if (!Array.isArray(inputs)) {
    return '';
  }
  let code = '';
  for (const input of inputs) {
    const text = (input as { text?: unknown } | null)?.text;
    if (typeof text === 'string') {
      code += text;
    }
  }
  return code;
}

/** Wire `code_interpreter_call.outputs` entries from a result's content outputs. */
function codeInterpreterWireOutputs(outputs: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(outputs)) {
    return [];
  }
  const entries: Array<Record<string, unknown>> = [];
  for (const output of outputs) {
    const record = output as { type?: unknown; text?: unknown; uri?: unknown } | null;
    if (record?.type === 'text' && typeof record.text === 'string') {
      entries.push({ type: 'logs', logs: record.text });
    } else if ((record?.type === 'uri' || record?.type === 'data') && typeof record.uri === 'string') {
      entries.push({ type: 'image', url: record.uri });
    }
  }
  return entries;
}

/** Construction options for {@link OutputBuilder}. */
export interface OutputBuilderOptions {
  /**
   * Called once per content item that has no wire representation and is therefore not emitted.
   *
   * The analogue of Python's `logger.warning("Content type '…' is not supported yet")`
   * (`_responses.py` `_to_outputs`): this package carries no logging dependency, so visibility is
   * a callback the host wires to its own logger. When absent, unmapped content is dropped
   * silently, as before.
   */
  onUnsupportedContent?: (content: Content) => void;
}

/**
 * Turns a stream of framework {@link Content} into Responses output items and delta events.
 *
 * The protocol allows **one open output item at a time**: a content of a different kind closes
 * the current item before opening its own. Text accumulates into a message item, function-call
 * argument fragments accumulate into a `function_call` item, MCP-call argument fragments into an
 * `mcp_call` item, and reasoning into a `reasoning` item — each emitting `output_item.added`, its
 * deltas, then `output_item.done` (with the item-family state events between, per the reference
 * builders in `azure-ai-agentserver-responses`).
 *
 * Approval requests are surfaced as `mcp_approval_request` with `server_label:
 * "agent_framework"`, which is how the framework's own runtime is presented to the platform as a
 * virtual MCP server.
 */
export class OutputBuilder {
  #open: OpenItem | undefined;
  #index = 0;
  readonly #partitionHint: string;
  readonly #onUnsupportedContent: ((content: Content) => void) | undefined;
  /** Approval requests surfaced this turn, so the handler can persist them for the next one. */
  readonly surfacedApprovals: SurfacedApproval[] = [];

  constructor(partitionHint: string, options: OutputBuilderOptions = {}) {
    this.#partitionHint = partitionHint;
    this.#onUnsupportedContent = options.onUnsupportedContent;
  }

  /**
   * The open item, when a tool result of `kind` addresses it.
   *
   * A result's `callId` may name the provider's own call id *or* the re-minted item id — the item
   * id is regenerated when the provider's does not satisfy this protocol's format, while the
   * result content that follows still refers to the provider's — and a result with no `callId`
   * matches whatever call is open.
   */
  #openFor(kind: ItemKind, callId: string | undefined): OpenItem | undefined {
    const open = this.#open;
    const matches =
      open !== undefined &&
      open.kind === kind &&
      (callId === undefined || callId === open.callId || callId === open.id);
    return matches ? open : undefined;
  }

  /** Emits the events for one content item. */
  *push(content: Content): Generator<ResponseEvent> {
    if (content.type === 'mcp_server_tool_result') {
      // The result of a provider-run MCP call belongs *on* the `mcp_call` item, not in an item of
      // its own — the wire item carries `arguments` and `output` together (Python folds it the
      // same way before emitting the item's `done`). A result with no matching open call is
      // surfaced as a standalone `custom_tool_call_output` instead (Python `_to_outputs`).
      const callId = content.callId;
      const open = this.#openFor('mcp_call', callId);
      if (open !== undefined) {
        open.item.output = stringifyMcpOutput(content.output);
        yield* this.close();
        return;
      }
      yield* this.close();
      yield* this.#emitClosedItem({
        type: 'custom_tool_call_output',
        id: newId(ID_PREFIX.customToolCallOutput, this.#partitionHint),
        call_id: callId ?? '',
        output: stringifyMcpOutput(content.output),
      });
      return;
    }
    if (content.type === 'search_tool_result') {
      // A search result belongs *on* its call item: the wire carries a web search's outcome
      // inside `action` (already on the item) and a file search's retrieved documents in
      // `results`. There is no standalone wire item for an orphan search result, so one with no
      // matching open call is reported rather than emitted.
      const open = this.#openFor('search_call', content.callId);
      if (open !== undefined) {
        const results = (content.result as { results?: unknown } | null | undefined)?.results;
        if (open.item.type === 'file_search_call' && Array.isArray(results)) {
          open.item.results = results;
        }
        yield* this.close();
        return;
      }
      this.#onUnsupportedContent?.(content);
      return;
    }
    if (content.type === 'code_interpreter_tool_result') {
      // Same shape as a search result: the sandbox's outputs live on the `code_interpreter_call`
      // item itself, and an orphan result has no wire item of its own.
      const open = this.#openFor('code_interpreter_call', content.callId);
      if (open !== undefined) {
        open.item.outputs = codeInterpreterWireOutputs(content.outputs);
        yield* this.close();
        return;
      }
      this.#onUnsupportedContent?.(content);
      return;
    }
    if (content.type === 'image_generation_tool_result') {
      const outputs = content.outputs;
      if (outputs === undefined || outputs === null) {
        // Python maps the result only when `outputs` is present; otherwise it warns and drops.
        this.#onUnsupportedContent?.(content);
        return;
      }
      yield* this.close();
      yield* this.#emitImageGeneration(imageGenerationResult(outputs));
      return;
    }
    if (content.type === 'shell_tool_call') {
      yield* this.close();
      // Item and field shapes per the reference stream's `output_item_function_shell_call`
      // (`shell_call` with a `FunctionShellAction` and a local environment resource).
      yield* this.#emitClosedItem({
        type: 'shell_call',
        id: newId(SHELL_CALL_ID_PREFIX, this.#partitionHint),
        call_id: content.callId ?? '',
        action: {
          commands: content.commands ?? [],
          timeout_ms: content.timeoutMs ?? 0,
          max_output_length: content.maxOutputLength ?? 0,
        },
        environment: { type: 'local' },
        status: content.status ?? 'completed',
      });
      return;
    }
    if (content.type === 'shell_tool_result') {
      const entries: Array<Record<string, unknown>> = [];
      for (const output of content.outputs ?? []) {
        if (output.type === 'shell_command_output') {
          entries.push(shellOutputEntry(output));
        }
      }
      yield* this.close();
      yield* this.#emitClosedItem({
        type: 'shell_call_output',
        id: newId(SHELL_CALL_OUTPUT_ID_PREFIX, this.#partitionHint),
        call_id: content.callId ?? '',
        output: entries,
        status: 'completed',
        max_output_length: content.maxOutputLength ?? 0,
      });
      return;
    }
    if (content.type === 'shell_command_output') {
      // A command output arriving outside a `shell_tool_result` still describes a shell run; it
      // is carried as a single-entry `shell_call_output` rather than dropped. (Python has no
      // standalone mapping — this is the JS extension the parity audit called for.)
      yield* this.close();
      yield* this.#emitClosedItem({
        type: 'shell_call_output',
        id: newId(SHELL_CALL_OUTPUT_ID_PREFIX, this.#partitionHint),
        call_id: '',
        output: [shellOutputEntry(content)],
        status: 'completed',
        max_output_length: 0,
      });
      return;
    }
    const kind = kindOf(content);
    if (kind === undefined) {
      // A content type with no wire representation is not emitted — but no longer invisibly: the
      // drop is reported through `onUnsupportedContent`. The open item is deliberately *not*
      // closed (Python closes it), so an unmapped content interleaved in a text run does not
      // split the message in two.
      this.#onUnsupportedContent?.(content);
      return;
    }
    if (this.#open !== undefined && !this.#canExtend(kind, content)) {
      yield* this.close();
    }
    if (this.#open === undefined) {
      yield* this.#open_(kind, content);
    }
    yield* this.#extend(content);
  }

  /** Whether `content` belongs to the item currently open. */
  #canExtend(kind: ItemKind, content: Content): boolean {
    if (this.#open === undefined || this.#open.kind !== kind) {
      return false;
    }
    if (kind === 'function_call') {
      // Argument fragments only concatenate within one call.
      return this.#open.item.call_id === (content as { callId?: string }).callId;
    }
    if (kind === 'reasoning') {
      // Fragments of one provider reasoning item share its id; a content carrying a *different*
      // id starts a new item (Python: `content.id is not None and content.id != self._active_id`).
      const id = (content as { id?: string }).id;
      return id === undefined || id === this.#open.id;
    }
    // One item per approval request, per search call and per code interpreter run; only message
    // text and MCP-call argument fragments coalesce.
    return kind !== 'mcp_approval_request' && kind !== 'search_call' && kind !== 'code_interpreter_call';
  }

  *#open_(kind: ItemKind, content: Content): Generator<ResponseEvent> {
    const index = this.#index++;
    let item: OutputItem;
    let id: string;

    switch (kind) {
      case 'message':
        id = newId(ID_PREFIX.message, this.#partitionHint);
        item = { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] };
        break;
      case 'function_call': {
        const call = content as { callId: string; name: string };
        id = newId(ID_PREFIX.functionCall, this.#partitionHint);
        item = { type: 'function_call', id, call_id: call.callId, name: call.name, arguments: '' };
        break;
      }
      case 'reasoning': {
        // A valid provider reasoning id is reused, so the item replayed in history carries the id
        // the provider actually issued; only an absent or malformed one gets a fresh `rs_…`
        // (Python `_open_reasoning`: `IdGenerator.is_valid` before minting).
        const providerId = (content as { id?: string }).id;
        id =
          typeof providerId === 'string' && isValidId(providerId)
            ? providerId
            : newId(ID_PREFIX.reasoning, this.#partitionHint);
        item = { type: 'reasoning', id, summary: [], status: 'in_progress' };
        break;
      }
      case 'mcp_call': {
        const call = content as { callId?: string; toolName?: string; serverName?: string };
        // The provider's own call id is in the *model API's* namespace and does not satisfy this
        // protocol's id format, which the platform validates. Reused only when it happens to fit.
        id = isValidId(call.callId) ? (call.callId as string) : newId(ID_PREFIX.mcpCall, this.#partitionHint);
        item = {
          type: 'mcp_call',
          id,
          server_label: call.serverName ?? '',
          name: call.toolName ?? '',
          arguments: '',
          status: 'in_progress',
        };
        break;
      }
      case 'mcp_approval_request': {
        const request = content as FunctionApprovalRequestContent;
        // A hosted (provider-side) MCP approval keeps the provider's own `server_label`, so the
        // human is told *which* server wants to act rather than seeing everything attributed to
        // the framework. Its id is reused too when it fits this protocol's format — then the item
        // replayed in history carries the id the provider actually expects (cf. `mcp_call`).
        const hostedLabel = request.functionCall.additionalProperties?.server_label;
        id = isValidId(request.id) ? request.id : newId(ID_PREFIX.mcpApprovalRequest, this.#partitionHint);
        item = {
          type: 'mcp_approval_request',
          id,
          server_label:
            typeof hostedLabel === 'string' && hostedLabel !== ''
              ? hostedLabel
              : AGENT_FRAMEWORK_SERVER_LABEL,
          name: request.functionCall.name,
          arguments: argumentsText(request.functionCall.arguments),
        };
        // The wire id is the *key* the decision comes back under; the request keeps its own id.
        this.surfacedApprovals.push({ wireId: id, request });
        break;
      }
      case 'search_call': {
        const call = content as {
          callId?: string;
          toolName?: string;
          arguments?: Record<string, unknown> | string;
        };
        const isWeb = call.toolName !== 'file_search';
        // The provider's own call id is reused only when it fits this protocol's id format,
        // like `mcp_call`; the replayed item then carries the id the provider actually issued.
        id = isValidId(call.callId)
          ? (call.callId as string)
          : newId(isWeb ? ID_PREFIX.webSearchCall : ID_PREFIX.fileSearchCall, this.#partitionHint);
        const args = argumentsRecord(call.arguments);
        item = isWeb
          ? { type: 'web_search_call', id, status: 'in_progress', action: args }
          : {
              type: 'file_search_call',
              id,
              status: 'in_progress',
              queries: Array.isArray((args as { queries?: unknown }).queries)
                ? ((args as { queries: unknown[] }).queries as unknown[])
                : [],
            };
        break;
      }
      case 'code_interpreter_call': {
        const call = content as { callId?: string; inputs?: unknown };
        id = isValidId(call.callId)
          ? (call.callId as string)
          : newId(ID_PREFIX.codeInterpreterCall, this.#partitionHint);
        item = {
          type: 'code_interpreter_call',
          id,
          status: 'in_progress',
          code: codeOfInputs(call.inputs),
          outputs: [],
        };
        break;
      }
    }

    this.#open = {
      kind,
      id,
      index,
      item,
      buffer: '',
      ...((kind === 'mcp_call' || kind === 'search_call' || kind === 'code_interpreter_call') &&
      typeof (content as { callId?: string }).callId === 'string'
        ? { callId: (content as { callId?: string }).callId }
        : {}),
    };
    // A snapshot, not the live object: `close()` mutates the item into its finished form, and the
    // `added` event must keep describing the in-progress one it announced (the reference builders
    // emit `status: "in_progress"` on `added` and `"completed"` on `done`).
    yield { type: 'response.output_item.added', output_index: index, item: { ...item } };
    if (kind === 'message') {
      // A message's text lives in a *content part*, and the protocol wants the part opened before
      // any delta arrives (Python's message builder: added → content_part.added → delta …).
      yield {
        type: 'response.content_part.added',
        item_id: id,
        output_index: index,
        content_index: TEXT_CONTENT_INDEX,
        part: emptyTextPart(),
      };
    }
    if (kind === 'reasoning') {
      // A reasoning item's summary lives in a *summary part*, opened the same way (Python
      // `ReasoningSummaryPartBuilder.emit_added`). One part per item: fragments of one provider
      // reasoning item coalesce, so the summary index never moves.
      yield {
        type: 'response.reasoning_summary_part.added',
        item_id: id,
        output_index: index,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      };
    }
  }

  *#extend(content: Content): Generator<ResponseEvent> {
    const open = this.#open;
    if (open === undefined) {
      throw new Error('no item is open to extend');
    }
    switch (open.kind) {
      case 'message': {
        const delta = (content as { text: string }).text;
        if (delta === '') return;
        open.buffer += delta;
        yield {
          type: 'response.output_text.delta',
          item_id: open.id,
          output_index: open.index,
          content_index: TEXT_CONTENT_INDEX,
          delta,
          // Required by the event schema even when nothing asked for log probabilities.
          logprobs: [],
        };
        return;
      }
      case 'function_call': {
        const delta = argumentsText((content as { arguments: Record<string, unknown> | string }).arguments);
        if (delta === '') return;
        open.buffer += delta;
        yield {
          type: 'response.function_call_arguments.delta',
          item_id: open.id,
          output_index: open.index,
          delta,
        };
        return;
      }
      case 'reasoning': {
        // Whichever fragment carries the payload wins the slot — the provider may attach it to
        // any fragment of the item, and a later one supersedes an earlier (Python does the same).
        const encrypted = reasoningEncryptedContent(content as TextReasoningContent);
        if (encrypted !== undefined) {
          open.encryptedContent = encrypted;
        }
        const delta = (content as { text?: string }).text ?? '';
        if (delta === '') return;
        open.buffer += delta;
        yield {
          type: 'response.reasoning_summary_text.delta',
          item_id: open.id,
          output_index: open.index,
          summary_index: 0,
          delta,
        };
        return;
      }
      case 'mcp_call': {
        const delta = argumentsText(
          (content as { arguments?: Record<string, unknown> | string }).arguments ?? '',
        );
        if (delta === '') return;
        open.buffer += delta;
        yield {
          type: 'response.mcp_call_arguments.delta',
          item_id: open.id,
          output_index: open.index,
          delta,
        };
        return;
      }
      case 'mcp_approval_request':
      case 'search_call':
      case 'code_interpreter_call':
        // These carry no incremental payload: an approval request is complete when surfaced, and
        // provider-executed calls arrive whole.
        return;
    }
  }

  /** Closes the open item, if any, emitting its completed form. */
  *close(): Generator<ResponseEvent> {
    const open = this.#open;
    if (open === undefined) {
      return;
    }
    this.#open = undefined;

    switch (open.kind) {
      case 'message':
        open.item.status = 'completed';
        open.item.content = [{ type: 'output_text', text: open.buffer, annotations: [] }];
        // The mirror image of `#open_`: the text is finalized, then its content part, then the
        // item. A consumer that renders from the delta events needs the two `done` events to know
        // the run of text is complete without having to diff the finished item.
        yield {
          type: 'response.output_text.done',
          item_id: open.id,
          output_index: open.index,
          content_index: TEXT_CONTENT_INDEX,
          text: open.buffer,
          logprobs: [],
        };
        yield {
          type: 'response.content_part.done',
          item_id: open.id,
          output_index: open.index,
          content_index: TEXT_CONTENT_INDEX,
          part: { ...emptyTextPart(), text: open.buffer },
        };
        break;
      case 'function_call':
        open.item.arguments = open.buffer;
        yield {
          type: 'response.function_call_arguments.done',
          item_id: open.id,
          output_index: open.index,
          arguments: open.buffer,
        };
        break;
      case 'mcp_call':
        open.item.arguments = open.buffer;
        open.item.status = 'completed';
        // The arguments-done and completed markers precede the item's `done` even when no result
        // content ever arrived — a failed call still finishes its item (Python `_close`:
        // `emit_arguments_done` → `emit_completed` → `emit_done()` with no output).
        yield {
          type: 'response.mcp_call_arguments.done',
          item_id: open.id,
          output_index: open.index,
          arguments: open.buffer,
        };
        yield { type: 'response.mcp_call.completed', item_id: open.id, output_index: open.index };
        break;
      case 'reasoning': {
        // Always exactly one summary part, even when no summary text arrived — the part was
        // opened on `added`, so it has to close (Python `_close`: `emit_text_done(accumulated)` →
        // `emit_done()`, with `summary_texts=[accumulated]` on the item in both cases).
        open.item.summary = [{ type: 'summary_text', text: open.buffer }];
        open.item.status = 'completed';
        if (open.encryptedContent !== undefined) {
          // On the `done` item, where the replay path (`itemToMessage`) reads it back.
          open.item.encrypted_content = open.encryptedContent;
        }
        yield {
          type: 'response.reasoning_summary_text.done',
          item_id: open.id,
          output_index: open.index,
          summary_index: 0,
          text: open.buffer,
        };
        yield {
          type: 'response.reasoning_summary_part.done',
          item_id: open.id,
          output_index: open.index,
          summary_index: 0,
          part: { type: 'summary_text', text: open.buffer },
        };
        break;
      }
      case 'mcp_approval_request':
        break;
      case 'search_call':
      case 'code_interpreter_call':
        // The result (file search documents, sandbox outputs) was attached by `push` before the
        // close; a call whose result never arrived still finishes its item, like `mcp_call`.
        open.item.status = 'completed';
        break;
    }

    yield { type: 'response.output_item.done', output_index: open.index, item: open.item };
  }

  /**
   * Emits a completed tool result as its own item.
   *
   * A `function_call_output` has no incremental form, so it is closed immediately; its `output`
   * goes through {@link encodeFunctionOutput}, which is where the double encoding the wire format
   * requires happens.
   */
  *pushFunctionResult(callId: string, result: unknown): Generator<ResponseEvent> {
    yield* this.close();
    yield* this.#emitClosedItem({
      type: 'function_call_output',
      id: newId(ID_PREFIX.functionCallOutput, this.#partitionHint),
      call_id: callId,
      output: encodeFunctionOutput(result),
    });
  }

  /**
   * Emits an `oauth_consent_request` output item.
   *
   * The wire shape is the reference `OAuthConsentRequestOutputItem`: `consent_link` +
   * `server_label`, id prefix `oacr` (Python `_responses.py`: `IdGenerator.new_id("oacr")`). The
   * handler pairs this with a `response.incomplete` terminal, so the caller knows to send the
   * user to the link and retry.
   */
  *pushOauthConsentRequest(consent: ToolboxConsentRequest): Generator<ResponseEvent> {
    yield* this.close();
    yield* this.#emitClosedItem({
      type: 'oauth_consent_request',
      id: newId(ID_PREFIX.oauthConsentRequest, this.#partitionHint),
      consent_link: consent.consentLink,
      server_label: consent.serverLabel,
    });
  }

  /** An item with no incremental form: `added` and `done` back to back. */
  *#emitClosedItem(item: OutputItem): Generator<ResponseEvent> {
    const index = this.#index++;
    yield { type: 'response.output_item.added', output_index: index, item };
    yield { type: 'response.output_item.done', output_index: index, item };
  }

  /**
   * The image generation lifecycle, as the reference stream emits it
   * (`output_item_image_gen_call`): added → in_progress → generating → completed → done, with the
   * base64 result only on the finished item.
   */
  *#emitImageGeneration(result: string): Generator<ResponseEvent> {
    const index = this.#index++;
    const id = newId(ID_PREFIX.imageGenerationCall, this.#partitionHint);
    yield {
      type: 'response.output_item.added',
      output_index: index,
      item: { type: 'image_generation_call', id, status: 'in_progress', result: '' },
    };
    yield { type: 'response.image_generation_call.in_progress', item_id: id, output_index: index };
    yield { type: 'response.image_generation_call.generating', item_id: id, output_index: index };
    yield { type: 'response.image_generation_call.completed', item_id: id, output_index: index };
    yield {
      type: 'response.output_item.done',
      output_index: index,
      item: { type: 'image_generation_call', id, status: 'completed', result },
    };
  }
}
