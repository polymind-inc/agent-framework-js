import type {
  Annotation,
  Content,
  FunctionResultContent,
  Message,
  ResponseFormat,
  Role,
  TextReasoningContent,
  Tool,
  ToolChoice,
} from '@polymind-inc/agent-framework-core';
import {
  ChatClientError,
  isFunctionTool,
  isHostedApproval,
  MESSAGE_SOURCE_KEY,
  resolveResponseFormat,
  topLevelMediaType,
} from '@polymind-inc/agent-framework-core';

/** A Responses API input item, kept loose so unmodelled item types pass through. */
export type ResponsesInputItem = Record<string, unknown>;

function stringifyArguments(args: Record<string, unknown> | string): string {
  return typeof args === 'string' ? args : JSON.stringify(args);
}

/**
 * Renders a tool or model result value as the string a wire field carries.
 *
 * A string passes through, an absent value (`undefined` / `null`) becomes an empty string, and
 * anything else is JSON-encoded — the same shape Python's `Content.from_function_result` and
 * .NET's `EncodeFunctionResultAsJsonStringPayload` give a function result. A value
 * `JSON.stringify` cannot encode — it throws on a cycle or a `BigInt`, and answers `undefined`
 * for a symbol or a function — degrades to `String(value)` instead, mirroring Python's
 * `str(result)` fallback: a wire mapper renders a transcript that already exists, so failing the
 * whole request over one unencodable value is not an option, and the string form still says
 * *something* about what the tool answered.
 *
 * The single implementation of this rendering: the live provider path and the Foundry hosting
 * replay and persist paths all go through it, so they cannot drift apart.
 */
export function stringifyResult(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  const fallback = (): string => {
    try {
      return String(value);
    } catch {
      return '[unserializable]';
    }
  };
  try {
    return JSON.stringify(value) ?? fallback();
  } catch {
    return fallback();
  }
}

/**
 * Renders a hosted-MCP result's `output` into the string `mcp_call.output` field.
 *
 * Mirrors Python `_stringify_mcp_output`: strings pass through, text-bearing entries contribute
 * their text, and anything else is JSON-encoded rather than dropped so the wire payload stays
 * parseable for downstream callers. A payload `JSON.stringify` cannot represent (a symbol, a
 * function) degrades to an empty string rather than leaking `undefined` into the wire field.
 *
 * The single implementation of this rendering: the live provider path here and the Foundry
 * hosting replay path both go through it, so the two cannot drift apart.
 */
export function stringifyMcpOutput(output: unknown): string {
  if (output === undefined || output === null) {
    return '';
  }
  if (typeof output === 'string') {
    return output;
  }
  if (Array.isArray(output)) {
    return output
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }
        const text = (entry as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : JSON.stringify(entry);
      })
      .join('');
  }
  return JSON.stringify(output) ?? '';
}

/** The text-span regions of an annotation that carry valid integer bounds. */
function validSpans(annotation: Annotation): Array<{ startIndex: number; endIndex: number }> {
  const out: Array<{ startIndex: number; endIndex: number }> = [];
  for (const region of annotation.annotatedRegions ?? []) {
    if (
      region.type === 'text_span' &&
      typeof region.startIndex === 'number' &&
      typeof region.endIndex === 'number'
    ) {
      out.push({ startIndex: region.startIndex, endIndex: region.endIndex });
    }
  }
  return out;
}

/**
 * Rebuilds the wire form of the citations on a replayed assistant message.
 *
 * Sending `annotations: []` for a message that had citations quietly drops them from the
 * conversation the model reads back, so a follow-up turn cannot cite what it already cited. The
 * provider's own object is replayed when it is still around; after a session round trip it is not
 * (`rawRepresentation` is deliberately never serialized), so the annotation is reconstructed from
 * the fields the framework does keep.
 *
 * The reconstruction mirrors Python's `_annotations_to_output_text`: the four Responses API
 * citation forms (`container_file_citation` / `url_citation` / `file_citation` / `file_path`) are
 * recovered from `fileId` / `url` / `additionalProperties`, and an annotation with several
 * regions is fanned out into one wire entry per region (the API carries one span per entry).
 */
