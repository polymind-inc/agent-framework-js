import { errorMessageOf, StructuredOutputError } from '../errors.js';
import { createResponseStream } from '../streaming/response-stream.js';
import type { JsonSchema } from '../tools/json-schema.js';
import { resolveJsonSchema } from '../tools/json-schema.js';
import type { StandardSchemaResult, StandardSchemaV1 } from '../tools/standard-schema.js';
import { formatSchemaIssues, isStandardSchema } from '../tools/standard-schema.js';
import { isUserInputRequest, textOfContents } from '../types/content.js';
import type { ResponseBase } from '../types/response.js';
import type {
  ChatClient,
  ChatOptions,
  ChatResponseStream,
  JsonSchemaResponseFormat,
  ResponseFormat,
} from './chat-client.js';
import { answeredCallIds, isPendingCall } from './function-invocation.js';
import { updatesOf } from './provider-utils.js';

/** A {@link ResponseFormat} reduced to what a provider request needs. */
export interface ResolvedResponseFormat {
  name: string;
  description?: string;
  schema: JsonSchema;
  strict: boolean;
  /** Present when the caller supplied a Standard Schema, and used to validate the parsed value. */
  validator?: StandardSchemaV1<unknown, unknown>;
}

function isNamedFormat(value: object): value is JsonSchemaResponseFormat {
  const schema = (value as JsonSchemaResponseFormat).schema;
  return typeof schema === 'object' && schema !== null;
}

/**
 * The name to send when the caller did not supply one.
 *
 * A schema written by hand or produced by a schema library usually names itself with a root
 * `title`, and that name is far more useful to a provider — and to anyone reading a trace — than a
 * generic placeholder. Python does the same for the OpenAI response format. The keyword stays on
 * the schema: it is a legal annotation, and removing it would change what the caller declared.
 */
function defaultFormatName(schema: JsonSchema): string {
  const title = schema.title;
  return typeof title === 'string' && title !== '' ? title : 'response';
}

/**
 * Normalizes a {@link ResponseFormat} into a JSON Schema plus the metadata providers require.
 *
 * @throws {SchemaResolutionError} When the schema cannot be converted to JSON Schema.
 */
export function resolveResponseFormat(format: ResponseFormat): ResolvedResponseFormat {
  if (typeof format === 'object' && format !== null && !isStandardSchema(format) && isNamedFormat(format)) {
    const schema = resolveJsonSchema(format.schema);
    const resolved: ResolvedResponseFormat = {
      name: format.name ?? defaultFormatName(schema),
      schema,
      strict: format.strict ?? true,
    };
    if (format.description !== undefined) {
      resolved.description = format.description;
    }
    return resolved;
  }

  const schema = resolveJsonSchema(format);
  const resolved: ResolvedResponseFormat = {
    name: defaultFormatName(schema),
    schema,
    strict: true,
  };
  if (isStandardSchema(format)) {
    resolved.validator = format;
  }
  return resolved;
}

/**
 * `true` when the run stopped before producing its final answer.
 *
 * Three shapes of "not done yet" exist: a `continuationToken` (a background operation is still
 * running), a pending user-input request (`function_approval_request` / `oauth_consent_request` —
 * a human has to act before the loop can continue), and a pending executable `function_call` that
 * has no `function_result` (a declaration-only tool, or an unknown call surfaced by
 * `terminateOnUnknownCalls` — the caller owns the call). None of these responses carry the
 * structured answer yet, so parsing them would turn a legitimate suspension into an error. The
 * reference implementations never hit this because their parse is lazy (.NET
 * `AgentResponse{T}.Result`, Python `AgentResponse.value`); this framework's eager parse has to
 * skip these states explicitly.
 */
function isSuspended(response: ResponseBase<unknown>): boolean {
  if (response.continuationToken !== undefined) {
    return true;
  }
  const resultCallIds = answeredCallIds(response.messages);
  return response.messages.some((msg) =>
    msg.contents.some(
      (content) =>
        isUserInputRequest(content) || (isPendingCall(content) && !resultCallIds.has(content.callId)),
    ),
  );
}

/**
 * The text the structured answer is read from: the last assistant message that says anything.
 *
 * A run that called a tool leaves more than one assistant message behind, and the earlier ones can
 * hold an answer the model then corrected. Reading the whole response as one string puts the first
 * of those ahead of the last, so the caller is handed a superseded value with no way to tell —
 * every field is present and every check passes. The answer is the final one, so that is the only
 * message read.
 *
 * Non-assistant messages are never a source. A tool result is data the model was given, not
 * something it said, and JSON in a tool result is a very ordinary thing to find.
 *
 * Text contents *within* the chosen message still concatenate: one message split across several
 * text parts is one utterance.
 *
 * @returns The message's text, or `undefined` when no assistant message carries any.
 */
function structuredAnswerText(response: ResponseBase<unknown>): string | undefined {
  for (let index = response.messages.length - 1; index >= 0; index--) {
    const message = response.messages[index];
    if (message === undefined || message.role !== 'assistant') {
      continue;
    }
    const text = textOfContents(message.contents);
    if (text.trim() !== '') {
      return text;
    }
  }
  return undefined;
}

