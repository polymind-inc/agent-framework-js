import { ChatClientError } from '../errors.js';
import { pipeStream } from '../streaming/response-stream.js';
import type { JsonSchema } from '../tools/json-schema.js';
import { resolveJsonSchema } from '../tools/json-schema.js';
import type { StandardSchemaV1 } from '../tools/standard-schema.js';
import { formatSchemaIssues, isStandardSchema } from '../tools/standard-schema.js';
import { isUserInputRequest } from '../types/content.js';
import type { ResponseBase } from '../types/response.js';
import type {
  ChatClient,
  ChatOptions,
  ChatResponseStream,
  JsonSchemaResponseFormat,
  ResponseFormat,
} from './chat-client.js';

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
 * Normalizes a {@link ResponseFormat} into a JSON Schema plus the metadata providers require.
 *
 * @throws {SchemaResolutionError} When the schema cannot be converted to JSON Schema.
 */
export function resolveResponseFormat(format: ResponseFormat): ResolvedResponseFormat {
  if (typeof format === 'object' && format !== null && !isStandardSchema(format) && isNamedFormat(format)) {
    const resolved: ResolvedResponseFormat = {
      name: format.name ?? 'response',
      schema: resolveJsonSchema(format.schema),
      strict: format.strict ?? true,
    };
    if (format.description !== undefined) {
      resolved.description = format.description;
    }
    return resolved;
  }

  const resolved: ResolvedResponseFormat = {
    name: 'response',
    schema: resolveJsonSchema(format),
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
  const resultCallIds = new Set<string>();
  for (const msg of response.messages) {
    for (const content of msg.contents) {
      if (content.type === 'function_result') {
        resultCallIds.add(content.callId);
      }
    }
  }
  return response.messages.some((msg) =>
    msg.contents.some(
      (content) =>
        isUserInputRequest(content) ||
        (content.type === 'function_call' &&
          content.informationalOnly !== true &&
          !resultCallIds.has(content.callId)),
    ),
  );
}

/**
 * Extracts the first complete top-level JSON object or array from `text`.
 *
 * Mirrors .NET `AgentResponse{T}.DeserializeFirstTopLevelObject` (`AllowMultipleValues`): some
 * model backends emit a second top-level object — or trailing prose — after the structured answer,
 * and the reference implementation reads the first value and ignores the rest. Leading non-JSON
 * text is *not* tolerated, also matching .NET (its reader starts at position zero).
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
  const resolved = resolveResponseFormat(format);
  const text = response.text;
  if (text.trim() === '') {
    throw new ChatClientError('Structured output was requested but the model returned no text.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const first = sliceFirstTopLevelValue(text);
    if (first === undefined) {
      throw new ChatClientError(
        `Structured output was requested but the model returned text that is not valid JSON: ${text.slice(0, 200)}`,
        { cause: error },
      );
    }
    try {
      parsed = JSON.parse(first) as unknown;
    } catch (innerError) {
      throw new ChatClientError(
        `Structured output was requested but the model returned text that is not valid JSON: ${text.slice(0, 200)}`,
        { cause: innerError },
      );
    }
  }

  if (resolved.validator !== undefined) {
    const validation = await resolved.validator['~standard'].validate(parsed);
    if (validation.issues !== undefined) {
      throw new ChatClientError(
        `Structured output failed schema validation: ${formatSchemaIssues(validation.issues)}`,
      );
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
      return pipeStream(inner, {
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