function toWireAnnotations(annotations: Content['annotations']): ResponsesInputItem[] {
  if (annotations === undefined || annotations.length === 0) {
    return [];
  }
  const out: ResponsesInputItem[] = [];
  for (const annotation of annotations) {
    if (typeof annotation.rawRepresentation === 'object' && annotation.rawRepresentation !== null) {
      out.push(annotation.rawRepresentation as ResponsesInputItem);
      continue;
    }
    if (annotation.type !== 'citation') {
      continue;
    }
    const props = annotation.additionalProperties ?? {};
    const regions = validSpans(annotation);
    const fileId = annotation.fileId;
    const url = annotation.url;
    const containerId = props.container_id;
    const index = props.index;

    if (typeof containerId === 'string' && containerId !== '' && fileId !== undefined && fileId !== '') {
      for (const region of regions) {
        const entry: ResponsesInputItem = {
          type: 'container_file_citation',
          container_id: containerId,
          file_id: fileId,
          start_index: region.startIndex,
          end_index: region.endIndex,
        };
        if (url !== undefined && url !== '') {
          entry.filename = url;
        }
        out.push(entry);
      }
    } else if (
      url !== undefined &&
      url !== '' &&
      (fileId === undefined || fileId === '') &&
      regions.length > 0
    ) {
      for (const region of regions) {
        out.push({
          type: 'url_citation',
          url,
          title: annotation.title ?? '',
          start_index: region.startIndex,
          end_index: region.endIndex,
        });
      }
    } else if (fileId !== undefined && fileId !== '' && url !== undefined && url !== '') {
      const entry: ResponsesInputItem = { type: 'file_citation', file_id: fileId, filename: url };
      if (index !== undefined && index !== null) {
        entry.index = index;
      }
      out.push(entry);
    } else if (fileId !== undefined && fileId !== '') {
      const entry: ResponsesInputItem = { type: 'file_path', file_id: fileId };
      if (index !== undefined && index !== null) {
        entry.index = index;
      }
      out.push(entry);
    }
  }
  return out;
}

/**
 * Maps one {@link Content} item to the Responses API representation used inside a message's
 * `content` array. Returns `undefined` for content that has no input representation.
 *
 * Media handling matches Python `_prepare_content_for_openai`: images become `input_image`,
 * wav/mp3 audio becomes `input_audio`, `application/*` data becomes `input_file`, and anything
 * else (including `text/*` files and unsupported audio codecs) is dropped because the API has no
 * input form for it.
 */
function contentToMessagePart(role: Role, content: Content): ResponsesInputItem | undefined {
  switch (content.type) {
    case 'text':
      // Azure's validator requires `annotations` on assistant output_text items — present, but
      // not necessarily empty.
      return role === 'assistant'
        ? { type: 'output_text', text: content.text, annotations: toWireAnnotations(content.annotations) }
        : { type: 'input_text', text: content.text };
    case 'data':
    case 'uri': {
      const top = topLevelMediaType(content.mediaType);
      if (top === 'image') {
        const detail = content.additionalProperties?.detail;
        // An image the provider already holds is referenced by id rather than re-uploaded; the id
        // survives a session round-trip in `additionalProperties` (Python
        // `_prepare_content_for_openai`).
        const fileId = content.additionalProperties?.file_id;
        // `image_url` is omitted rather than sent empty: the API rejects an empty string outright
        // ("Expected a valid URL"), so a content that carries only a `file_id` would be
        // unsendable. Python always sets it, which works only because its uri is never empty.
        return {
          type: 'input_image',
          ...(content.uri === '' ? {} : { image_url: content.uri }),
          detail: detail ?? 'auto',
          ...(typeof fileId === 'string' && fileId !== '' ? { file_id: fileId } : {}),
        };
      }
      if (top === 'audio') {
        const mediaType = content.mediaType ?? '';
        const format = mediaType.includes('wav') ? 'wav' : mediaType.includes('mp3') ? 'mp3' : undefined;
        if (format === undefined) {
          // The API only accepts wav and mp3; other codecs have no wire form (Python warns and
          // drops them the same way).
          return undefined;
        }
        return { type: 'input_audio', input_audio: { data: content.uri, format } };
      }
      if (top === 'application') {
        const file: ResponsesInputItem = { type: 'input_file', file_data: content.uri };
        if (content.name !== undefined) {
          file.filename = content.name;
        }
        return file;
      }
      return undefined;
    }
    case 'hosted_file':
      // `input_file` is input-only. On an assistant message this content is a citation from a
      // hosted tool, which has no input representation — the text annotations carry it instead.
      return role === 'assistant' ? undefined : { type: 'input_file', file_id: content.fileId };
    default:
      return undefined;
  }
}

