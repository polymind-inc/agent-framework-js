import { decodeBase64, encodeBase64 } from './base64.js';
import type {
  Content,
  DataContent,
  FunctionCallContent,
  TextContent,
  TextReasoningContent,
} from './content.js';

function mergeAdditionalProperties(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (a === undefined) {
    return b === undefined ? undefined : { ...b };
  }
  if (b === undefined) {
    return { ...a };
  }
  return { ...a, ...b };
}

function withOptionalProps<T extends object>(base: T, props: Record<string, unknown> | undefined): T {
  return props === undefined ? base : { ...base, additionalProperties: props };
}

/**
 * A content item participates in coalescing only when it carries no annotations.
 *
 * Merging annotated items would invalidate their span offsets, so the reference implementations
 * (Go `message.coalesce`) leave them alone.
 */
function coalescable(content: Content): boolean {
  return content.annotations === undefined || content.annotations.length === 0;
}

/**
 * Text is the one exception: an **empty** annotated text item still coalesces.
 *
 * That shape is not a fragment of prose, it is a streamed `output_text.annotation.added` — a
 * citation arriving after the text it points at. Contributing no characters, it cannot move
 * anybody's span offsets, which is the whole reason annotated content is otherwise left alone. So
 * the offset rule is kept and the citation still lands on the run it belongs to, which is what
 * makes a streamed transcript identical to an awaited one (Python merges annotated text
 * unconditionally, Go never does).
 */
function coalescableText(content: Content): boolean {
  return coalescable(content) || (content as TextContent).text === '';
}

function dataUriPayload(uri: string): string {
  const comma = uri.indexOf(',');
  return comma === -1 ? '' : uri.slice(comma + 1);
}

/**
 * Whether a fragment is the model's private reasoning text rather than its public summary.
 *
 * The OpenAI Responses client marks the private text with a `reasoning_text` key (Python
 * `_chat_client.py`, mirrored in `from-openai.ts`); the summary carries no such key. Key presence
 * is what counts, matching Python's `"reasoning_text" in additional_properties`.
 */
function hasReasoningTextMarker(content: TextReasoningContent): boolean {
  const props = content.additionalProperties;
  return props !== undefined && Object.hasOwn(props, 'reasoning_text');
}

/**
 * Reasoning fragments merge while they agree on identity *and* on what kind of reasoning they are.
 *
 * Ported from Python `_add_text_reasoning_content`, which raises `AdditionItemMismatch` — caught by
 * `_coalesce_text_content`, which then starts a new item — when
 *
 * - both ids are non-empty and differ, or
 * - both texts are non-empty and only one side carries the `reasoning_text` marker. The model's
 *   private reasoning text and its public summary arrive under one reasoning id, so without this
 *   they concatenate silently and the merged item inherits the marker, which makes the replay in
 *   `to-openai.ts` (`prepareReasoningItems`) send the summary back as private reasoning text.
 *
 * The test runs against the run's **accumulated** state, not against the previous fragment, because
 * Python folds into `first_new_content`: its id is the first non-empty one in the run and its
 * additional properties are the union of the run's. An id-less or empty fragment therefore cannot
 * bridge two logical items — the same hazard {@link canMergeFunctionCall} guards against.
 *
 * `protectedData` keeps Go's rule (`message.coalesce`): merging is allowed while the run carries no
 * opaque payload, even when the candidate brings one. Python has no equivalent restriction.
 */
function textReasoningRun(head: Content): (next: Content) => boolean {
  const first = head as TextReasoningContent;
  let id = first.id === '' ? undefined : first.id;
  let hasText = (first.text ?? '') !== '';
  let hasMarker = hasReasoningTextMarker(first);
  let protectedData = first.protectedData;
  return (candidate) => {
    const next = candidate as TextReasoningContent;
    const nextId = next.id === '' ? undefined : next.id;
    if (id !== undefined && nextId !== undefined && id !== nextId) {
      return false;
    }
    const nextHasText = (next.text ?? '') !== '';
    const nextHasMarker = hasReasoningTextMarker(next);
    if (hasText && nextHasText && hasMarker !== nextHasMarker) {
      return false;
    }
    if (protectedData !== undefined && protectedData !== '') {
      return false;
    }
    id ??= nextId;
    hasText ||= nextHasText;
    hasMarker ||= nextHasMarker;
    if (next.protectedData !== undefined) {
      protectedData = next.protectedData;
    }
    return true;
  };
}

