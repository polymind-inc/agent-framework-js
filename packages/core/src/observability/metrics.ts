import type { Attributes, Histogram, Meter } from '@opentelemetry/api';
import { metrics } from '@opentelemetry/api';
import type { UsageDetails } from '../types/usage.js';
import { GEN_AI } from './attributes.js';
import { INSTRUMENTATION_VERSION } from './version.js';

/** Package identity reported on every metric this framework emits. */
const METER_NAME = '@polymind-inc/agent-framework-core';
const METER_VERSION = INSTRUMENTATION_VERSION;

/**
 * Bucket boundaries for `gen_ai.client.token.usage`.
 *
 * Matched to Python's `TOKEN_USAGE_BUCKET_BOUNDARIES` so histograms from the TypeScript and Python
 * implementations aggregate into the same buckets.
 */
export const TOKEN_USAGE_BUCKET_BOUNDARIES: readonly number[] = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
];

/** Bucket boundaries for `gen_ai.client.operation.duration`, in seconds (Python parity). */
export const OPERATION_DURATION_BUCKET_BOUNDARIES: readonly number[] = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
];

/**
 * The framework's meter.
 *
 * With no SDK registered this is the API's no-op meter, so instrumentation costs a few property
 * reads and nothing is exported — the same contract as {@link getTracer}.
 */
function getMeter(): Meter {
  return metrics.getMeter(METER_NAME, METER_VERSION);
}

/**
 * The histograms are created lazily and cached.
 *
 * A meter created before the SDK is registered hands back no-op instruments forever, so the cache
 * is keyed on the meter itself: registering an SDK later replaces the meter, and the next call
 * builds real instruments against it.
 */
let cache: { meter: Meter; tokenUsage: Histogram; operationDuration: Histogram } | undefined;

function histograms(): { tokenUsage: Histogram; operationDuration: Histogram } {
  const meter = getMeter();
  if (cache?.meter !== meter) {
    cache = {
      meter,
      tokenUsage: meter.createHistogram(GEN_AI_METRICS.tokenUsage, {
        unit: 'tokens',
        description: 'Captures the token usage of chat clients',
        advice: { explicitBucketBoundaries: [...TOKEN_USAGE_BUCKET_BOUNDARIES] },
      }),
      operationDuration: meter.createHistogram(GEN_AI_METRICS.operationDuration, {
        unit: 's',
        description: 'Captures the duration of operations of function-invoking chat clients',
        advice: { explicitBucketBoundaries: [...OPERATION_DURATION_BUCKET_BOUNDARIES] },
      }),
    };
  }
  return cache;
}

/** GenAI metric names (Python `OtelAttr.LLM_*`). */
export const GEN_AI_METRICS = {
  tokenUsage: 'gen_ai.client.token.usage',
  operationDuration: 'gen_ai.client.operation.duration',
} as const;

/** The `gen_ai.token.type` dimension of the token-usage histogram. */
const TOKEN_TYPE = { input: 'input', output: 'output' } as const;

/**
 * The span attributes that also become metric dimensions.
 *
 * Deliberately narrow: a histogram dimension has to be low-cardinality, so temperature, ids and
 * message content stay on the span (Python `GEN_AI_METRIC_ATTRIBUTES`).
 */
const METRIC_ATTRIBUTES: readonly string[] = [
  GEN_AI.operation,
  GEN_AI.providerName,
  GEN_AI.requestModel,
  GEN_AI.responseModel,
  'server.address',
  'server.port',
];

/** Keeps only the dimensions a metric may carry. */
function metricDimensions(attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const key of METRIC_ATTRIBUTES) {
    const value = attributes[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** What one model call reported, for the metric layer. */
export interface ChatMetricSample {
  /** Span attributes of the call; the low-cardinality subset becomes the metric dimensions. */
  attributes: Attributes;
  usage?: UsageDetails | undefined;
  /** Wall-clock duration of the call, in **seconds** (the convention's unit). */
  durationSeconds?: number | undefined;
  /** `error.type` when the call failed. Recorded on the duration histogram only. */
  errorType?: string | undefined;
}

/**
 * Records the GenAI client metrics for one model call.
 *
 * Two histograms, matching Python's `_capture_response`: token usage split by
 * `gen_ai.token.type`, and operation duration, which also carries `error.type` when the call
 * failed so success and failure latencies can be told apart.
 */
export function recordChatMetrics(sample: ChatMetricSample): void {
  const dimensions = metricDimensions(sample.attributes);
  const { tokenUsage, operationDuration } = histograms();

  const input = sample.usage?.inputTokenCount;
  if (input !== undefined) {
    tokenUsage.record(input, { ...dimensions, [GEN_AI.tokenType]: TOKEN_TYPE.input });
  }
  const output = sample.usage?.outputTokenCount;
  if (output !== undefined) {
    tokenUsage.record(output, { ...dimensions, [GEN_AI.tokenType]: TOKEN_TYPE.output });
  }
  if (sample.durationSeconds !== undefined) {
    operationDuration.record(sample.durationSeconds, {
      ...dimensions,
      ...(sample.errorType === undefined ? {} : { [GEN_AI.errorType]: sample.errorType }),
    });
  }
}
