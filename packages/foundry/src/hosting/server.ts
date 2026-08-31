import { DefaultAzureCredential } from '@azure/identity';
import type { ResponseProvider, ResponsesServerConfig } from '@polymind-inc/agent-framework-agentserver';
import {
  FileResponseProvider,
  InMemoryResponseProvider,
  isHosted,
  projectEndpoint,
  ResponsesServer,
} from '@polymind-inc/agent-framework-agentserver';
import { FoundryProject } from '../project.js';
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
   * Supply one to override the default — {@link FileResponseProvider} with an explicit `root` to
   * move the files, or {@link InMemoryResponseProvider} to keep a local run process-local and off
   * the filesystem entirely.
   */
  store?: ResponseProvider;
}

/**
 * Picks the response store the environment calls for.
 *
 * In a container: the Foundry storage service, the way Python's `ResponsesHostServer` activates
 * its provider when hosted — responses then survive sandbox recycling and conversations can move
 * between sandboxes. Locally: the filesystem under `${AGENTSERVER_STATE_ROOT}/responses`
 * (`~/.agentserver/responses` by default), so a `previous_response_id` chain survives a restart —
 * both reference servers make the same local choice. A hosted container that somehow lacks the
 * platform-injected project endpoint falls back to the sandbox filesystem rather than refusing to
 * start.
 *
 * The local default writes whole transcripts to disk **in the clear** and expires nothing:
 * retention and cleanup belong to whoever runs the process, and the directory needs the
 * protection the conversations do. Pass `new InMemoryResponseProvider()` to opt out.
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
    // The sandbox filesystem, not memory: a local run that restarts can still be continued with
    // `previous_response_id`. .NET registers `FileResponsesProvider` for the non-hosted host and
    // Python's host falls through to `FileResponseStore`, both under the same state root.
    return new FileResponseProvider();
  }
  const endpoint = projectEndpoint();
  if (endpoint === undefined) {
    return new FileResponseProvider();
  }
  // The platform injects the endpoint and the managed identity, so this is the one place a
  // project is assembled from the environment rather than passed in — the same default the
  // Python agent server's Foundry storage applies when no credential is supplied.
  return new FoundryResponseStore({ project: new FoundryProject(endpoint, new DefaultAzureCredential()) });
}

/**
 * Publishes an agent as a Foundry Hosted Agent.
 *
 * ```ts
 * const agent = new Agent({
 *   client: new FoundryChatClient({
 *     project: new FoundryProject(process.env.FOUNDRY_PROJECT_ENDPOINT!, new DefaultAzureCredential()),
 *     target: { model },
 *   }),
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
