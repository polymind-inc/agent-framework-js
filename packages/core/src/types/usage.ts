/**
 * Token usage reported by a provider.
 *
 * The record is intentionally open: providers may add their own counters (for example
 * `'openai.reasoning_tokens'`) alongside the well-known fields. Every value must be a number so
 * that {@link addUsage} can aggregate the whole record.
 */
export interface UsageDetails {
  /** Number of input (prompt) tokens consumed. */
  inputTokenCount?: number;
  /** Number of output (completion) tokens produced. */
  outputTokenCount?: number;
  /** Total number of tokens, usually `inputTokenCount + outputTokenCount`. */
  totalTokenCount?: number;
  /** Number of input tokens written to a provider-managed cache. */
  cacheCreationInputTokenCount?: number;
  /** Number of input tokens served from a provider-managed cache. */
  cacheReadInputTokenCount?: number;
  /** Number of output tokens spent on reasoning. */
  reasoningOutputTokenCount?: number;
  /** Provider-specific counters. */
  [key: string]: number | undefined;
}

/**
 * Sums two {@link UsageDetails} records key by key.
 *
 * Mirrors Python's `add_usage_details` / Go's `UsageDetails.Add`: keys present in either operand
 * appear in the result, missing values count as `0`, and non-numeric values are skipped rather
 * than throwing.
 *
 * @param a - First operand. May be `undefined`.
 * @param b - Second operand. May be `undefined`.
 * @returns A new record; neither operand is mutated.
 */
export function addUsage(a: UsageDetails | undefined, b: UsageDetails | undefined): UsageDetails {
  if (a === undefined) {
    return b === undefined ? {} : { ...b };
  }
  if (b === undefined) {
    return { ...a };
  }

  const result: UsageDetails = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = a[key];
    const right = b[key];
    if (
      (left !== undefined && typeof left !== 'number') ||
      (right !== undefined && typeof right !== 'number')
    ) {
      continue;
    }
    result[key] = (left ?? 0) + (right ?? 0);
  }
  return result;
}

/** Returns `true` when every counter in `usage` is absent or zero. */
export function isEmptyUsage(usage: UsageDetails | undefined): boolean {
  if (usage === undefined) {
    return true;
  }
  return Object.values(usage).every((value) => value === undefined || value === 0);
}
