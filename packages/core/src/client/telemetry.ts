import type { Attributes, Span } from '@opentelemetry/api';
import { GEN_AI, GEN_AI_OPERATION } from '../observability/attributes.js';
import { recordChatMetrics } from '../observability/metrics.js';
import {
  addMessageEvents,
  finishChatSpan,
  inActiveSpan,
  recordSpanError,
  responseFinishReason,
  setMessageContent,
  setSystemInstructions,
  spanName,
  startSpan,
  withActiveSpan,
} from '../observability/tracing.js';
import { createResponseStream } from '../streaming/response-stream.js';
import type { Message } from '../types/message.js';
import type { ChatResponse, ChatResponseUpdate } from '../types/response.js';
import { chatResponseToUpdates, mergeChatUpdates } from '../types/response.js';
import type { ChatClient, ChatClientMetadata, ChatOptions, ChatResponseStream } from './chat-client.js';

function requestAttributes(metadata: ChatClientMetadata, options: ChatOptions | undefined): Attributes {
  const attributes: Attributes = {
    [GEN_AI.operation]: GEN_AI_OPERATION.chat,
    [GEN_AI.providerName]: metadata.providerName,
  };
  const model = options?.model ?? metadata.modelId;
  if (model !== undefined) attributes[GEN_AI.requestModel] = model;
  if (options?.temperature !== undefined) attributes[GEN_AI.temperature] = options.temperature;
  if (options?.topP !== undefined) attributes[GEN_AI.topP] = options.topP;
  if (options?.maxTokens !== undefined) attributes[GEN_AI.maxTokens] = options.maxTokens;
  if (options?.seed !== undefined) attributes[GEN_AI.seed] = options.seed;
  if (options?.frequencyPenalty !== undefined) {
    attributes[GEN_AI.frequencyPenalty] = options.frequencyPenalty;
  }
  if (options?.presencePenalty !== undefined) attributes[GEN_AI.presencePenalty] = options.presencePenalty;
  if (options?.stop !== undefined) {
    attributes[GEN_AI.stopSequences] = typeof options.stop === 'string' ? [options.stop] : options.stop;
  }
  if (options?.conversationId !== undefined) attributes[GEN_AI.conversationId] = options.conversationId;
  if (options?.responseFormat !== undefined) attributes[GEN_AI.outputType] = 'json';
  return attributes;
}

/**
 * Wraps a {@link ChatClient} so every model call produces a GenAI `chat` span.
 *
 * ## Placement
 *
 * This layer belongs **inside** the function-calling loop, so the composition is
 * `withFunctionInvocation(withChatTelemetry(raw))`. Each round then gets its own `chat` span that
 * closes before the tools of that round run, and `execute_tool` spans become siblings of the chat
 * that requested them rather than children of a span that is still open — the same reason .NET
 * places `DeferredOpenTelemetryChatClient` there.
 *
 * With no OpenTelemetry SDK registered the API hands back no-op spans, so this costs a few
 * property writes and exports nothing.
 *
 * ## Security considerations
 *
 * Message text is recorded only when {@link configureObservability} or
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` turns it on. Everything else on the span is
 * metadata: model, token counts, finish reason.
 */
export function withChatTelemetry<TOptions extends ChatOptions>(
  client: ChatClient<TOptions>,
): ChatClient<TOptions> {
  return {
    metadata: client.metadata,
    getResponse(
      messages: Message[],
      options?: TOptions & { signal?: AbortSignal },
    ): ChatResponseStream<unknown> {
      const attributes = requestAttributes(client.metadata, options);
      const name = spanName(GEN_AI_OPERATION.chat, options?.model ?? client.metadata.modelId);

      // The span is started on first consumption — inside `run`, not here — because constructing
      // a stream has no side effects: an unconsumed stream must not leave an
      // unended span behind. It is ended in `cleanup` / `onResult`, because a streamed call is not
      // over when `getResponse` returns — it is over when the caller stops pulling from it.
      let span: Span | undefined;
      let failure: unknown;
      let folded: ChatResponse<unknown> | undefined;
      let ended = false;
      let startedAt: number | undefined;
      // The metric dimensions have to describe the call as it actually ran, so the response model
      // is folded in when the response arrives.
      const metricAttributes: Attributes = { ...attributes };

      const endSpan = (): void => {
        if (ended || span === undefined) {
          return;
        }
        ended = true;
        if (failure !== undefined) {
          recordSpanError(span, failure);
        }
        span.end();
        recordChatMetrics({
          attributes: metricAttributes,
          usage: folded?.usageDetails,
          ...(startedAt === undefined ? {} : { durationSeconds: (performance.now() - startedAt) / 1000 }),
          ...(failure === undefined
            ? {}
            : { errorType: failure instanceof Error ? failure.name : typeof failure }),
        });
      };

      const run = async function* (stream: boolean): AsyncGenerator<ChatResponseUpdate> {
        const chatSpan = startSpan(name, attributes);
        span = chatSpan;
        startedAt = performance.now();
        setMessageContent(chatSpan, GEN_AI.inputMessages, messages);
        setSystemInstructions(chatSpan, options?.instructions);
        addMessageEvents(chatSpan, {
          providerName: client.metadata.providerName,
          messages,
          ...(options?.instructions === undefined ? {} : { instructions: options.instructions }),
        });
        try {
          // Inside the `try`: a client that rejects the call synchronously — a bad model name, a
          // missing key — would otherwise leave this span open and unrecorded, because the failure
          // never reaches the handler that ends it.
          const inner = client.getResponse(messages, options);
          if (stream) {
            // The provider call runs under this span, so provider-level instrumentation nests.
            yield* withActiveSpan(chatSpan, inner);
          } else {
            const response = await inActiveSpan(chatSpan, () => inner);
            folded = response;
            yield* chatResponseToUpdates(response);
          }
        } catch (error) {
          failure = error;
          throw error;
        }
      };

      return createResponseStream<ChatResponseUpdate, ChatResponse<unknown>>({
        start: (ctx: { stream: boolean }) => run(ctx.stream),
        finalize: (updates: ChatResponseUpdate[]) => folded ?? mergeChatUpdates<unknown>(updates),
        cleanup: [
          (cleanupFailure?: unknown): void => {
            // Cleanup runs *before* finalization, so on a successful stream the span has to stay
            // open long enough for `onResult` to record what the response reported. The hook's
            // `failure` parameter covers deaths the generator never sees — an abort between pulls
            // or a consumer `iterator.throw()` — where `onResult` will never run.
            failure ??= cleanupFailure;
            if (failure !== undefined) {
              endSpan();
            }
          },
        ],
        onResult: [
          (response: ChatResponse<unknown>): void => {
            folded = response;
            if (response.model !== undefined) {
              metricAttributes[GEN_AI.responseModel] = response.model;
            }
            if (failure === undefined && span !== undefined) {
              finishChatSpan(span, response);
              const finishReason = responseFinishReason(response);
              addMessageEvents(span, {
                providerName: client.metadata.providerName,
                messages: response.messages,
                output: true,
                ...(finishReason === undefined ? {} : { finishReason }),
              });
            }
            endSpan();
          },
        ],
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
    },
  };
}