/**
 * Extracts the first complete top-level JSON object or array from `text`.
 *
 * Some model backends emit a second top-level object — or trailing prose — after the structured
 * answer, and the first value is the answer. Leading non-JSON text is *not* tolerated: text before
 * the value means the model wrote prose where a bare value was asked for, and guessing which of
 * several values it meant would be a different kind of answer than the one requested.
 *
 * @returns The substring holding the first value, or `undefined` when none can be found.
 */
function sliceFirstTopLevelValue(text: string): string | undefined {
  const start = text.search(/\S/);
  if (start === -1) {
    return undefined;
  }
  const open = text[start];
  if (open !== '{' && open !== '[') {
    return undefined;
  }
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === open) {
      depth++;
    } else if (char === close) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

/**
 * Parses and validates a response's text into {@link ResponseBase.value}.
 *
 * Runs after the whole response is available, so streaming and non-streaming produce the same
 * value (Go's `structuredOutputMiddleware`). The response object is mutated in place.
 *
 * A response that is merely *suspended* — carrying a `continuationToken`, a pending user-input
 * request, or an unexecuted `function_call` the caller owns — is returned unchanged with `value`
 * still `undefined`: the run has not produced its answer yet, and the caller resumes it with the
 * token, the human decision, or the call's result.
 *
 * The same holds for a run the caller *abandoned* (`break` out of the stream), but that state is not
 * visible in the response, so callers pass it in: see {@link StreamResultContext.abandoned}.
 *
 * Only the first top-level JSON value in the text is parsed; trailing content is ignored, matching
 * .NET `AgentResponse{T}.Result` (some backends emit a second object after a function call).
 *
 * @throws {ChatClientError} When the model's output is not valid JSON, or fails schema validation.
 */
export async function applyStructuredOutput<TResponse extends ResponseBase<unknown>>(
  response: TResponse,
  format: ResponseFormat,
): Promise<TResponse> {
  if (isSuspended(response)) {
    return response;
  }

  /**
   * Every failure from here on is the same kind of failure, and carries the same evidence.
   *
   * The response exists and was billed; what went wrong is downstream of it. A caller who catches
   * this needs the model's own words to act — to retry, to show the user, or to hand the output
   * back to the model — and the original throw to diagnose, so both travel: the response by name,
   * the cause on `cause`.
   */
  const failed = (message: string, cause?: unknown): StructuredOutputError =>
    new StructuredOutputError(message, response, cause === undefined ? undefined : { cause });

  let resolved: ResolvedResponseFormat;
  try {
    resolved = resolveResponseFormat(format);
  } catch (error) {
    // The schema is the caller's, and converting it can fail — but only once a response is in
    // hand does that failure lose an answer, so it is reported like the others.
    throw failed(
      `Structured output was requested but its schema could not be resolved: ${errorMessageOf(error)}`,
      error,
    );
  }

  const text = structuredAnswerText(response);
  if (text === undefined) {
    throw failed('Structured output was requested but the model returned no text.');
  }

  const invalidJson = (cause: unknown): StructuredOutputError =>
    failed(
      `Structured output was requested but the model returned text that is not valid JSON: ${text.slice(0, 200)}`,
      cause,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const first = sliceFirstTopLevelValue(text);
    if (first === undefined) {
      throw invalidJson(error);
    }
    try {
      parsed = JSON.parse(first) as unknown;
    } catch (innerError) {
      throw invalidJson(innerError);
    }
  }

  if (resolved.validator !== undefined) {
    let validation: StandardSchemaResult<unknown>;
    try {
      validation = await resolved.validator['~standard'].validate(parsed);
    } catch (error) {
      // A validator may throw or reject instead of reporting issues — an async refinement that
      // calls out and fails, for one. That is still a validation failure, and reporting it as one
      // keeps a single type at this boundary.
      throw failed(`Structured output failed schema validation: ${errorMessageOf(error)}`, error);
    }
    if (validation.issues !== undefined) {
      throw failed(`Structured output failed schema validation: ${formatSchemaIssues(validation.issues)}`);
    }
    parsed = validation.value;
  }

  response.value = parsed;
  return response;
}

/**
 * Wraps a {@link ChatClient} so that `options.responseFormat` populates `response.value`.
 *
 * `Agent` applies the same step itself, so this wrapper is for callers using a chat client
 * directly.
 */
export function withStructuredOutput<TOptions extends ChatOptions>(
  client: ChatClient<TOptions>,
): ChatClient<TOptions> {
  return {
    metadata: client.metadata,
    getResponse(messages, options): ChatResponseStream<unknown> {
      const inner = client.getResponse(messages, options);
      const format = options?.responseFormat;
      if (format === undefined) {
        return inner;
      }
      return createResponseStream({
        start: (ctx) => updatesOf(inner, ctx.stream),
        finalize: async () => inner.finalResponse(),
        // Parsing is a result hook rather than part of `finalize` so it can see whether the caller
        // abandoned the stream: a `break` leaves a truncated answer that was never meant to be a
        // complete one, and the reference implementations parse lazily, so `break` itself must not
        // throw. Same contract as `Agent.run`.
        onResult: [
          async (response, ctx) => (ctx.abandoned ? response : applyStructuredOutput(response, format)),
        ],
      });
    },
  };
}
