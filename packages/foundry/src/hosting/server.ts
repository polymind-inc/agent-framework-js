import type { ResponseProvider, ResponsesServerConfig } from '@polymind-inc/agent-framework-agentserver';
import {
  FileResponseProvider,
  InMemoryResponseProvider,
  isHosted,
  ResponsesServer,
} from '@polymind-inc/agent-framework-agentserver';
import type { FoundryHandlerConfig } from './handler.js';
import { createFoundryHandler } from './handler.js';

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
 * In a container: the sandbox filesystem. Locally: memory, so nothing outlives the process.
 *
 * @remarks
 * **This is not what the reference implementations do, and the reason is measured rather than
 * argued.** Both of them switch a hosted container to Foundry storage automatically (Python
 * `_routing.py`, .NET `ResponsesServerServiceCollectionExtensions`), and this package originally
 * followed them. A real deployment showed that `POST /storage/responses` answers an opaque `500`
 * — from *inside* a
 * container the platform provisioned, with its managed identity and the platform's own
 * `x-agent-foundry-call-id`. Every turn then fails, because a response that cannot be stored is a
 * conversation that cannot be continued. A default that makes the container unusable is the wrong
 * default whatever the reference does, so `FoundryResponseStore` became opt-in:
 *
 * ```ts
 * new ResponsesHostServer({ agent, store: new FoundryResponseStore() })
 * ```
 *
 * The file store works because the platform keeps a conversation on one sandbox: it stamps
 * `agent_session_id` on every request and holds it constant across the turns of a conversation, so
 * a follow-up turn lands on the same filesystem and resolves its `previous_response_id` — verified
 * end to end on a real deployment. What it does not survive is a conversation moving between
 * sandboxes, or a sandbox being recycled.
 */
export function defaultStore(hosted: boolean): ResponseProvider {
  if (!hosted) {
    // A local run is self-contained; nothing should outlive the process.
    return new InMemoryResponseProvider();
  }
  return new FileResponseProvider();
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
