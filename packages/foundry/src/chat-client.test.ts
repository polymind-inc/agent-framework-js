import type { AccessToken, TokenCredential } from '@azure/identity';
import { ConfigurationError, textContent } from '@polymind-inc/agent-framework-core';
import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { FoundryChatClient } from './chat-client.js';
import { tokenProvider } from './credential.js';
import { normalizeProjectEndpoint, resolveEndpoint } from './target.js';

const PROJECT = 'https://my-resource.services.ai.azure.com/api/projects/my-project';

/** A credential whose tokens expire `ttlMs` from now. */
function fakeCredential(ttlMs = 60 * 60 * 1000): TokenCredential & { calls: number } {
  const credential = {
    calls: 0,
    async getToken(): Promise<AccessToken> {
      credential.calls++;
      return { token: `token-${credential.calls}`, expiresOnTimestamp: Date.now() + ttlMs };
    },
  };
  return credential;
}

describe('Foundry endpoint construction', () => {
  it('builds the project OpenAI endpoint for a model deployment', () => {
    expect(resolveEndpoint(PROJECT, { modelDeployment: 'gpt-4o' })).toEqual({
      baseURL: `${PROJECT}/openai/v1/`,
    });
  });

  it('builds the protocol endpoint for a server agent, with the data-plane api-version', () => {
    expect(resolveEndpoint(PROJECT, { serverAgent: 'support-bot' })).toEqual({
      baseURL: `${PROJECT}/agents/support-bot/endpoint/protocols/openai/`,
      defaultQuery: { 'api-version': 'v1' },
      agentName: 'support-bot',
    });
  });

  it('escapes an agent name so it cannot climb out of the path', () => {
    const { baseURL } = resolveEndpoint(PROJECT, { serverAgent: 'a/../../evil' });
    expect(baseURL).toBe(`${PROJECT}/agents/a%2F..%2F..%2Fevil/endpoint/protocols/openai/`);
  });

  it('normalizes trailing slashes, query and fragment away', () => {
    expect(normalizeProjectEndpoint(`${PROJECT}///?x=1#frag`)).toBe(PROJECT);
  });

  it('rejects an endpoint that is empty, relative, or an empty target', () => {
    expect(() => normalizeProjectEndpoint('  ')).toThrow(ConfigurationError);
    expect(() => normalizeProjectEndpoint('/api/projects/p')).toThrow(ConfigurationError);
    expect(() => resolveEndpoint(PROJECT, { modelDeployment: ' ' })).toThrow(ConfigurationError);
    expect(() => resolveEndpoint(PROJECT, { serverAgent: '' })).toThrow(ConfigurationError);
  });
});

describe('Foundry token provider', () => {
  it('reuses a live token instead of calling the credential per request', async () => {
    const credential = fakeCredential();
    const provider = tokenProvider(credential);

    expect(await provider()).toBe('token-1');
    expect(await provider()).toBe('token-1');
    expect(credential.calls).toBe(1);
  });

  it('refreshes a token that is about to expire', async () => {
    // Inside the refresh margin, so the cached token is never considered usable.
    const credential = fakeCredential(60 * 1000);
    const provider = tokenProvider(credential);

    expect(await provider()).toBe('token-1');
    expect(await provider()).toBe('token-2');
  });

  it('shares one refresh between concurrent requests', async () => {
    const credential = fakeCredential();
    const provider = tokenProvider(credential);

    const tokens = await Promise.all([provider(), provider(), provider()]);

    expect(tokens).toEqual(['token-1', 'token-1', 'token-1']);
    expect(credential.calls).toBe(1);
  });

  it('requests the Foundry data-plane scope by default', async () => {
    const getToken = vi.fn(async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }));
    await tokenProvider({ getToken } as unknown as TokenCredential)();

    expect(getToken).toHaveBeenCalledWith('https://ai.azure.com/.default');
  });

  it('reports a credential that cannot produce a token', async () => {
    const provider = tokenProvider({ getToken: async () => null } as unknown as TokenCredential);
    await expect(provider()).rejects.toThrow(/Could not acquire a Microsoft Entra token/);
  });
});

describe('FoundryChatClient', () => {
  it('points at the right endpoint and reports the Foundry provider', () => {
    const deployment = new FoundryChatClient({
      projectEndpoint: PROJECT,
      target: { modelDeployment: 'gpt-4o' },
      credential: fakeCredential(),
    });

    expect(deployment.baseURL).toBe(`${PROJECT}/openai/v1/`);
    expect(deployment.metadata).toEqual({ providerName: 'azure.ai.foundry', modelId: 'gpt-4o' });
  });

  it('does not invent a model for a server agent', () => {
    // A server agent's model is a service-side detail chosen by the agent definition. .NET removes
    // `$.model` from the request and Go leaves it unset; reporting a made-up name here would put
    // it on the wire, in `metadata.modelId`, and in every telemetry span.
    const server = new FoundryChatClient({
      projectEndpoint: PROJECT,
      target: { serverAgent: 'support-bot' },
      credential: fakeCredential(),
    });

    expect(server.baseURL).toBe(`${PROJECT}/agents/support-bot/endpoint/protocols/openai/`);
    expect(server.metadata.modelId).toBeUndefined();
  });

  it('omits model from a server agent request body', () => {
    const client = new FoundryChatClient({
      projectEndpoint: PROJECT,
      target: { serverAgent: 'support-bot' },
      client: { responses: { create: vi.fn() }, baseURL: PROJECT } as unknown as OpenAI,
    });

    const request = client.buildRequest([{ role: 'user', contents: [textContent('hi')] }]);

    expect('model' in request).toBe(false);
    expect(request.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
  });

  it('reuses the OpenAI request mapping unchanged', () => {
    const create = vi.fn();
    const client = new FoundryChatClient({
      projectEndpoint: PROJECT,
      target: { modelDeployment: 'gpt-4o' },
      client: { responses: { create }, baseURL: PROJECT } as unknown as OpenAI,
    });

    const request = client.buildRequest([{ role: 'user', contents: [textContent('hi')] }]);

    expect(request.model).toBe('gpt-4o');
    expect(request.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
  });

  it('sends the credential token as the bearer, to the target endpoint', async () => {
    const credential = fakeCredential();
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(url), authorization: headers.get('authorization') });
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'hi', annotations: [] }],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as OpenAI['fetch'];

    const client = new FoundryChatClient({
      projectEndpoint: PROJECT,
      target: { serverAgent: 'support-bot' },
      credential,
      fetch: fetchStub,
    });

    const response = await client.getResponse([{ role: 'user', contents: [textContent('hi')] }]);

    expect(response.text).toBe('hi');
    expect(seen[0]?.authorization).toBe('Bearer token-1');
    // The server-agent protocol endpoint, carrying the data-plane api-version.
    expect(seen[0]?.url).toBe(
      `${PROJECT}/agents/support-bot/endpoint/protocols/openai/responses?api-version=v1`,
    );
  });
});
