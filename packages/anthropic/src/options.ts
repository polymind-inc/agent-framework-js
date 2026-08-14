import type { ChatOptions } from '@polymind-inc/agent-framework-core';

/** Extended thinking configuration (maps to Anthropic `thinking`). */
export type AnthropicThinkingOptions =
  | {
      type: 'enabled';
      /** Maps to `budget_tokens`. Minimum 1024, and counted against `maxTokens`. */
      budgetTokens: number;
    }
  | {
      type: 'disabled';
      /** Disabled thinking cannot carry a token budget. */
      budgetTokens?: never;
    };

/**
 * {@link ChatOptions} plus the Anthropic-specific knobs.
 *
 * ```ts
 * const agent = new Agent<AnthropicChatOptions>({ client, ... });
 * await agent.run('...', { options: { thinking: { type: 'enabled', budgetTokens: 2048 } } });
 * ```
 *
 * Messages API has no equivalent for `seed`, `frequencyPenalty`, `presencePenalty`, `store` or
 * `conversationId`; they are ignored rather than rejected, matching how the Python reference
 * implementation (microsoft/agent-framework) types them as unavailable.
 */
export interface AnthropicChatOptions extends ChatOptions {
  /** Maps to `top_k`. */
  topK?: number;
  /** Maps to `service_tier`. */
  serviceTier?: 'auto' | 'standard_only' | (string & {});
  /** Maps to `thinking`. */
  thinking?: AnthropicThinkingOptions;
  /**
   * Additional beta flags to send with the request (`anthropic-beta`).
   *
   * Merged with the always-sent defaults (`DEFAULT_BETA_FLAGS`), matching the Python reference
   * implementation's `additional_beta_flags`.
   */
  betas?: string[];
  /** Maps to `container`, for skills. */
  container?: Record<string, unknown>;
  /**
   * Last-chance escape hatch: rewrite the request body just before it is sent.
   *
   * Use it to reach Messages API features the framework does not model yet.
   */
  rawRequestTransform?: (request: Record<string, unknown>) => Record<string, unknown>;
}
