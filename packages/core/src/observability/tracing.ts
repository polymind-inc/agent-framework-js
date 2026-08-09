import type { Attributes, AttributeValue, Span } from '@opentelemetry/api';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Content } from '../types/content.js';
import { textContent } from '../types/content.js';
import type { Message } from '../types/message.js';
import type { ChatResponse, ResponseBase } from '../types/response.js';
import type { UsageDetails } from '../types/usage.js';
import { GEN_AI, GEN_AI_MESSAGE_EVENT, GEN_AI_OPERATION, MCP, otelFinishReason } from './attributes.js';
import { captureMessageContent, getTracer } from './settings.js';

/** Sets an attribute only when there is a value, so spans stay free of `undefined` noise. */
export function setAttr(span: Span, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== '') {
    span.setAttribute(key, value as AttributeValue);
  }
}

/** Records token counts under the GenAI usage attribute names. */
export function setUsageAttributes(span: Span, usage: UsageDetails | undefined): void {
  if (usage === undefined) {
    return;
  }
  setAttr(span, GEN_AI.inputTokens, usage.inputTokenCount);
  setAttr(span, GEN_AI.outputTokens, usage.outputTokenCount);
  setAttr(span, GEN_AI.cacheCreationInputTokens, usage.cacheCreationInputTokenCount);
  setAttr(span, GEN_AI.cacheReadInputTokens, usage.cacheReadInputTokenCount);
  setAttr(span, GEN_AI.reasoningOutputTokens, usage.reasoningOutputTokenCount);
}

/** Records what a response reported: id, model, why it stopped, and what it cost. */
export function setResponseAttributes(
  span: Span,
  response: ResponseBase<unknown> & { model?: string },
): void {
  setAttr(span, GEN_AI.responseId, response.responseId);
  setAttr(span, GEN_AI.responseModel, response.model);
  if (response.finishReason !== undefined) {
    span.setAttribute(GEN_AI.finishReasons, [otelFinishReason(response.finishReason)]);
  }
  setUsageAttributes(span, response.usageDetails);
}

/**
 * Serializes messages for the sensitive-data attributes.
 *
 * Only the fields the convention asks for, so a span does not carry provider objects or base64
 * payloads: those belong in the transcript, not in a trace.
 */
/** One part of the sensitive-data serialization: only the field the convention asks for. */
function spanPart(content: Content): { type: string; content?: string } {
  return content.type === 'text' ? { type: 'text', content: content.text } : { type: content.type };
}

/** One message of the sensitive-data serialization, as a JSON object string. */
function serializeMessageForSpan(msg: Message): string {
  return JSON.stringify({ role: msg.role, parts: msg.contents.map(spanPart) });
}

export function serializeMessagesForSpan(messages: readonly Message[]): string {
  return `[${messages.map(serializeMessageForSpan).join(',')}]`;
}

/**
 * Whether message text may be recorded on `span`: the caller opted in, and the span is actually
 * recording (a non-recording span would throw the serialization work away).
 *
 * Every attribute that carries prompt, completion or tool content answers to this one predicate —
 * it is the single place to audit what gates sensitive data.
 */
export function capturesContent(span: Span): boolean {
  return span.isRecording() && captureMessageContent();
}

/**
 * Records prompts and completions, but only when the caller opted in.
 *
 * Two forms, as the conventions ask for: the whole list as one attribute, and one event per
 * message so a backend can render the exchange in order. Both are gated on the same opt-in,
 * because both carry message text.
 */
export function setMessageContent(span: Span, key: string, messages: readonly Message[]): void {
  if (messages.length === 0 || !capturesContent(span)) {
    return;
  }
  // Each message is serialized once; the aggregate attribute and the per-message events share the
  // same strings, so a long transcript pays one serialization pass instead of two.
  const serialized = messages.map(serializeMessageForSpan);
  span.setAttribute(key, `[${serialized.join(',')}]`);
  const output = key === GEN_AI.outputMessages;
  messages.forEach((msg, index) => {
    addMessageEvent(span, msg, output, serialized[index]);
  });
}

/**
 * Records the system instructions, gated the same way as message content — they are prompt text.
 *
 * Serialized as a parts array (`[{ "type": "text", "content": ... }]`), the shape the .NET and
 * Python implementations emit for this attribute, not the bare string.
 */
export function setSystemInstructions(span: Span, instructions: string | undefined): void {
  if (instructions === undefined || instructions === '' || !capturesContent(span)) {
    return;
  }
  span.setAttribute(GEN_AI.systemInstructions, JSON.stringify([spanPart(textContent(instructions))]));
}

/**
 * Adds the per-message event for one message.
 *
 * Python logs these through the logging module, which its OpenTelemetry handler turns into log
 * records; here they are span events, since the logs API is a separate package and the core
 * depends only on `@opentelemetry/api`. The event name and the serialized payload match, so the
 * two implementations produce the same shape.
 */
