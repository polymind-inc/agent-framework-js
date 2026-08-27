/**
 * A Microsoft Foundry Hosted Agent.
 *
 * `ResponsesHostServer` publishes the agent over the Responses container protocol v2.0.0, and
 * `serve` binds `0.0.0.0:${PORT:-8088}` — the address the platform's readiness probe expects.
 *
 * Locally:
 *   pnpm --filter example-02-foundry build
 *   pnpm --filter example-02-foundry host
 *   curl -X POST localhost:8088/responses -H 'content-type: application/json' -d '{"input":"Hi"}'
 *
 * On Foundry: see README.md.
 */

import { DefaultAzureCredential } from '@azure/identity';
import { Agent, tool } from '@polymind-inc/agent-framework';
import { serve } from '@polymind-inc/agent-framework/agentserver/node';
import { FoundryChatClient, FoundryProject } from '@polymind-inc/agent-framework/foundry';
import { ResponsesHostServer } from '@polymind-inc/agent-framework/foundry/hosting';

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a location',
  parameters: {
    type: 'object',
    properties: { location: { type: 'string' } },
    required: ['location'],
    additionalProperties: false,
  },
  // A raw JSON Schema carries no type information, so the input arrives as
  // `Record<string, unknown>`. Pass a Standard Schema (Zod, Valibot, ArkType) to have it inferred.
  execute: async (input) => `${String(input.location)} is sunny, 25°C`,
});

const projectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
if (projectEndpoint === undefined) {
  throw new Error('Set FOUNDRY_PROJECT_ENDPOINT to your Foundry project endpoint.');
}

const agent = new Agent({
  client: new FoundryChatClient({
    // `DefaultAzureCredential` covers `az login` locally and the container's managed identity on
    // Foundry.
    project: new FoundryProject(projectEndpoint, new DefaultAzureCredential()),
    target: { model: process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME ?? 'gpt-4o-mini' },
  }),
  name: 'weather-agent',
  instructions: 'You are a helpful assistant. Answer in one short sentence.',
  tools: [getWeather],
  // The hosting infrastructure owns the transcript and replays it on each turn, so the provider
  // must not also store it — otherwise every turn is sent twice.
  defaultOptions: { store: false },
});

// In a container the store defaults to the Foundry storage service, so responses survive sandbox
// recycling; pass `store: new FileResponseProvider()` to keep a deployment off it — see README.md.
const server = new ResponsesHostServer({ agent });

const { port } = await serve(server);
console.log(`listening on 0.0.0.0:${port}`);