/** Collects the `callId`s answered by a `function_result` anywhere in the transcript. */
function answeredCallIds(messages: readonly Message[]): Set<string> {
  const answered = new Set<string>();
  for (const msg of messages) {
    for (const content of msg.contents) {
      if (content.type === 'function_result') {
        answered.add(content.callId);
      }
    }
  }
  return answered;
}

/**
 * Renders a tool result's payload for `function_call_output`.
 *
 * A result carrying images or files goes as content **parts**, so the model sees the image rather
 * than a JSON blob describing it; anything else stays a string. Mirrors Python's
 * `SUPPORTS_RICH_FUNCTION_OUTPUT` branch, including its gate: parts are only used when at least one
 * item is a `data` or `uri` content.
 */
function functionCallOutput(content: FunctionResultContent): string | ResponsesInputItem[] {
  const items = content.items;
  if (items === undefined || !items.some((item) => item.type === 'data' || item.type === 'uri')) {
    return stringifyResult(content.result);
  }
  const parts: ResponsesInputItem[] = [];
  for (const item of items) {
    const part = contentToMessagePart('user', item);
    if (part !== undefined) {
      parts.push(part);
    }
  }
  return parts.length === 0 ? stringifyResult(content.result) : parts;
}

/**
 * The opaque replay payload of a reasoning fragment, wherever it is carried.
 *
 * Providers that support stateless continuation attach an encrypted reasoning payload that must
 * be replayed verbatim. This framework stores it as {@link TextReasoningContent.protectedData};
 * transcripts written by other producers carry it as `additionalProperties.encrypted_content`
 * instead, so both places are read (Python `_reasoning_encrypted_content`). A `protectedData`
 * that is present but unusable (not a string) does not fall through to the copy in
 * `additionalProperties` — the two are not guaranteed to describe the same fragment. Returns
 * `undefined` when no usable payload is present; an empty string counts as absent.
 *
 * The single implementation of this lookup: the provider replay path and the hosted replay path
 * (via the `./internal` entry) both read through it, so they cannot disagree about which
 * fragments are replayable.
 */
