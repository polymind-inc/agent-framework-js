import type { TokenCredential } from '@azure/identity';
import { tokenProvider } from './credential.js';
import { FOUNDRY_SCOPE, normalizeProjectEndpoint } from './target.js';

/** Optional settings for {@link FoundryProject}. */
export interface FoundryProjectOptions {
  /** Entra scope tokens are acquired for. Defaults to `https://ai.azure.com/.default`. */
  scope?: string;
  /**
   * Default transport for every component built from this project, for proxies and tests. A
   * component's own `fetch` option takes precedence.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * A Microsoft Foundry project: the endpoint requests go to and the identity they carry.
 *
 * Construct one per project and hand it to every Foundry component — chat client, memory
 * provider, toolbox, response store — the way an `AIProjectClient` is shared in the Azure SDKs.
 * All components built from the same project share one bearer-token cache per scope, so tokens
 * are acquired once, not once per component. The constructor mirrors
 * `new AIProjectClient(endpoint, credential)` from `@azure/ai-projects` deliberately — including
 * that the endpoint and the credential are always passed in, never resolved from the environment
 * or constructed implicitly — so code holding that pair can build either. Reading
 * `FOUNDRY_PROJECT_ENDPOINT` and choosing the credential are the caller's decisions, made where
 * the values are checked:
 *
 * ```ts
 * const project = new FoundryProject(process.env.FOUNDRY_PROJECT_ENDPOINT!, new DefaultAzureCredential());
 *
 * const client  = new FoundryChatClient({ project, target: { model: 'gpt-4o' } });
 * const memory  = new FoundryMemoryProvider({ project, memoryStoreName: 'memories', scope: userId });
 * ```
 *
 * ## Security considerations
 *
 * `endpoint` decides where bearer tokens for this project's identity are sent. Treat it as
 * trusted configuration; never build it from user input.
 */
export class FoundryProject {
  readonly #endpoint: string;
  readonly #credential: TokenCredential;
  readonly #scope: string;
  readonly #fetch: typeof globalThis.fetch | undefined;
  /** One cached provider per scope, shared by every component built from this project. */
  readonly #tokens = new Map<string, () => Promise<string>>();

  /**
   * @param endpoint The Foundry **project** endpoint, for example
   *   `https://my-resource.services.ai.azure.com/api/projects/my-project`.
   * @param credential The identity every call is authorized with. `DefaultAzureCredential` covers
   *   `az login` locally and a managed identity in Azure.
   * @param options Scope and transport defaults.
   */
  constructor(endpoint: string, credential: TokenCredential, options?: FoundryProjectOptions) {
    this.#endpoint = normalizeProjectEndpoint(endpoint);
    this.#credential = credential;
    this.#scope = options?.scope ?? FOUNDRY_SCOPE;
    this.#fetch = options?.fetch;
  }

  /** The normalized project endpoint. */
  get endpoint(): string {
    return this.#endpoint;
  }

  /** The default transport components built from this project use, when one was configured. */
  get fetch(): typeof globalThis.fetch | undefined {
    return this.#fetch;
  }

  /**
   * A bearer token for the project, from the shared per-scope cache.
   *
   * Tokens are refreshed ahead of expiry and concurrent callers share one acquisition, so this is
   * safe to call per request.
   */
  getToken(scope?: string): Promise<string> {
    const resolved = scope ?? this.#scope;
    let provider = this.#tokens.get(resolved);
    if (provider === undefined) {
      provider = tokenProvider(this.#credential, resolved);
      this.#tokens.set(resolved, provider);
    }
    return provider();
  }
}
