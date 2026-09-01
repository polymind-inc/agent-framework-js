import type {
  Content,
  HostedTool,
  Message,
  ResponseFormat,
  Role,
  Tool,
  ToolChoice,
} from '@polymind-inc/agent-framework-core';
import {
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
 * These contents model an outcome, not a request the caller can make: there is no block to build
 * from their fields, and the result blocks have to go back on the assistant turn that produced
 * them rather than as a `tool_result` answering a call the transcript no longer contains. The
 * block the API sent is replayed instead — the same forward-compatible rule {@link Content} of
 * type `unknown` follows — so an exchange that used code execution survives the next request.
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
 * Converts one framework content item into Messages API blocks.
 *
 * `blocks` is passed in rather than returned because a signature-only `text_reasoning` attaches to
 * the `thinking` block before it instead of producing one of its own (Python
 * `_prepare_message_for_anthropic`).
 */
function appendContent(blocks: AnthropicBlock[], content: Content, answered: ReadonlySet<string>): void {
  const providerExecuted = providerExecutedBlock(content);
  if (providerExecuted !== undefined) {
    blocks.push(providerExecuted);
    return;
  }
  switch (content.type) {
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
      // A call no `function_result` anywhere in the transcript answers is omitted: the Messages
      // API refuses the request outright when a `tool_use` has no `tool_result` — so the choice is
      // not between sending and filtering but between a defined omission and a provider 400. A
      // transcript legitimately holds such a call (an approval pause, the iteration limit, an
      // abandoned stream, a fatal middleware abort, a declaration-only tool), and the OpenAI
      // conversion already filters it the same way, so one rule governs every provider. An empty
      // callId is never a pairable identity and is dropped on the same grounds.
      if (content.callId === '' || !answered.has(content.callId)) {
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
function messageGroups(msg: Message, answered: ReadonlySet<string>): AnthropicMessage[] {
  const fallback = ROLE_MAP[msg.role] ?? 'user';
  const blocks: AnthropicBlock[] = [];
  for (const content of msg.contents) {
    appendContent(blocks, content, answered);
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
 * {@link toAnthropicSystem}). A local `function_call` no result in the transcript answers is
 * omitted — see the `function_call` case in {@link appendContent}. A conversation that would end
 * on an assistant turn gets a synthetic `"Continue"` user turn, because Messages API requires the
 * last message to be a user one — unless that turn still holds a `tool_use` block (a hosted or
 * raw-replayed call), where appending would break the call/result pairing (Python
 * `_prepare_messages_for_anthropic`).
 */
export function toAnthropicMessages(messages: readonly Message[]): AnthropicMessage[] {
  const rest = messages[0]?.role === 'system' ? messages.slice(1) : messages;
  // Collected across the whole transcript, so a call answered in a later message stays a call.
  const answered = answeredCallIds(rest);
  const out: AnthropicMessage[] = [];
  for (const msg of rest) {
    out.push(...messageGroups(msg, answered));
  }
  const last = out[out.length - 1];
  if (last !== undefined && last.role === 'assistant' && !hasToolUse(last)) {
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
