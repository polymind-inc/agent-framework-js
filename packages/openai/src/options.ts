import type { ChatOptions } from '@polymind-inc/agent-framework-core';

/** Reasoning configuration for the OpenAI Responses API. */
export interface OpenAIReasoningOptions {
  effort?: 'minimal' | 'low' | 'medium' | 'high' | (string & {});
  summary?: 'auto' | 'concise' | 'detailed' | (string & {});
}

/**
 * {@link ChatOptions} plus the OpenAI-specific knobs.
 *
 * Pass this as the `Agent`'s option type to keep provider options fully typed:
 *
 * ```ts
 * const agent = new Agent<OpenAIChatOptions>({ client, ... });
 * await agent.run('...', { options: { reasoning: { effort: 'high' } } });
 * ```
 */
export interface OpenAIChatOptions extends ChatOptions {
  reasoning?: OpenAIReasoningOptions;
  /** Maps to the Responses API `parallel_tool_calls`. */
  parallelToolCalls?: boolean;
  /** Maps to the Responses API `include`. */
  include?: string[];
  /** Maps to the Responses API `truncation`. */
  truncation?: 'auto' | 'disabled';
  /** Maps to `text.verbosity`. */
  verbosity?: 'low' | 'medium' | 'high' | (string & {});
  /** Maps to the Responses API `previous_response_id`; usually set via `conversationId` instead. */
  previousResponseId?: string;
  /**
   * Maps to the Responses API `background`. Prefer the provider-independent
   * `allowBackgroundResponses`; this exists to force the flag on or off directly.
   */
  background?: boolean;
  /**
   * Last-chance escape hatch: rewrite the request body just before it is sent.
   *
   * Use it to reach Responses API features the framework does not model yet.
   */
  rawRequestTransform?: (request: Record<string, unknown>) => Record<string, unknown>;
}
