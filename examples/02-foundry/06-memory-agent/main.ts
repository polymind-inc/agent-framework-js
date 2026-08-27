/**
 * A Hosted Agent with persistent memory.
 *
 * `FoundryMemoryProvider` searches a Microsoft Foundry Memory Store before each turn and writes
 * the turn back afterwards, so the agent recalls facts a user stated in an *earlier conversation*
 * — not just earlier in this one, which the transcript already covers.
 *
 * The store is provisioned once, out of band:
 *   pnpm --filter example-02-foundry memory:provision
 *
 * Locally:
 *   pnpm --filter example-02-foundry build
 *   pnpm --filter example-02-foundry memory
 *
 * On Foundry: see README.md.
 */

import { DefaultAzureCredential } from '@azure/identity';
import { Agent } from '@polymind-inc/agent-framework';
import { serve } from '@polymind-inc/agent-framework/agentserver/node';
import {
  FoundryChatClient,
  FoundryMemoryProvider,
  FoundryProject,
} from '@polymind-inc/agent-framework/foundry';
import { hostedUserScope, ResponsesHostServer } from '@polymind-inc/agent-framework/foundry/hosting';

const projectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
if (projectEndpoint === undefined) {
  throw new Error('Set FOUNDRY_PROJECT_ENDPOINT to your Foundry project endpoint.');
}
const memoryStoreName = process.env.MEMORY_STORE_NAME;
if (memoryStoreName === undefined) {
  throw new Error('Set MEMORY_STORE_NAME to the memory store provisioned for this agent.');
}

// One project handle for the chat client and the memory provider: one identity, one token cache.
// `DefaultAzureCredential` covers `az login` locally and the container's managed identity on
// Foundry.
const project = new FoundryProject(projectEndpoint, new DefaultAzureCredential());

const memory = new FoundryMemoryProvider({
  project,
  memoryStoreName,
  // Every user of this container gets their own partition of the store. `hostedUserScope()` reads
  // the end-user id the platform injects per request, so one provider instance serves all of them
  // without ever mixing two users' memories; the scope is pinned to a session on first use.
  scope: hostedUserScope(),
  // A memory the service is having a bad minute with must not take the conversation down with it.
  failureMode: 'continue',
  onFailure: ({ operation, error }) => console.warn(`memory ${operation} failed:`, error),
});

const agent = new Agent({
  client: new FoundryChatClient({
    project,
    target: { model: process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME ?? 'gpt-4o-mini' },
  }),
  name: 'memory-agent',
  instructions:
    'You are a helpful assistant that remembers what the user has told you in earlier ' +
    'conversations. Relevant memories are supplied to you automatically. Use them, and say when ' +
    'you are relying on something you remembered. Answer in one or two short sentences.',
  contextProviders: [memory],
  // The hosting infrastructure owns the transcript and replays it on each turn, so the provider
  // must not also store it — otherwise every turn is sent twice.
  defaultOptions: { store: false },
});

const { port } = await serve(new ResponsesHostServer({ agent }));
console.log(`listening on 0.0.0.0:${port}`);
