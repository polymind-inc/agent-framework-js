import { OpenAIChatClient } from '@polymind-inc/agent-framework-openai';
import OpenAI from 'openai';
import type { FoundryProject } from './project.js';
import type { FoundryTarget } from './target.js';
import { isModelTarget, resolveEndpoint } from './target.js';

/** Options shared by both construction paths for {@link FoundryChatClient}. */
interface FoundryChatClientConfigBase {
  /** Which agent to talk to: a model deployment in the project, or an existing server agent. */
  target: FoundryTarget;
  /** Extra headers on every request, for example `x-client-*` correlation headers. */
  defaultHeaders?: Record<string, string>;
  /** Replaces the SDK's `fetch`, for proxies, custom agents, or tests. */
  fetch?: OpenAI['fetch'];
}

/** Construction options for {@link FoundryChatClient}. */
export type FoundryChatClientConfig = FoundryChatClientConfigBase &
  (
    | {
        /** A preconfigured SDK client. Its endpoint and authentication are used directly. */
        client: OpenAI;
        project?: undefined;
      }
    | {
        client?: undefined;
        /** The project to talk to: the endpoint requests go to and the identity they carry. */
        project: FoundryProject;
      }
  );

/**
 * A {@link ChatClient} for Microsoft Foundry.
 *
 * Foundry speaks the OpenAI Responses protocol, so this is a thin wrapper over
 * {@link OpenAIChatClient}: it builds the right endpoint for the target, authenticates with
 * Microsoft Entra, and reports `providerName: 'azure.ai.foundry'`. Every mapping — messages,
 * tools, streaming, structured output — is the OpenAI one.
 *
 * ```ts
 * const project = new FoundryProject(process.env.FOUNDRY_PROJECT_ENDPOINT!, new DefaultAzureCredential());
 *
 * // The framework's agent, running on a model deployed in the project.
 * const client = new FoundryChatClient({ project, target: { model: 'gpt-4o' } });
 *
 * // An agent that already exists in the project; the service owns its instructions and model.
 * const server = new FoundryChatClient({ project, target: { serverAgent: 'support-bot' } });
 * ```
 *
 * ## Security considerations
 *
 * - **The token is scoped to the project, not to a conversation.** Anything that can call this
 *   client can reach every model and tool the project's identity can reach.
 * - **The project's endpoint decides where the bearer token goes.** Treat it as trusted
 *   configuration; never build it from user input.
 * - The OpenAI notes apply unchanged: messages leave the process, and `store` is pass-through.
 */
export class FoundryChatClient extends OpenAIChatClient {
  readonly #baseURL: string;

  constructor(config: FoundryChatClientConfig) {
    // A server agent is addressed by its endpoint, and the agent definition picks the model, so
    // there is nothing to name here: .NET removes `$.model` from the request and Go leaves it
    // unset. Sending a placeholder would reach the wire, `metadata.modelId` and telemetry alike.
    const model = isModelTarget(config.target) ? config.target.model : undefined;

    let client: OpenAI;
    if (config.client !== undefined) {
      client = config.client;
    } else {
      const project = config.project;
      const endpoint = resolveEndpoint(project.endpoint, config.target);
      const fetch = config.fetch ?? project.fetch;
      client = new OpenAI({
        baseURL: endpoint.baseURL,
        // The SDK calls this before every request, so rotation is handled for us.
        apiKey: () => project.getToken(),
        ...(endpoint.defaultQuery === undefined ? {} : { defaultQuery: endpoint.defaultQuery }),
        ...(config.defaultHeaders === undefined ? {} : { defaultHeaders: config.defaultHeaders }),
        ...(fetch === undefined ? {} : { fetch }),
      });
    }

    super({
      client,
      // Not every Foundry deployment supports encrypted reasoning, and one that does not rejects
      // a request that asks for it — so asking implicitly would make those deployments
      // unreachable. A caller whose deployment does support it opts in per request by listing
      // `reasoning.encrypted_content` in `include`, which is what a replayed transcript of a
      // reasoning model needs.
      includeReasoningEncryptedContent: false,
      ...(model === undefined ? { endpointProvidesModel: true as const } : { model }),
    });
    this.#baseURL = client.baseURL;
    // Everything except the provider name is the Responses client's own metadata, including its
    // knowledge of which conversation ids are stable.
    Object.assign(this.metadata, { providerName: 'azure.ai.foundry' });
  }

  /** The endpoint requests are sent to, for diagnostics. */
  get baseURL(): string {
    return this.#baseURL;
  }
}