export function reasoningEncryptedContent(content: TextReasoningContent): string | undefined {
  const value =
    content.protectedData !== undefined && content.protectedData !== ''
      ? content.protectedData
      : content.additionalProperties?.encrypted_content;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Reconstructs one replayable Responses `reasoning` input item per provider reasoning id.
 *
 * Mirrors Python `_prepare_reasoning_items_for_openai`: fragments are grouped by id, the first
 * opaque payload found wins, `reasoning_text`-marked fragments rebuild the item's `content`,
 * unmarked text rebuilds `summary`, and a `status` marker is carried over. Groups without an
 * opaque payload are not replayable and produce no item.
 */
function prepareReasoningItems(messages: readonly Message[]): Map<string, ResponsesInputItem> {
  const grouped = new Map<string, TextReasoningContent[]>();
  for (const msg of messages) {
    for (const content of msg.contents) {
      if (content.type === 'text_reasoning' && content.id !== undefined && content.id !== '') {
        const group = grouped.get(content.id);
        if (group === undefined) {
          grouped.set(content.id, [content]);
        } else {
          group.push(content);
        }
      }
    }
  }

  const items = new Map<string, ResponsesInputItem>();
  for (const [reasoningId, contents] of grouped) {
    let encrypted: string | undefined;
    for (const content of contents) {
      encrypted = reasoningEncryptedContent(content);
      if (encrypted !== undefined) {
        break;
      }
    }
    if (encrypted === undefined) {
      continue;
    }

    const summary: ResponsesInputItem[] = [];
    const item: ResponsesInputItem = {
      type: 'reasoning',
      id: reasoningId,
      summary,
      encrypted_content: encrypted,
    };
    const reasoningTexts: ResponsesInputItem[] = [];
    for (const content of contents) {
      const props = content.additionalProperties ?? {};
      const status = props.status;
      if (typeof status === 'string' && status !== '') {
        item.status = status;
      }
      const marker = props.reasoning_text;
      if (marker !== undefined && marker !== null && marker !== false && marker !== '' && marker !== 0) {
        const text = marker === true ? content.text : marker;
        if (typeof text === 'string' && text !== '') {
          reasoningTexts.push({ type: 'reasoning_text', text });
        }
      } else if (content.text !== undefined && content.text !== '') {
        summary.push({ type: 'summary_text', text: content.text });
      }
    }
    if (reasoningTexts.length > 0) {
      item.content = reasoningTexts;
    }
    items.set(reasoningId, item);
  }
  return items;
}

/** Compaction group annotation keys, as Python `_compaction` writes them onto the wire. */
const GROUP_ANNOTATION_KEY = '_group';
const GROUP_ID_KEY = 'id';
const GROUP_HAS_REASONING_KEY = 'has_reasoning';

/**
 * Rejects reasoning-bound tool groups that a stateless replay cannot reconstruct.
 *
 * Port of Python `_validate_reasoning_groups_for_stateless_replay`: the Responses API refuses a
 * `function_call` whose reasoning item cannot be replayed alongside it, so failing here with a
 * clear message beats an opaque 400 from the service. Groups are inferred from the message
 * sequence (assistant reasoning → assistant tool calls → tool results) or taken from a
 * compaction `_group` annotation when present.
 */
function validateReasoningGroupsForStatelessReplay(messages: readonly Message[]): void {
  const groupReasoningContents = new Map<string, TextReasoningContent[]>();
  const groupCallIds = new Map<string, string[]>();
  const groupsWithReasoning: string[] = [];
  const seenReasoningGroups = new Set<string>();
  let pendingReasoningGroup: string | undefined;
  let activeToolGroup: string | undefined;

  messages.forEach((message, index) => {
    const rawAnnotation = message.additionalProperties?.[GROUP_ANNOTATION_KEY];
    const annotation =
      typeof rawAnnotation === 'object' && rawAnnotation !== null
        ? (rawAnnotation as Record<string, unknown>)
        : undefined;
    const annotatedGroupId = annotation?.[GROUP_ID_KEY];
    const reasoningContents = message.contents.filter(
      (content): content is TextReasoningContent => content.type === 'text_reasoning',
    );
    const callIds: string[] = [];
    for (const content of message.contents) {
      if (
        (content.type === 'function_call' ||
          content.type === 'function_result' ||
          content.type === 'mcp_server_tool_call' ||
          content.type === 'mcp_server_tool_result') &&
        content.callId !== undefined &&
        content.callId !== ''
      ) {
        callIds.push(content.callId);
      }
    }

    let groupId: string;
    if (typeof annotatedGroupId === 'string') {
      groupId = annotatedGroupId;
    } else if (message.role === 'assistant' && reasoningContents.length > 0 && callIds.length === 0) {
      groupId = pendingReasoningGroup ?? `message_${index}`;
      pendingReasoningGroup = groupId;
    } else if (message.role === 'assistant' && callIds.length > 0) {
      groupId = pendingReasoningGroup ?? `message_${index}`;
      pendingReasoningGroup = undefined;
      activeToolGroup = groupId;
    } else if (message.role === 'tool' && activeToolGroup !== undefined) {
      groupId = activeToolGroup;
    } else {
      groupId = `message_${index}`;
      pendingReasoningGroup = undefined;
      activeToolGroup = undefined;
    }

    if (
      (reasoningContents.length > 0 || annotation?.[GROUP_HAS_REASONING_KEY] === true) &&
      !seenReasoningGroups.has(groupId)
    ) {
      groupsWithReasoning.push(groupId);
      seenReasoningGroups.add(groupId);
    }
    groupReasoningContents.set(groupId, [
      ...(groupReasoningContents.get(groupId) ?? []),
      ...reasoningContents,
    ]);
    groupCallIds.set(groupId, [...(groupCallIds.get(groupId) ?? []), ...callIds]);
  });

  const invalidGroups: string[] = [];
  for (const groupId of groupsWithReasoning) {
    const callIds = [...new Set(groupCallIds.get(groupId) ?? [])];
    if (callIds.length === 0) {
      continue;
    }
    const reasoningContents = groupReasoningContents.get(groupId) ?? [];
    const replayableReasoningIds = new Set<string>();
    for (const content of reasoningContents) {
      if (content.id !== undefined && content.id !== '' && reasoningEncryptedContent(content) !== undefined) {
        replayableReasoningIds.add(content.id);
      }
    }
    const missingReasoningIds = [
      ...new Set(
        reasoningContents
          .filter(
            (content) =>
              content.id === undefined || content.id === '' || !replayableReasoningIds.has(content.id),
          )
          .map((content) =>
            content.id !== undefined && content.id !== '' ? content.id : '<missing provider reasoning id>',
          ),
      ),
    ];
    if (reasoningContents.length === 0) {
      missingReasoningIds.push(`<reasoning item from compacted group ${groupId}>`);
    }
    if (missingReasoningIds.length > 0) {
      invalidGroups.push(
        `reasoning item(s) ${missingReasoningIds.join(', ')} for call(s) ${callIds.join(', ')}`,
      );
    }
  }

  if (invalidGroups.length > 0) {
    throw new ChatClientError(
      `Stateless replay cannot reconstruct ${invalidGroups.join('; ')} because encrypted reasoning ` +
        'content is missing. Use service-side continuation, or exclude each complete reasoning/' +
        'tool-call group from the replayed history.',
    );
  }
}

/** How {@link toResponsesInput} should treat items the service is already holding. */
export interface ResponsesInputOptions {
  /**
   * `true` when the request carries `previous_response_id` / `conversation`, so the service
   * already has every item of the prior response.
   */
  serviceStorage?: boolean;
}

/**
 * Item types that carry a **server-issued identity** and therefore must not be re-sent inline
 * when the request continues a service-managed conversation.
 *
 * The service already has them from the prior response and answers a duplicate with
 * `Duplicate item found with id …` (Python `_prepare_messages_for_openai`, microsoft/
 * agent-framework#3295). `function_call_output` is deliberately absent: it pairs to the stored
 * call by `call_id`, which is the framework's own key, so it is safe — and necessary — to send.
 */
function isServiceHeldItem(type: Content['type']): boolean {
  return (
    type === 'function_call' ||
    type === 'function_approval_request' ||
    type === 'mcp_server_tool_call' ||
    type === 'mcp_server_tool_result' ||
    type === 'text_reasoning'
  );
}

/**
 * Converts framework messages into Responses API input items.
 *
 * Function calls, function results and replayable reasoning become **top-level** items rather
 * than message content, which is what the Responses API expects. Reasoning is reconstructed per
 * provider id from every fragment that shares the id — summaries, reasoning texts and the opaque
 * payload — and only replayed when the payload is present, because summaries alone are not
 * replayable (Python `_prepare_messages_for_openai` / `_prepare_reasoning_items_for_openai`).
 * A reasoning-bound tool group whose payload is missing fails fast with {@link ChatClientError}
 * instead of an opaque service 400.
 *
 * A `function_call` with no matching `function_call_output` is dropped from the request. The loop
 * keeps such orphan calls in the transcript (matching .NET and Go), but the
 * Responses API rejects an input list containing a call it never sees an output for, so the wire
 * boundary is where they are filtered — the same rule Python applies to orphan `mcp_call` results.
 *
 * With `serviceStorage`, everything the service is already holding is filtered out as well; see
 * {@link isServiceHeldItem}.
 */
export function toResponsesInput(
  messages: readonly Message[],
  options: ResponsesInputOptions = {},
): ResponsesInputItem[] {
  const serviceStorage = options.serviceStorage === true;
  let reasoningItems: Map<string, ResponsesInputItem>;
  if (serviceStorage) {
    reasoningItems = new Map();
  } else {
    validateReasoningGroupsForStatelessReplay(messages);
    reasoningItems = prepareReasoningItems(messages);
  }

  const items: ResponsesInputItem[] = [];
  const replayedReasoningIds = new Set<string>();
  const answered = answeredCallIds(messages);
  const pendingMcpOutputs: Array<{ callId: string; output: string }> = [];

  for (const msg of messages) {
    // A message replayed from framework-managed history carries a `_attribution` source marker.
    // Its stored `fc_id` belongs to a prior stored response, so it is not re-sent as a live id
    // (Python `replays_local_storage`).
    const replaysLocalStorage = MESSAGE_SOURCE_KEY in (msg.additionalProperties ?? {});
    const parts: ResponsesInputItem[] = [];
    for (const content of msg.contents) {
      if (serviceStorage && isServiceHeldItem(content.type)) {
        continue;
      }
      switch (content.type) {
        case 'function_call': {
          if (content.callId === '' || !answered.has(content.callId)) {
            break;
          }
          let rawId = content.callId;
          if (!replaysLocalStorage) {
            const liveId = content.additionalProperties?.fc_id;
            if (typeof liveId === 'string' && liveId !== '') {
              rawId = liveId;
            }
          }
          const item: ResponsesInputItem = {
            type: 'function_call',
            call_id: content.callId,
            id: rawId.startsWith('fc_') ? rawId : `fc_${rawId}`,
            name: content.name,
            arguments: stringifyArguments(content.arguments),
          };
          const status = content.additionalProperties?.status;
          if (typeof status === 'string' && status !== '') {
            item.status = status;
          }
          items.push(item);
          break;
        }
        case 'function_result': {
          items.push({
            type: 'function_call_output',
            call_id: content.callId,
            output: functionCallOutput(content),
          });
          break;
        }
        case 'function_approval_request': {
          // A local tool's approval is resolved in-process: the provider never issued a matching
          // approval item, so serializing one would orphan it on the wire.
          if (!isHostedApproval(content)) {
            break;
          }
          // The framework models a hosted MCP approval as an approval request; the Responses API
          // models it as an output item that has to be replayed to keep the pairing.
          items.push({
            type: 'mcp_approval_request',
            id: content.id,
            name: content.functionCall.name,
            arguments: stringifyArguments(content.functionCall.arguments),
            server_label: content.functionCall.additionalProperties?.server_label ?? null,
          });
          break;
        }
        case 'function_approval_response': {
          // Only a hosted decision has a matching approval request on the provider; a local
          // decision replayed as `mcp_approval_response` would reference an id the API never saw.
          if (!isHostedApproval(content)) {
            break;
          }
          items.push({
            type: 'mcp_approval_response',
            approval_request_id: content.id,
            approve: content.approved,
          });
          break;
        }
        case 'mcp_server_tool_call': {
          if (content.callId === undefined || content.callId === '') {
            break;
          }
          items.push({
            type: 'mcp_call',
            id: content.callId,
            server_label: content.serverName ?? '',
            name: content.toolName ?? '',
            arguments: stringifyArguments(content.arguments ?? ''),
          });
          break;
        }
        case 'mcp_server_tool_result': {
          // The API carries an MCP call's arguments and output on one item, so a result cannot be
          // its own input item: it is folded onto the matching call below.
          if (content.callId === undefined || content.callId === '') {
            break;
          }
          pendingMcpOutputs.push({
            callId: content.callId,
            output: stringifyMcpOutput(content.output),
          });
          break;
        }
        case 'text_reasoning': {
          if (content.id === undefined || content.id === '' || replayedReasoningIds.has(content.id)) {
            break;
          }
          const reasoningItem = reasoningItems.get(content.id);
          if (reasoningItem !== undefined) {
            items.push(reasoningItem);
            replayedReasoningIds.add(content.id);
          }
          break;
        }
        default: {
          const part = contentToMessagePart(msg.role, content);
          if (part !== undefined) {
            parts.push(part);
          }
        }
      }
    }
    if (parts.length > 0) {
      items.push({ type: 'message', role: msg.role, content: parts });
    }
  }

  // Fold each MCP result onto its call. An unmatched one is dropped rather than sent: a standalone
  // output item is exactly the orphan shape the API rejects (Python `_coalesce_pending_mcp_results`).
  for (const pending of pendingMcpOutputs) {
    const target = items.findLast((item) => item.type === 'mcp_call' && item.id === pending.callId);
    if (target !== undefined && target.output === undefined) {
      target.output = pending.output;
    }
  }
  return items;
}

/** Converts framework tools into Responses API tool declarations. */
export function toResponsesTools(tools: readonly Tool[] | undefined): ResponsesInputItem[] | undefined {
  if (tools === undefined || tools.length === 0) {
    return undefined;
  }
  const mapped: ResponsesInputItem[] = [];
  for (const candidate of tools) {
    if (!isFunctionTool(candidate)) {
      // Provider-native tool declarations pass straight through.
      const spec = (candidate as { spec?: unknown }).spec;
      mapped.push((spec ?? candidate) as ResponsesInputItem);
      continue;
    }
    mapped.push({
      type: 'function',
      name: candidate.name,
      description: candidate.description,
      // The model must not invent parameters the tool never declared; Python
      // `_prepare_tools_for_openai` forces the same flag onto every function tool schema.
      parameters: { ...candidate.jsonSchema, additionalProperties: false },
      strict: false,
    });
  }
  return mapped;
}

/** Converts a {@link ToolChoice} into the Responses API `tool_choice` value. */
export function toResponsesToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice === undefined) {
    return undefined;
  }
  if (typeof choice === 'string') {
    return choice;
  }
  if (choice.required.length === 1) {
    return { type: 'function', name: choice.required[0] };
  }
  return {
    type: 'allowed_tools',
    mode: 'required',
    tools: choice.required.map((name) => ({ type: 'function', name })),
  };
}

/** Converts a {@link ResponseFormat} into the Responses API `text.format` value. */
export function toResponsesTextFormat(format: ResponseFormat): Record<string, unknown> {
  const resolved = resolveResponseFormat(format);
  const config: Record<string, unknown> = {
    type: 'json_schema',
    name: resolved.name,
    schema: resolved.schema,
    strict: resolved.strict,
  };
  if (resolved.description !== undefined) {
    config.description = resolved.description;
  }
  return config;
}