export function addMessageEvent(span: Span, message: Message, output: boolean, serialized?: string): void {
  const name = output
    ? GEN_AI_MESSAGE_EVENT.choice
    : (GEN_AI_MESSAGE_EVENT[message.role as keyof typeof GEN_AI_MESSAGE_EVENT] ?? GEN_AI_MESSAGE_EVENT.user);
  span.addEvent(name, {
    [GEN_AI.eventName]: name,
    ...(message.role === undefined ? {} : { role: message.role }),
    content: `[${serialized ?? serializeMessageForSpan(message)}]`,
  });
}

/** Marks a span failed and records the error type, matching the GenAI conventions. */
export function recordSpanError(span: Span, error: unknown): void {
  const type = error instanceof Error ? error.name : typeof error;
  span.setAttribute(GEN_AI.errorType, type);
  span.setStatus(
    error instanceof Error
      ? { code: SpanStatusCode.ERROR, message: error.message }
      : { code: SpanStatusCode.ERROR },
  );
  if (error instanceof Error) {
    span.recordException(error);
  }
}

/**
 * The shared skeleton of the `with*Span` helpers: runs `fn` with `span` active, reports a thrown
 * error through `onError`, rethrows it, and ends the span exactly once.
 */
async function runInSpan<T>(
  span: Span,
  fn: (span: Span) => Promise<T>,
  onError: (span: Span, error: unknown) => void,
): Promise<T> {
  try {
    return await context.with(trace.setSpan(context.active(), span), () => fn(span));
  } catch (error) {
    onError(span, error);
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Runs `fn` inside a span, ending it exactly once.
 *
 * The span is the active context for the duration, so anything `fn` starts becomes its child —
 * which is how `chat` and `execute_tool` end up under `invoke_agent`.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return runInSpan(getTracer().startSpan(name, { attributes }), fn, recordSpanError);
}

/**
 * Runs an MCP client call inside a span, per the OTel MCP semantic conventions.
 *
 * The span is named `{method} {target}` (`tools/call get_weather`), carries `mcp.method.name`, and
 * is a CLIENT span because the framework is calling out to an MCP server (Python
 * `create_mcp_client_span`).
 *
 * A tool that reports `isError` is not an exception — the call succeeded and the tool declined —
 * so the convention asks for `error.type = 'tool_error'` instead, which is what
 * {@link setMcpSpanError} records.
 */
export async function withMcpClientSpan<T>(
  method: string,
  target: string | undefined,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = getTracer().startSpan(spanName(method, target), {
    kind: SpanKind.CLIENT,
    attributes: { [MCP.methodName]: method, ...attributes },
  });
  return runInSpan(span, fn, (failed, error) => {
    // A classified failure keeps its convention-defined `error.type`: the exception that carries it
    // out of the callback is how the framework reports it, not what went wrong.
    if (!classified.has(failed)) {
      recordSpanError(failed, error);
    }
  });
}

/** Spans whose `error.type` was set from the convention's vocabulary rather than from an exception. */
const classified = new WeakSet<Span>();

/** Marks an MCP span failed with an `error.type` the convention defines (`tool_error`, …). */
export function setMcpSpanError(span: Span, errorType: string, description?: string): void {
  classified.add(span);
  span.setAttribute(GEN_AI.errorType, errorType);
  span.setStatus(
    description === undefined
      ? { code: SpanStatusCode.ERROR }
      : { code: SpanStatusCode.ERROR, message: description },
  );
}

/**
 * Starts a span the caller is responsible for ending.
 *
 * For work that outlives a single function call — a stream the caller drives at its own pace — the
 * span cannot be scoped to a function body.
 */
export function startSpan(name: string, attributes: Attributes): Span {
  return getTracer().startSpan(name, { attributes });
}

/**
 * Iterates `source` with `span` active, so spans it starts become children of `span`.
 *
 * A lazily-started async generator does not inherit the context its factory was called in: the
 * body only runs on the first `next()`, long after `context.with` has returned. Entering the
 * context around each pull is what actually puts the generator's work inside the span.
 */
export async function* withActiveSpan<T>(span: Span, source: AsyncIterable<T>): AsyncGenerator<T> {
  const ctx = trace.setSpan(context.active(), span);
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const result = await context.with(ctx, () => iterator.next());
      if (result.done === true) {
        return;
      }
      yield result.value;
    }
  } finally {
    // An early `break` upstream has to reach the source, or its own cleanup never runs.
    await context.with(ctx, async () => {
      await iterator.return?.();
    });
  }
}

