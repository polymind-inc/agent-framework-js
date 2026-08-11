import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureMessageContent, configureObservability } from './settings.js';

const OTEL_ENV = 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT';
const PYTHON_ENV = 'ENABLE_SENSITIVE_DATA';

// Message content is sensitive; recording it is off unless the process opts in, either in code or
// through the OTel GenAI env var (with Python's name honoured for polyglot deployments).
describe('captureMessageContent', () => {
  beforeEach(() => {
    // The process running the tests may itself have opted in; every case here starts from the
    // documented default of "unset", not from whatever the environment happens to carry.
    vi.stubEnv(OTEL_ENV, undefined);
    vi.stubEnv(PYTHON_ENV, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    configureObservability({});
  });

  it('is off by default', () => {
    expect(captureMessageContent()).toBe(false);
  });

  it('lets an explicit setting win over the environment, in both directions', () => {
    vi.stubEnv(OTEL_ENV, 'true');
    configureObservability({ captureMessageContent: false });
    expect(captureMessageContent()).toBe(false);

    vi.stubEnv(OTEL_ENV, 'false');
    configureObservability({ captureMessageContent: true });
    expect(captureMessageContent()).toBe(true);
  });

  it('accepts the boolean spellings of the OTel env var', () => {
    for (const [value, expected] of [
      ['true', true],
      ['1', true],
      ['YES', true],
      ['false', false],
      ['0', false],
      ['no', false],
      ['on', true],
      ['off', false],
      ['', false],
      ['  True  ', true],
    ] as const) {
      vi.stubEnv(OTEL_ENV, value);
      expect(captureMessageContent(), `value ${JSON.stringify(value)}`).toBe(expected);
    }
  });

  // Python's own reader accepts `on`, so a deployment that sets one variable for a polyglot
  // fleet has to be read the same way here or the opt-in silently applies to only half of it.
  it('accepts every spelling Python accepts for the Python-named env var', () => {
    for (const [value, expected] of [
      ['true', true],
      ['1', true],
      ['yes', true],
      ['on', true],
      ['ON', true],
      ['off', false],
      ['false', false],
    ] as const) {
      vi.stubEnv(PYTHON_ENV, value);
      expect(captureMessageContent(), `value ${JSON.stringify(value)}`).toBe(expected);
    }
  });

  it('falls back to the Python-named env var when the OTel one is unset or unparsable', () => {
    vi.stubEnv(PYTHON_ENV, 'true');
    expect(captureMessageContent()).toBe(true);

    vi.stubEnv(OTEL_ENV, 'definitely');
    expect(captureMessageContent()).toBe(true);
  });

  it('lets a parsable OTel value shadow the Python-named one', () => {
    vi.stubEnv(OTEL_ENV, 'false');
    vi.stubEnv(PYTHON_ENV, 'true');
    expect(captureMessageContent()).toBe(false);
  });

  it('treats an unparsable value in both variables as off', () => {
    vi.stubEnv(OTEL_ENV, 'definitely');
    vi.stubEnv(PYTHON_ENV, 'maybe');
    expect(captureMessageContent()).toBe(false);
  });
});
