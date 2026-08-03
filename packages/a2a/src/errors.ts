import { AgentFrameworkError } from '@polymind-inc/agent-framework-core';

/**
 * A remote A2A agent failed, or answered with something this client cannot use.
 *
 * Covers transport and protocol failures raised by the A2A SDK, payload kinds the protocol does
 * not define, and a response whose `contextId` contradicts the session it was run with.
 * Configuration mistakes — a missing client, a token passed together with input, background
 * execution without a session — raise `ConfigurationError` instead, as everywhere else in the
 * framework.
 */
export class A2AAgentError extends AgentFrameworkError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'A2AAgentError';
  }
}