/**
 * Awaits `value` with `span` active.
 *
 * The `await` happens *inside* the context, not after it: returning a thenable out of
 * `context.with` would leave the scope before anything subscribed to it, so the work it starts
 * would run with no active span.
 */
export function inActiveSpan<T>(span: Span, value: () => PromiseLike<T>): Promise<T> {
  return context.with(trace.setSpan(context.active(), span), async () => value());
}

/** Attributes for the `invoke_agent` span. */
export function agentSpanAttributes(agent: {
  id: string;
  name?: string;
  description?: string;
  providerName?: string;
  model?: string;
  conversationId?: string;
}): Attributes {
  const attributes: Attributes = {
    [GEN_AI.operation]: GEN_AI_OPERATION.invokeAgent,
    [GEN_AI.agentId]: agent.id,
  };
  if (agent.name !== undefined) attributes[GEN_AI.agentName] = agent.name;
  if (agent.description !== undefined) attributes[GEN_AI.agentDescription] = agent.description;
  if (agent.providerName !== undefined) attributes[GEN_AI.providerName] = agent.providerName;
  if (agent.model !== undefined) attributes[GEN_AI.requestModel] = agent.model;
  if (agent.conversationId !== undefined) attributes[GEN_AI.conversationId] = agent.conversationId;
  return attributes;
}

/** The span name convention: `{operation} {target}` (Python `_get_span`). */
export function spanName(operation: string, target: string | undefined): string {
  return target === undefined || target === '' ? operation : `${operation} ${target}`;
}

/** Identifies the agent a run span describes. */
export interface AgentRunSpanInfo {
  id: string;
  name?: string;
  description?: string;
  /** Goes to `gen_ai.provider.name`; lower-case, as the conventions spell provider names. */
  providerName?: string;
  model?: string;
  /** The service-side conversation this run belongs to. */
  conversationId?: string;
}

/**
 * The handle to an in-flight `invoke_agent` span.
 *
 * A run span outlives the call that starts it — it covers the whole exchange, including a stream
 * the caller consumes later — so it is ended by hand rather than around a call.
 */
export interface AgentRunSpan {
  /**
   * Iterates `source` with this span active, so spans started while it runs become its children.
   *
   * Needed for lazily-started generators: their body only runs on the first `next()`, long after
   * the factory returned, so the ambient context has to be re-entered around each pull.
   */
  active<T>(source: AsyncIterable<T>): AsyncIterable<T>;
  /** Awaits `value` with this span active, for a non-streaming call. */
  awaited<T>(value: () => PromiseLike<T>): Promise<T>;
  /** Records what the run produced. Call before {@link AgentRunSpan.end}. */
  setResponse(response: ResponseBase<unknown> & { messages: Message[] }): void;
  /** Records the failure that ended the run. Call before {@link AgentRunSpan.end}. */
  setError(error: unknown): void;
  /** Ends the span. Safe to call more than once; only the first call counts. */
  end(): void;
}

/**
 * Starts the `invoke_agent` span for one agent run.
 *
 * For implementations of the agent contract that do not go through a chat client — a remote
 * protocol client, say — so that they report the same span as the built-in agent does without
 * reproducing the attribute conventions.
 *
 * ```ts
 * const span = startAgentRunSpan({ id, name, providerName: 'a2a' }, inputMessages);
 * try {
 *   for await (const update of span.active(source)) yield update;
 * } catch (error) {
 *   span.setError(error);
 *   throw error;
 * } finally {
 *   span.end();
 * }
 * ```
 *
 * `inputMessages` is recorded only when the caller opted into capturing message content.
 */
export function startAgentRunSpan(
  info: AgentRunSpanInfo,
  inputMessages: readonly Message[] = [],
): AgentRunSpan {
  const span = startSpan(spanName(GEN_AI_OPERATION.invokeAgent, info.name ?? info.id), {
    ...agentSpanAttributes(info),
  });
  setMessageContent(span, GEN_AI.inputMessages, inputMessages);
  let ended = false;
  return {
    active: <T>(source: AsyncIterable<T>): AsyncIterable<T> => withActiveSpan(span, source),
    awaited: <T>(value: () => PromiseLike<T>): Promise<T> => inActiveSpan(span, value),
    setResponse: (response): void => {
      setResponseAttributes(span, response);
      setMessageContent(span, GEN_AI.outputMessages, response.messages);
    },
    setError: (error): void => {
      recordSpanError(span, error);
    },
    end: (): void => {
      if (ended) {
        return;
      }
      ended = true;
      span.end();
    },
  };
}

/** Records the outcome of a chat call on its span. */
export function finishChatSpan(span: Span, response: ChatResponse<unknown>): void {
  setResponseAttributes(span, response);
  setAttr(span, GEN_AI.conversationId, response.conversationId);
  setMessageContent(span, GEN_AI.outputMessages, response.messages);
}