function canMergeFunctionCall(a: FunctionCallContent, b: FunctionCallContent): boolean {
  // A continuation fragment may omit the call id, but a fragment carrying a non-empty id that
  // differs from — or newly follows — an id-less fragment starts a different call. The check is
  // pairwise, so an id-less fragment must never be allowed to bridge two distinct calls:
  // [id 'x', id '', id 'y'] would otherwise fold y's arguments into x.
  if (b.callId !== '' && a.callId !== b.callId) {
    return false;
  }
  return typeof a.arguments === typeof b.arguments;
}

function canMergeData(a: DataContent, b: DataContent): boolean {
  return (
    a.mediaType.toLowerCase() === b.mediaType.toLowerCase() &&
    a.mediaType.split('/')[0]?.toLowerCase() === 'text' &&
    a.name === b.name &&
    a.uri.startsWith('data:') &&
    b.uri.startsWith('data:')
  );
}

function mergeTextRun(run: TextContent[]): TextContent {
  const first = run[0] as TextContent;
  let text = '';
  let props = first.additionalProperties;
  const annotations: NonNullable<Content['annotations']> = [];
  for (const item of run) {
    text += item.text;
    if (item.annotations !== undefined) {
      annotations.push(...item.annotations);
    }
  }
  for (const item of run.slice(1)) {
    props = mergeAdditionalProperties(props, item.additionalProperties);
  }
  const merged = withOptionalProps<TextContent>({ type: 'text', text }, props);
  // Only an empty annotated item can be in this run (see `coalescableText`), so nothing here
  // shifts the offsets the annotations refer to.
  if (annotations.length > 0) {
    merged.annotations = annotations;
  }
  return merged;
}

function mergeTextReasoningRun(run: TextReasoningContent[]): TextReasoningContent {
  const first = run[0] as TextReasoningContent;
  let text = '';
  let id = first.id;
  let protectedData: string | undefined;
  let props = first.additionalProperties;
  for (const item of run) {
    text += item.text ?? '';
    id ??= item.id;
    if (item.protectedData !== undefined) {
      protectedData = item.protectedData;
    }
  }
  for (const item of run.slice(1)) {
    props = mergeAdditionalProperties(props, item.additionalProperties);
  }
  const merged: TextReasoningContent = { type: 'text_reasoning' };
  if (id !== undefined) {
    merged.id = id;
  }
  if (text !== '') {
    merged.text = text;
  }
  if (protectedData !== undefined) {
    merged.protectedData = protectedData;
  }
  return withOptionalProps(merged, props);
}

function mergeFunctionCallRun(run: FunctionCallContent[]): FunctionCallContent {
  const first = run[0] as FunctionCallContent;
  let args: Record<string, unknown> | string = typeof first.arguments === 'string' ? '' : {};
  let name = '';
  let callId = '';
  let informationalOnly = false;
  let props = first.additionalProperties;
  for (const item of run) {
    if (typeof args === 'string' && typeof item.arguments === 'string') {
      args += item.arguments;
    } else if (typeof args !== 'string' && typeof item.arguments !== 'string') {
      args = { ...args, ...item.arguments };
    }
    name ||= item.name;
    callId ||= item.callId;
    informationalOnly ||= item.informationalOnly === true;
  }
  for (const item of run.slice(1)) {
    props = mergeAdditionalProperties(props, item.additionalProperties);
  }
  const merged: FunctionCallContent = { type: 'function_call', callId, name, arguments: args };
  if (informationalOnly) {
    merged.informationalOnly = true;
  }
  return withOptionalProps(merged, props);
}

function mergeDataRun(run: DataContent[]): DataContent {
  const first = run[0] as DataContent;
  let props = first.additionalProperties;
  // Concatenated with typed-array copies rather than a spread push: spreading a large decoded
  // payload as function arguments overflows the engine's argument limit (~100k elements).
  const parts = run.map((item) => decodeBase64(dataUriPayload(item.uri)));
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  for (const item of run.slice(1)) {
    props = mergeAdditionalProperties(props, item.additionalProperties);
  }
  const merged: DataContent = {
    type: 'data',
    uri: `data:${first.mediaType};base64,${encodeBase64(bytes)}`,
    mediaType: first.mediaType,
  };
  if (first.name !== undefined) {
    merged.name = first.name;
  }
  return withOptionalProps(merged, props);
}

