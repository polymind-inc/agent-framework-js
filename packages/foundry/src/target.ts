import { ConfigurationError } from '@polymind-inc/agent-framework-core';

/** The Entra scope every Foundry data-plane call is authorized against. */
export const FOUNDRY_SCOPE = 'https://ai.azure.com/.default';

/** The Foundry data-plane API version the server-agent protocol endpoint expects. */
export const FOUNDRY_API_VERSION = 'v1';

/**
 * Which Foundry agent to talk to.
 *
 * - `modelDeployment` runs the framework's own agent against a model deployed in the project, over
 *   the project's OpenAI-compatible endpoint. Instructions, tools and the loop stay on this side.
 * - `serverAgent` calls an agent that already exists in the project. The service owns its
 *   instructions and model, so passing them from here has no effect.
 *
 * There is deliberately no agent *version*: the protocol endpoint is
 * `agents/{name}/endpoint/protocols/openai` with no version segment (Go `foundryprovider`), so a
 * version field could only ever be ignored — and a caller who set one would reasonably believe it
 * pinned something.
 */
export type FoundryTarget =
  | { modelDeployment: string; serverAgent?: never }
  | { serverAgent: string; modelDeployment?: never };

/** Narrows a {@link FoundryTarget} to the model-deployment case. */
export function isModelDeployment(target: FoundryTarget): target is { modelDeployment: string } {
  const hasModelDeployment = typeof target.modelDeployment === 'string';
  const hasServerAgent = typeof target.serverAgent === 'string';
  if (hasModelDeployment === hasServerAgent) {
    throw new ConfigurationError(
      'Foundry target must specify exactly one of modelDeployment or serverAgent.',
    );
  }
  return hasModelDeployment;
}

/**
 * Normalizes a project endpoint: absolute URL, no trailing slash, no query or fragment.
 *
 * @throws {ConfigurationError} When the endpoint is empty or not an absolute URL.
 */
export function normalizeProjectEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (trimmed === '') {
    throw new ConfigurationError('A Foundry project endpoint is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new ConfigurationError(`Invalid Foundry project endpoint '${endpoint}'.`, { cause: error });
  }
  if (parsed.protocol === '' || parsed.host === '') {
    throw new ConfigurationError(`The Foundry project endpoint '${endpoint}' must be an absolute URL.`);
  }
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/+$/, '');
}

/** The base URL and query the OpenAI SDK should be pointed at for `target`. */
export interface FoundryEndpoint {
  baseURL: string;
  /** Query parameters every request must carry, or `undefined` when there are none. */
  defaultQuery?: Record<string, string>;
  /** The agent name, when the target is a server agent. */
  agentName?: string;
}

/**
 * Builds the OpenAI-compatible endpoint for a target (Go `foundryprovider`).
 *
 * @throws {ConfigurationError} When the endpoint or the target's identifier is empty.
 */
export function resolveEndpoint(projectEndpoint: string, target: FoundryTarget): FoundryEndpoint {
  const project = normalizeProjectEndpoint(projectEndpoint);
  if (isModelDeployment(target)) {
    if (target.modelDeployment.trim() === '') {
      throw new ConfigurationError('modelDeployment must be a non-empty deployment name.');
    }
    return { baseURL: `${project}/openai/v1/` };
  }

  const agentName = target.serverAgent.trim();
  if (agentName === '') {
    throw new ConfigurationError('serverAgent must be a non-empty agent name.');
  }
  const path = ['agents', encodeURIComponent(agentName), 'endpoint', 'protocols', 'openai'].join('/');
  return {
    baseURL: `${project}/${path}/`,
    defaultQuery: { 'api-version': FOUNDRY_API_VERSION },
    agentName,
  };
}
