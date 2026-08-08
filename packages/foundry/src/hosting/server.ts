import type { ResponseProvider, ResponsesServerConfig } from '@polymind-inc/agent-framework-agentserver';
import {
  FileResponseProvider,
  InMemoryResponseProvider,
  isHosted,
  projectEndpoint,
  ResponsesServer,
} from '@polymind-inc/agent-framework-agentserver';
import type { FoundryHandlerConfig } from './handler.js';
import { createFoundryHandler } from './handler.js';
import { FoundryResponseStore } from './response-store.js';

/** Construction options for {@link ResponsesHostServer}. */
export interface ResponsesHostServerConfig
  extends FoundryHandlerConfig,
    Pick<ResponsesServerConfig, 'prefix' | 'onViolation'> {
  /**
   * Where responses live. Defaults to {@link defaultStore}.
   *
   * Supply one to override the default — {@link FileResponseProvider} to keep a deployed container
   * off the storage service, or {@link InMemoryResponseProvider} for a self-contained test.
   */
  store?: ResponseProvider;
}

/**
 * Picks the response store the environment calls for.
 *
 * In a container: the Foundry storage service, the way Python's `ResponsesHostServer` activates
 * its provider when hosted — responses then survive sandbox recycling and conversations can move
 * between sandboxes. Locally: memory, so nothing outlives the process. A hosted container that
 * somehow lacks the platform-injected project endpoint falls back to the sandbox filesystem
 * rather than refusing to start.
 *
 * The storage service requires the hosted-agent credential and the platform call id on every
 * write, and an `agent_reference` on every persisted response (all measured against the live
 * service) — the store and the protocol layer supply all three. To keep a deployed container off
 * the storage service, pass the store explicitly:
 *
 * ```ts
 * new ResponsesHostServer({ agent, store: new FileResponseProvider() })
 * ```
 */
export function defaultStore(hosted: boolean): ResponseProvider {
  if (!hosted) {
    // A local run is self-contained; nothing should outlive the process.
    return new InMemoryResponseProvider();
  }
  return projectEndpoint() === undefined ? new FileResponseProvider() : new FoundryResponseStore();
}

/**
 * Publishes an agent as a Foundry Hosted Agent.
 *
 * ```ts
 * const agent = new Agent({
 *   client: new FoundryChatClient({ projectEndpoint, target: { modelDeployment } }),
 *   instructions: 'You are a helpful assistant.',
 *   // The hosting infrastructure owns the transcript, so the provider must not store it too.
 *   defaultOptions: { store: false },
 * });
 *
 * await serve(new ResponsesHostServer({ agent }));
 * ```
 *
 * See `@polymind-inc/agent-framework-agentserver` for the protocol itself, and `./node`'s `serve` for the
 * `0.0.0.0:${PORT:-8088}` listener the container contract requires.
 */
export class ResponsesHostServer extends ResponsesServer {
  constructor(options: ResponsesHostServerConfig) {
    const hosted = options.hosted ?? isHosted();
    super({
      handler: createFoundryHandler(options),
      store: options.store ?? defaultStore(hosted),
      hosted,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      ...(options.onViolation === undefined ? {} : { onViolation: options.onViolation }),
    });
  }
}