/**
 * Lifts a pairwise merge test into the per-run form {@link Rule.startRun} expects.
 *
 * The predicate keeps the previous accepted item, so the test sees `(prev, candidate)` exactly as
 * Go's `coalesce` does.
 */
function pairwise<T extends Content>(
  canMerge: (a: T, b: T) => boolean,
): (head: Content) => (next: Content) => boolean {
  return (head) => {
    let prev = head as T;
    return (next) => {
      if (!canMerge(prev, next as T)) {
        return false;
      }
      prev = next as T;
      return true;
    };
  };
}

interface Rule {
  matches: (content: Content) => boolean;
  /**
   * Opens a run at `head` and returns its merge test.
   *
   * The predicate is called with each following candidate in order and may keep state, because the
   * accumulating rules (see {@link textReasoningRun}) have to test against what the run has folded
   * so far rather than against the raw predecessor. Omitted when everything merges.
   */
  startRun?: (head: Content) => (next: Content) => boolean;
  merge: (run: Content[]) => Content;
  /** Defaults to {@link coalescable}. */
  coalescable?: (content: Content) => boolean;
}

const RULES: Rule[] = [
  {
    matches: (c) => c.type === 'text',
    coalescable: coalescableText,
    merge: (run) => mergeTextRun(run as TextContent[]),
  },
  {
    matches: (c) => c.type === 'text_reasoning',
    startRun: textReasoningRun,
    merge: (run) => mergeTextReasoningRun(run as TextReasoningContent[]),
  },
  {
    matches: (c) => c.type === 'function_call',
    startRun: pairwise<FunctionCallContent>(canMergeFunctionCall),
    merge: (run) => mergeFunctionCallRun(run as FunctionCallContent[]),
  },
  {
    matches: (c) => c.type === 'data',
    startRun: pairwise<DataContent>(canMergeData),
    merge: (run) => mergeDataRun(run as DataContent[]),
  },
];

function applyRule(contents: Content[], rule: Rule): Content[] {
  const out: Content[] = [];
  const participates = rule.coalescable ?? coalescable;
  let index = 0;
  while (index < contents.length) {
    const head = contents[index] as Content;
    if (!rule.matches(head) || !participates(head)) {
      out.push(head);
      index++;
      continue;
    }
    const accepts = rule.startRun?.(head);
    let end = index + 1;
    while (end < contents.length) {
      const next = contents[end] as Content;
      if (!rule.matches(next) || !participates(next) || (accepts !== undefined && !accepts(next))) {
        break;
      }
      end++;
    }
    // Runs of one are left untouched so that annotations, raw representations and provider
    // metadata on a lone item survive (Go's `mergeSingle = false`).
    out.push(end - index === 1 ? head : rule.merge(contents.slice(index, end)));
    index = end;
  }
  return out;
}

/**
 * Merges adjacent compatible content items.
 *
 * Streaming providers emit content in fragments: text deltas, reasoning deltas and partial
 * function-call argument strings. Coalescing rebuilds the logical items:
 *
 * - consecutive `text` items are concatenated;
 * - consecutive `text_reasoning` items are concatenated when their ids agree and they are the same
 *   kind of reasoning — private text is never concatenated with a summary (see
 *   {@link textReasoningRun});
 * - consecutive `function_call` items are merged (string argument fragments concatenated, object
 *   arguments shallow-merged) when their `callId`s agree;
 * - consecutive textual `data` items with the same media type and name are concatenated.
 *
 * Items carrying {@link Annotation}s are never merged — with one exception, an *empty* annotated
 * text item, which is how a streamed citation arrives (see {@link coalescableText}). A run of a
 * single item is returned unchanged. Matches Go `message.CoalesceContents`.
 *
 * @param contents - The content list to coalesce. Not mutated.
 * @returns A new list.
 */
export function coalesceContents(contents: readonly Content[]): Content[] {
  let result = [...contents];
  for (const rule of RULES) {
    result = applyRule(result, rule);
  }
  return result;
}
