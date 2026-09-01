import type { CallToolResult } from '@modelcontextprotocol/client';
import { platformHeaders } from '@polymind-inc/agent-framework-agentserver';
import type {
  ContextProvider,
  FunctionTool,
  SkillsProviderConfig,
  SkillsSource,
  ToolContext,
} from '@polymind-inc/agent-framework-core';
import { skillsProvider, tool } from '@polymind-inc/agent-framework-core';
import type { McpSkillsSourceConfig } from '@polymind-inc/agent-framework-mcp';
import { McpConnection, mcpSkillsSource } from '@polymind-inc/agent-framework-mcp';
import {
  callToolFailure,
  contentsOfCallToolResult,
  localToolName,
  normalizeInputSchema,
} from '@polymind-inc/agent-framework-mcp/internal';
import type { FoundryProject } from '../project.js';
import { FOUNDRY_API_VERSION } from '../target.js';
import { consentRequestsOf, ToolboxConsentRequiredError } from './consent.js';
import { reportConsent } from './consent-channel.js';

/**
 * Retypes a Foundry MCP gateway consent refusal; anything else passes through unchanged.
 *
 * The gateway answers `tools/list` / `tools/call` with JSON-RPC error `-32006` when a tool
 * source needs the end user's OAuth consent (Python `consent_url_from_error`). A JSON-RPC error
 * *answer* is a definitive response, not a lost connection, so the connection's
 * reconnect-and-retry never replays it — it surfaces here to be retyped.
 */
function withConsentTyped(error: unknown): unknown {
  const consents = consentRequestsOf(error);
  return consents === undefined ? error : new ToolboxConsentRequiredError(consents);
}

/** Construction options for {@link FoundryToolbox}. */
export interface FoundryToolboxConfig {
  /** The toolbox registered in the project. */
  name: string;
  /** The project hosting the toolbox. */
  project: FoundryProject;
  /** Restricts which of the toolbox's tools are exposed to the model. */
  allowedTools?: string[];
  /**
   * Whether {@link FoundryToolbox.getTools} serves the toolbox's tools. Defaults to `true`.
   *
   * Set it to `false` for a toolbox you are consuming only for its Agent Skills: `getTools()` then
   * answers with nothing and the gateway is never asked to list tools, leaving
   * {@link FoundryToolbox.asSkillsProvider} as the only thing the model sees of it. The flag only
   * matters where `getTools()` is actually wired into an agent — the toolbox's tools reach a model
   * through that call and no other way.
   */
  loadTools?: boolean;
  /**
   * Namespaces the tool names this toolbox exposes to the model, as `<prefix>_<name>`.
   *
   * Two toolboxes that both advertise `search` collide the moment their tools reach one agent; a
   * prefix is how the caller separates them, exactly as `McpClientConfig.toolNamePrefix` does for
   * plain MCP servers — the joining and normalization rules are the same shared implementation.
   *
   * Only the exposed name changes. `tools/call`, {@link FoundryToolboxConfig.allowedTools} and
   * error messages all keep using the tool name the server declared — not the prefixed name, and
   * not {@link FoundryToolboxConfig.name}.
   */
  toolNamePrefix?: string;
  /**
   * Replaces the transport's `fetch`, for proxies and tests.
   *
   * The per-call authorization wrapper is applied *around* whatever is supplied here, so a
   * replacement cannot accidentally drop the token or the call id.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * The tools Foundry hosts for a project, reached over MCP.
 *
 * Connection management — lazy connect, a single reconnect when the session has expired, close —
 * is {@link McpConnection}'s, so every `tools/list` and `tools/call` is also traced the way any
 * other MCP call in the framework is.
 *
 * ## Security considerations
 *
 * Authorization is per call, never baked into the session. The MCP connection is long-lived and
 * serves **every user this container handles**, so a bearer token or an
 * `x-agent-foundry-call-id` captured at connect time would be replayed on behalf of whoever came
 * later. Both are attached at call time instead: the token from the credential, and the call id
 * from the request context in flight.
 */
export class FoundryToolbox {
  readonly #name: string;
  readonly #endpoint: string;
  readonly #allowedTools: ReadonlySet<string> | undefined;
  readonly #loadTools: boolean;
  readonly #toolNamePrefix: string | undefined;
  readonly #connection: McpConnection;

