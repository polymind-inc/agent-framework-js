import type { Tracer } from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { INSTRUMENTATION_VERSION } from './version.js';

/** Package identity reported on every span this framework emits. */
const TRACER_NAME = '@polymind-inc/agent-framework-core';
const TRACER_VERSION = INSTRUMENTATION_VERSION;

/**
 * The standard opt-in for recording prompts and completions on spans.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
 */
const CAPTURE_ENV = 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT';
/** Python's name for the same switch, honoured so one env var configures a polyglot deployment. */
const CAPTURE_ENV_PYTHON = 'ENABLE_SENSITIVE_DATA';

/** Reads an environment variable without assuming Node; the core is runtime-agnostic. */
function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (env !== undefined) {
    return env[name];
  }
  const deno = (globalThis as { Deno?: { env?: { get(key: string): string | undefined } } }).Deno;
  try {
    return deno?.env?.get(name);
  } catch {
    // Deno without `--allow-env`: treat as unset rather than failing the run.
    return undefined;
  }
}

/** The spellings Python's own environment reader accepts as true, plus their negatives. */
const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off', '']);

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

let explicitCaptureMessageContent: boolean | undefined;

/** Runtime observability configuration. */
export interface ObservabilitySettings {
  /**
   * Record message text, tool arguments and tool results on spans.
   *
   * Off unless opted in. An explicit value here wins over the environment (.NET and Python use the
   * same precedence).
   */
  captureMessageContent?: boolean;
}

/**
 * Configures observability for the process.
 *
 * ## Security considerations
 *
 * `captureMessageContent: true` writes prompts, tool arguments and tool results into your tracing
 * backend verbatim — including anything a user typed, anything a tool returned, and any secret
 * that passed through a message. Enable it in development, or where the backend has the same
 * handling requirements as the conversation itself.
 */
export function configureObservability(settings: ObservabilitySettings): void {
  explicitCaptureMessageContent = settings.captureMessageContent;
}

/** Whether message content may be recorded on spans right now. */
export function captureMessageContent(): boolean {
  if (explicitCaptureMessageContent !== undefined) {
    return explicitCaptureMessageContent;
  }
  return parseBool(readEnv(CAPTURE_ENV)) ?? parseBool(readEnv(CAPTURE_ENV_PYTHON)) ?? false;
}

/**
 * The framework's tracer.
 *
 * With no SDK registered this is the API's no-op tracer, so instrumentation costs a few property
 * reads and nothing is exported.
 */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}
