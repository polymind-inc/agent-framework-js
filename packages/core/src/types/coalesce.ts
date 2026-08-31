import { decodeBase64, encodeBase64 } from './base64.js';
import type {
  Annotation,
  Content,
  ContentBase,
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

/** The folded `additionalProperties` of a run: the first item's record seeds, later keys win. */
function mergedRunProps(
  run: readonly { additionalProperties?: Record<string, unknown> }[],
): Record<string, unknown> | undefined {
  let props = run[0]?.additionalProperties;
  for (const item of run.slice(1)) {
    props = mergeAdditionalProperties(props, item.additionalProperties);
  }
  return props;
}

function withOptionalProps<T extends object>(base: T, props: Record<string, unknown> | undefined): T {
  return props === undefined ? base : { ...base, additionalProperties: props };
}

/**
 * A content item joins a positional run only when it carries no annotations.
 *
 * Merging annotated items would invalidate their span offsets, so the reference implementations
 * (Go `message.coalesce`) leave them alone. The keyed code-interpreter pass is not gated on this
 * — see {@link coalesceCodeInterpreter} for why its items have no offsets to invalidate.
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
  let text = '';
  const annotations: NonNullable<Content['annotations']> = [];
  for (const item of run) {
    text += item.text;
    if (item.annotations !== undefined) {
      annotations.push(...item.annotations);
    }
  }
  const merged = withOptionalProps<TextContent>({ type: 'text', text }, mergedRunProps(run));
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
  // The first *non-empty* id wins (Python folds ids with `self.id or other.id`, where an empty
  // string is falsy). An id-less run keeps the first fragment's spelling of "no id".
  const id = run.find((item) => item.id !== undefined && item.id !== '')?.id ?? first.id;
  let protectedData: string | undefined;
  for (const item of run) {
    text += item.text ?? '';
    if (item.protectedData !== undefined) {
      protectedData = item.protectedData;
    }
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
  return withOptionalProps(merged, mergedRunProps(run));
}

function mergeFunctionCallRun(run: FunctionCallContent[]): FunctionCallContent {
  const first = run[0] as FunctionCallContent;
  let args: Record<string, unknown> | string = typeof first.arguments === 'string' ? '' : {};
  let name = '';
  let callId = '';
  let informationalOnly = false;
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
  const merged: FunctionCallContent = { type: 'function_call', callId, name, arguments: args };
  if (informationalOnly) {
    merged.informationalOnly = true;
  }
  return withOptionalProps(merged, mergedRunProps(run));
}

function mergeDataRun(run: DataContent[]): DataContent {
  const first = run[0] as DataContent;
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
  const merged: DataContent = {
    type: 'data',
    uri: `data:${first.mediaType};base64,${encodeBase64(bytes)}`,
    mediaType: first.mediaType,
  };
  if (first.name !== undefined) {
    merged.name = first.name;
  }
  return withOptionalProps(merged, mergedRunProps(run));
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

/**
 * The two code-interpreter contents, seen through the fields the keyed pass merges.
 *
 * `inputs` belongs to the call and `outputs` to the result; one shape covers both because the
 * merge rule is identical on either side and each field is folded only when a fragment has it.
 */
interface CodeInterpreterFragment extends ContentBase {
  type: 'code_interpreter_tool_call' | 'code_interpreter_tool_result';
  callId?: string;
  inputs?: Content[];
  outputs?: Content[];
}

function isCodeInterpreter(content: Content): content is CodeInterpreterFragment {
  return content.type === 'code_interpreter_tool_call' || content.type === 'code_interpreter_tool_result';
}

/**
 * What correlates two code-interpreter fragments, or `undefined` when nothing does.
 *
 * The provider's own call id wins; a streamed fragment that carries none is keyed by the
 * `item_id` its provider metadata reports, which is what a Responses-style
 * `code_interpreter_call_code.delta` puts there. An empty or non-string value names no call, so
 * the fragment is left alone rather than folded into whichever fragment happens to be keyless
 * too (Python `_code_interpreter_key`).
 */
function codeInterpreterKey(content: CodeInterpreterFragment): string | undefined {
  const callId = content.callId;
  const key = callId === undefined || callId === '' ? content.additionalProperties?.item_id : callId;
  return typeof key === 'string' && key !== '' ? key : undefined;
}

/** The concatenated text of `items`, or `undefined` when they are not all text. */
function contentItemsText(items: readonly Content[]): string | undefined {
  let text = '';
  for (const item of items) {
    if (item.type !== 'text') {
      return undefined;
    }
    text += item.text;
  }
  return text;
}

/**
 * Folds one streamed `inputs` or `outputs` list into what the run has accumulated.
 *
 * The shape of the list decides how. A text-only list is one growing string, so when either side
 * is a prefix of the other the longer side wins outright: a `done` event repeats the whole code
 * its deltas spelled out, and appending that would put the program in twice. Only genuinely
 * disjoint text is concatenated. Any other list — logs next to a generated image — is appended,
 * because those are separate results rather than fragments of one.
 *
 * Ported from Python `_merge_content_item_lists`. Go takes the other route for this merge
 * (`message.CoalesceContents` concatenates the lists and re-runs itself over them).
 */
function mergeContentItemLists(
  existing: Content[] | undefined,
  incoming: Content[] | undefined,
): Content[] | undefined {
  if (incoming === undefined) {
    return existing;
  }
  if (existing === undefined) {
    return incoming;
  }
  const existingText = contentItemsText(existing);
  const incomingText = contentItemsText(incoming);
  if (existingText !== undefined && incomingText !== undefined) {
    if (incomingText.startsWith(existingText)) {
      return incoming;
    }
    if (existingText.startsWith(incomingText)) {
      return existing;
    }
    // Disjoint text: keep the first item's metadata and give it the joined string. `existing` is
    // non-empty here — an empty list has empty text, which is a prefix of everything.
    return [{ ...(existing[0] as TextContent), text: existingText + incomingText }];
  }
  return [...existing, ...incoming];
}

function combineAnnotations(
  a: Annotation[] | undefined,
  b: Annotation[] | undefined,
): Annotation[] | undefined {
  if (a === undefined) {
    return b;
  }
  return b === undefined ? a : [...a, ...b];
}

/**
 * Folds `incoming` into the fragment that opened the run.
 *
 * The first fragment's remaining fields are kept as they are — its `callId`, and its
 * `rawRepresentation`, which stays the provider object this call was first seen as (Go keeps the
 * first item's header for the same merge; Python accumulates a list, a shape this framework does
 * not give `rawRepresentation`, which it neither serializes nor compares).
 */
function mergeCodeInterpreter(
  existing: CodeInterpreterFragment,
  incoming: CodeInterpreterFragment,
): CodeInterpreterFragment {
  const merged: CodeInterpreterFragment = { ...existing };
  const inputs = mergeContentItemLists(existing.inputs, incoming.inputs);
  if (inputs !== undefined) {
    merged.inputs = inputs;
  }
  const outputs = mergeContentItemLists(existing.outputs, incoming.outputs);
  if (outputs !== undefined) {
    merged.outputs = outputs;
  }
  const annotations = combineAnnotations(existing.annotations, incoming.annotations);
  if (annotations !== undefined) {
    merged.annotations = annotations;
  }
  const props = mergeAdditionalProperties(existing.additionalProperties, incoming.additionalProperties);
  if (props !== undefined) {
    merged.additionalProperties = props;
  }
  return merged;
}

/**
 * Merges code-interpreter call and result fragments that name the same call.
 *
 * This one is keyed rather than positional: a provider interleaves the code it is running with
 * the text it is narrating, so the fragments of one call are not adjacent and the run-based rules
 * would never see them together. Each key's fragments fold into the first one, which keeps its
 * place in the transcript, and fragments naming different calls — or naming nothing — stay
 * separate. Ported from Python `_coalesce_code_interpreter_content`.
 *
 * Unlike every other rule here, an annotated fragment still merges: these items carry no text of
 * their own, so there are no span offsets for a merge to invalidate, and Python concatenates the
 * annotations onto the folded item.
 */
function coalesceCodeInterpreter(contents: Content[]): Content[] {
  const out: Content[] = [];
  // Content type, then call id, to the index the first fragment with that key took in `out`: a
  // call and a result naming one id are two separate items, so the type is part of the key.
  const firstOfKey = new Map<string, Map<string, number>>();
  for (const content of contents) {
    if (!isCodeInterpreter(content)) {
      out.push(content);
      continue;
    }
    const key = codeInterpreterKey(content);
    if (key === undefined) {
      out.push(content);
      continue;
    }
    let byKey = firstOfKey.get(content.type);
    if (byKey === undefined) {
      byKey = new Map();
      firstOfKey.set(content.type, byKey);
    }
    const at = byKey.get(key);
    if (at === undefined) {
      // A fragment nothing joins is left exactly as it arrived, like a run of one above.
      byKey.set(key, out.length);
      out.push(content);
      continue;
    }
    out[at] = mergeCodeInterpreter(out[at] as CodeInterpreterFragment, content);
  }
  return out;
}

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
 * Merges compatible content items back into the logical items a provider streamed as fragments.
 *
 * Most rules are positional — text deltas, reasoning deltas and partial function-call argument
 * strings arrive back to back:
 *
 * - consecutive `text` items are concatenated;
 * - consecutive `text_reasoning` items are concatenated when their ids agree and they are the same
 *   kind of reasoning — private text is never concatenated with a summary (see
 *   {@link textReasoningRun});
 * - consecutive `function_call` items are merged (string argument fragments concatenated, object
 *   arguments shallow-merged) when their `callId`s agree;
 * - consecutive textual `data` items with the same media type and name are concatenated.
 *
 * Items carrying {@link Annotation}s are never merged by those rules — with one exception, an
 * *empty* annotated text item, which is how a streamed citation arrives (see
 * {@link coalescableText}). A positional run of a single item is returned unchanged. Matches Go
 * `message.CoalesceContents`.
 *
 * Code-interpreter fragments are keyed instead: `code_interpreter_tool_call` and
 * `code_interpreter_tool_result` items naming the same call — by `callId`, or by
 * `additionalProperties.item_id` when the provider streams no call id — fold into the first of
 * them wherever it sits, even with narration in between (see {@link coalesceCodeInterpreter}).
 *
 * @param contents - The content list to coalesce. Not mutated.
 * @returns A new list.
 */
export function coalesceContents(contents: readonly Content[]): Content[] {
  let result = [...contents];
  for (const rule of RULES) {
    result = applyRule(result, rule);
  }
  return coalesceCodeInterpreter(result);
}
