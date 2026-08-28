import type { TokenCredential } from '@azure/identity';
import { ConfigurationError } from '@polymind-inc/agent-framework-core';
import { describe, expect, it, vi } from 'vitest';
import { FoundryProject } from './project.js';
import { fakeCredential } from './test-helpers.js';

const PROJECT = 'https://my-resource.services.ai.azure.com/api/projects/my-project';

describe('FoundryProject', () => {
  it('normalizes the endpoint and exposes it', () => {
    const project = new FoundryProject(`${PROJECT}///?x=1#frag`, fakeCredential());
    expect(project.endpoint).toBe(PROJECT);
  });

  it('rejects an endpoint that is empty or relative', () => {
    expect(() => new FoundryProject('  ', fakeCredential())).toThrow(ConfigurationError);
    expect(() => new FoundryProject('/api/projects/p', fakeCredential())).toThrow(ConfigurationError);
  });

  it('exposes the configured default transport', () => {
    const transport = (async () => new Response()) as unknown as typeof globalThis.fetch;
    expect(new FoundryProject(PROJECT, fakeCredential(), { fetch: transport }).fetch).toBe(transport);
    expect(new FoundryProject(PROJECT, fakeCredential()).fetch).toBeUndefined();
  });

  it('reuses a live token instead of calling the credential per request', async () => {
    const credential = fakeCredential();
    const project = new FoundryProject(PROJECT, credential);

    expect(await project.getToken()).toBe('token-1');
    expect(await project.getToken()).toBe('token-1');
    expect(credential.getToken).toHaveBeenCalledOnce();
  });

  it('refreshes a token that is about to expire', async () => {
    // Inside the refresh margin, so the cached token is never considered usable.
    const credential = fakeCredential(60 * 1000);
    const project = new FoundryProject(PROJECT, credential);

    expect(await project.getToken()).toBe('token-1');
    expect(await project.getToken()).toBe('token-2');
  });

  it('shares one refresh between concurrent requests', async () => {
    const credential = fakeCredential();
    const project = new FoundryProject(PROJECT, credential);

    const tokens = await Promise.all([project.getToken(), project.getToken(), project.getToken()]);

    expect(tokens).toEqual(['token-1', 'token-1', 'token-1']);
    expect(credential.getToken).toHaveBeenCalledOnce();
  });

  it('requests the Foundry data-plane scope by default', async () => {
    const getToken = vi.fn(async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }));
    await new FoundryProject(PROJECT, { getToken } as unknown as TokenCredential).getToken();

    expect(getToken).toHaveBeenCalledWith('https://ai.azure.com/.default');
  });

  it('requests the configured scope instead when one is given', async () => {
    const getToken = vi.fn(async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }));
    const project = new FoundryProject(PROJECT, { getToken } as unknown as TokenCredential, {
      scope: 'https://sovereign.example/.default',
    });

    await project.getToken();

    expect(getToken).toHaveBeenCalledWith('https://sovereign.example/.default');
  });

  it('caches tokens per scope, not per call', async () => {
    const credential = fakeCredential();
    const project = new FoundryProject(PROJECT, credential);

    await project.getToken();
    await project.getToken('https://other.example/.default');
    await project.getToken();
    await project.getToken('https://other.example/.default');

    expect(credential.getToken).toHaveBeenCalledTimes(2);
  });

  it('reports a credential that cannot produce a token', async () => {
    const project = new FoundryProject(PROJECT, {
      getToken: async () => null,
    } as unknown as TokenCredential);
    await expect(project.getToken()).rejects.toThrow(/Could not acquire a Microsoft Entra token/);
  });
});
