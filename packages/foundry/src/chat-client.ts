import type { TokenCredential } from '@azure/identity';
import { DefaultAzureCredential } from '@azure/identity';
import type {
  ChatClient,
  ChatClientMetadata,
  ChatResponseStream,
  CodeInterpreterToolOptions,
  FileSearchToolOptions,
  HostedTool,
  McpToolOptions,
  Message,
  SupportsCodeInterpreterTool,
  SupportsFileSearchTool,
  SupportsMcpTool,
  SupportsWebSearchTool,
  WebSearchToolOptions,
} from '@polymind-inc/agent-framework-core';
import type { OpenAIChatOptions } from '@polymind-inc/agent-framework-openai';
import { OpenAIChatClient } from '@polymind-inc/agent-framework-openai';
import OpenAI from 'openai';
import { tokenProvider } from './credential.js';
import type { FoundryTarget } from './target.js';
import { FOUNDRY_SCOPE, isModelDeployment, resolveEndpoint } from './target.js';

/** Construction options for {@link FoundryChatClient}. */
export interface FoundryChatClientConfig {
  /** The Foundry project endpoint, for example `https://my-project.services.ai.azure.com/api/projects/p`. */
  projectEndpoint: string;
  /** Which agent to talk to: a model deployment in the project, or an existing server agent. */
  target: FoundryTarget;
  /** Defaults to {@link DefaultAzureCredential}. */
  credential?: TokenCredential;
  /** Entra scope for the token. Defaults to `https://ai.azure.com/.default`. */
  scope?: string;
  /** A preconfigured SDK client. Supplying it bypasses endpoint construction and `credential`. */
  client?: OpenAI;
  /** Extra headers on every request, for example `x-client-*` correlation headers. */
  defaultHeaders?: Record<string, string>;
  /** Replaces the SDK's `fetch`, for proxies, custom agents, or tests. */
  fetch?: OpenAI['fetch'];
}

/**
 * A {@link ChatClient} for Microsoft Foundry.
 *
 * Foundry speaks the OpenAI Responses protocol, so this is a thin wrapper over
 * {@link OpenAIChatClient}: it builds the right endpoint for the target, authenticates with
 * Microsoft Entra, and reports `providerName: 'azure.ai.foundry'`. Every mapping — messages,
 * tools, streaming, structured output — is the OpenAI one.
 *
 * ```ts
 * // The framework's agent, running on a model deployed in the project.
 * const client = new FoundryChatClient({
 *   projectEndpoint: process.env.FOUNDRY_PROJECT_ENDPOINT!,
 *   target: { modelDeployment: 'gpt-4o' },
 * });
 *
 * // An agent that already exists in the project; the service owns its instructions and model.
 * const server = new FoundryChatClient({
 *   projectEndpoint: process.env.FOUNDRY_PROJECT_ENDPOINT!,
 *   target: { serverAgent: 'support-bot' },
 * });
 * ```
 *
 * ## Security considerations
 *
 * - **The token is scoped to the project, not to a conversation.** Anything that can call this
 *   client can reach every model and tool the project's identity can reach.
 * - **`projectEndpoint` decides where the bearer token goes.** Treat it as trusted configuration;
 *   never build it from user input.
 * - The OpenAI notes apply unchanged: messages leave the process, and `store` is pass-through.
 */
export class FoundryChatClient
  implements
    ChatClient<OpenAIChatOptions>,
    SupportsWebSearchTool,
    SupportsFileSearchTool,
    SupportsCodeInterpreterTool,
    SupportsMcpTool
{
  readonly metadata: ChatClientMetadata;
  readonly #inner: OpenAIChatClient;
  readonly #baseURL: string;

  constructor(config: FoundryChatClientConfig) {
    const endpoint = resolveEndpoint(config.projectEndpoint, config.target);
    // A server agent is addressed by its endpoint, and the agent definition picks the model, so
    // there is nothing to name here: .NET removes `$.model` from the request and Go leaves it
    // unset. Sending a placeholder would reach the wire, `metadata.modelId` and telemetry alike.
    const model = isModelDeployment(config.target) ? config.target.modelDeployment : undefined;

    this.#baseURL = endpoint.baseURL;
    const client =
      config.client ??
      new OpenAI({
        baseURL: endpoint.baseURL,
        // The SDK calls this before every request, so rotation is handled for us.
        apiKey: tokenProvider(
          config.credential ?? new DefaultAzureCredential(),
          config.scope ?? FOUNDRY_SCOPE,
        ),
        ...(endpoint.defaultQuery === undefined ? {} : { defaultQuery: endpoint.defaultQuery }),
        ...(config.defaultHeaders === undefined ? {} : { defaultHeaders: config.defaultHeaders }),
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      });

    this.#inner = new OpenAIChatClient({
      client,
      // Not every Foundry deployment supports encrypted reasoning, and one that does not rejects
      // a request that asks for it — so asking implicitly would make those deployments
      // unreachable. A caller whose deployment does support it opts in per request by listing
      // `reasoning.encrypted_content` in `include`, which is what a replayed transcript of a
      // reasoning model needs.
      includeReasoningEncryptedContent: false,
      ...(model === undefined ? { endpointProvidesModel: true as const } : { model }),
    });
    this.metadata = {
      providerName: 'azure.ai.foundry',
      ...(model === undefined ? {} : { modelId: model }),
      // Foundry speaks the same Responses protocol, so which conversation ids are stable is the
      // inner client's knowledge — re-spelling it here is how the two could drift.
      ...(this.#inner.metadata.stableConversationId === undefined
        ? {}
        : { stableConversationId: this.#inner.metadata.stableConversationId }),
    };
  }

  /** The endpoint requests are sent to, for diagnostics. */
  get baseURL(): string {
    return this.#baseURL;
  }

  /** The underlying SDK client, for Foundry features the framework does not model. */
  get client(): OpenAI {
    return this.#inner.client;
  }

  /**
   * Declares the hosted web search tool.
   *
   * On Foundry this is backed by Bing Grounding, configured on the project rather than here.
   */
  getWebSearchTool(options?: WebSearchToolOptions): HostedTool {
    return this.#inner.getWebSearchTool(options);
  }

  /** Declares the hosted file search tool over the project's vector stores. */
  getFileSearchTool(options?: FileSearchToolOptions): HostedTool {
    return this.#inner.getFileSearchTool(options);
  }

  /** Declares the hosted code interpreter. */
  getCodeInterpreterTool(options?: CodeInterpreterToolOptions): HostedTool {
    return this.#inner.getCodeInterpreterTool(options);
  }

  /** Declares a remote MCP server Foundry connects to on the model's behalf. */
  getMcpTool(options: McpToolOptions): HostedTool {
    return this.#inner.getMcpTool(options);
  }

  /** Builds the request body without sending it. See {@link OpenAIChatClient.buildRequest}. */
  buildRequest(messages: Message[], options?: OpenAIChatOptions): Record<string, unknown> {
    return this.#inner.buildRequest(messages, options);
  }

  getResponse(
    messages: Message[],
    options?: OpenAIChatOptions & { signal?: AbortSignal },
  ): ChatResponseStream<undefined> {
    return this.#inner.getResponse(messages, options);
  }
}