  constructor(options: FoundryToolboxConfig) {
    const project = options.project;
    this.#name = options.name;
    this.#endpoint = project.endpoint;
    this.#allowedTools = options.allowedTools === undefined ? undefined : new Set(options.allowedTools);
    this.#loadTools = options.loadTools ?? true;
    this.#toolNamePrefix = options.toolNamePrefix;

    const fetch = options.fetch ?? project.fetch;
    this.#connection = new McpConnection({
      url: this.url,
      // Per-request rather than per-connection: see the class note on why this cannot be a
      // static header set.
      headers: async () => ({
        authorization: `Bearer ${await project.getToken()}`,
        ...platformHeaders(),
      }),
      ...(fetch === undefined ? {} : { fetch }),
    });
  }

  /** Whether the MCP connection has been opened. Exposed so tests can assert it stays lazy. */
  get connected(): boolean {
    return this.#connection.connected;
  }

  /** The MCP endpoint for this toolbox. */
  get url(): string {
    return `${this.#endpoint}/toolboxes/${encodeURIComponent(this.#name)}/mcp?api-version=${FOUNDRY_API_VERSION}`;
  }

  /**
   * Lists the toolbox's tools as framework tools.
   *
   * Called on the first request rather than at startup: a toolbox that is briefly unreachable
   * would otherwise keep `/readiness` red and fail every invocation with `session_not_ready`,
   * instead of failing the one request that needed it.
   */
  async getTools(): Promise<Array<FunctionTool<Record<string, unknown>, unknown>>> {
    if (!this.#loadTools) {
      // Not just a filter over the result: the point of `loadTools: false` is that a
      // skills-only toolbox never asks the gateway to list tools at all.
      return [];
    }
    // The gateway signals "consent required" on `tools/list` (Python hits it on lazy agent
    // entry); retyped so the hosting handler can surface an `oauth_consent_request` item
    // instead of failing the turn.
    const { tools } = await this.#connection.listTools().catch((error: unknown) => {
      throw withConsentTyped(error);
    });

    return tools
      .filter((declared) => this.#allowedTools?.has(declared.name) ?? true)
      .map((declared) =>
        tool({
          // Exposed under the provider-safe name the shared MCP rules produce; every request to
          // the toolbox below keeps using `declared.name`, the name the server owns.
          name: localToolName(declared.name, this.#toolNamePrefix),
          // A tool declared without a description gets an empty one — the name is not reused as a
          // stand-in (Python parity: `tool.description or ""`).
          description: declared.description ?? '',
          parameters: normalizeInputSchema(declared.inputSchema as Record<string, unknown> | undefined),
          execute: async (input: unknown, ctx: ToolContext) => {
            let result: CallToolResult;
            try {
              // Tools resolve the live connection on every call rather than closing over the one
              // that existed when they were enumerated, so a reconnect swaps it underneath them.
              // The caller's signal rides along so an abandoned turn — a client disconnect, or
              // SIGTERM draining the container — stops the *remote* tool too; the consent path
              // below runs off this same call, so it is cancellable as well.
              result = await this.#connection.callTool(
                declared.name,
                (input ?? {}) as Record<string, unknown>,
                ctx.signal === undefined ? undefined : { signal: ctx.signal },
              );
            } catch (error) {
              // A `-32006` answer becomes the typed consent error. The loop will reduce it to
              // `function_result.exception` text, which the handler must not trust, so the refusal
              // is reported out of band against this call id (see `consent-channel.ts`).
              const typed = withConsentTyped(error);
              if (typed instanceof ToolboxConsentRequiredError) {
                reportConsent(ctx.callId, typed.consents);
              }
              throw typed;
            }
            if (result.isError === true) {
              // MCP reports a tool failure in the payload, not by rejecting. Returning it as a
              // success would tell the model the call worked and hand it the error text as the
              // answer; throwing routes it through the loop's error handling instead. The text is
              // assembled by the same shared rule `McpClient` applies — one line per text block,
              // structured content last, a tool-naming fallback — not a second copy of it.
              throw callToolFailure(declared.name, contentsOfCallToolResult(result));
            }
            return result.content;
          },
        }),
      );
  }

  /**
   * Discovers the toolbox's Agent Skills, as a source `skillsProvider` can serve.
   *
   * A Foundry toolbox publishes skills the same way any other MCP server does — a
   * `skill://index.json` catalogue with a `SKILL.md` behind each entry — so this reads them over
   * the connection the tools already use. Nothing new is authenticated, configured or opened: the
   * per-call bearer token and call id ride along exactly as they do on `tools/call`.
   */
  skillsSource(config?: McpSkillsSourceConfig): SkillsSource {
    return mcpSkillsSource(
      {
        readResource: async (uri: string, options?: { signal?: AbortSignal }) => {
          try {
            return await this.#connection.readResource(uri, options);
          } catch (error) {
            throw withConsentTyped(error);
          }
        },
      },
      { origin: `toolbox '${this.#name}'`, ...config },
    );
  }

  /**
   * Serves the toolbox's Agent Skills to an agent.
   *
   * ```ts
   * const toolbox = new FoundryToolbox({ name: 'support', project, loadTools: false });
   * const agent = new Agent({
   *   client,
   *   instructions: 'You are a support assistant.',
   *   contextProviders: [toolbox.asSkillsProvider({ approvals: { loadSkill: 'never_require' } })],
   * });
   * ```
   *
   * Skill tools require approval by default, like every other skill tool. A hosted agent that runs
   * unattended has to relax at least `loadSkill`, since there is no one on the other end of the
   * approval request.
   *
   * ## Security considerations
   *
   * The skills come from the toolbox, which means from whatever tool sources the project has
   * configured. Their instructions enter the model's context verbatim — see {@link skillsProvider}.
   *
   * A gateway that answers with `CONSENT_REQUIRED` during discovery is retyped to
   * {@link ToolboxConsentRequiredError}, but discovery happens inside the run rather than while the
   * agent is being built, so the hosted handler surfaces it as a failed turn rather than as an
   * `oauth_consent_request` item. To meet the gate somewhere the handler can turn it into a
   * consent prompt, wire the toolbox's tools as well: an agent built in the hosted handler's
   * factory with `tools: await toolbox.getTools()` runs `tools/list` during construction, and a
   * refusal there does become an `oauth_consent_request` item.
   */
  asSkillsProvider(config?: SkillsProviderConfig & McpSkillsSourceConfig): ContextProvider {
    return skillsProvider(this.skillsSource(config), config);
  }

  /** Closes the MCP connection. */
  async close(): Promise<void> {
    await this.#connection.close();
  }
}
