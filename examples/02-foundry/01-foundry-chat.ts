/**
 * 01 — Talking to Microsoft Foundry.
 *
 * `FoundryChatClient` is the OpenAI Responses client pointed at a Foundry project and
 * authenticated with Microsoft Entra, so everything else — tools, streaming, sessions — behaves
 * exactly as it does with `OpenAIChatClient`.
 *
 * Run:
 *   az login
 *   FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project> \
 *   AZURE_AI_MODEL_DEPLOYMENT_NAME=gpt-4o-mini \
 *   pnpm --filter example-02-foundry chat
 */
import { DefaultAzureCredential } from '@azure/identity';
import { Agent, tool } from '@polymind-inc/agent-framework';
import { FoundryChatClient, FoundryProject } from '@polymind-inc/agent-framework/foundry';

const projectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
if (projectEndpoint === undefined) {
  throw new Error('Set FOUNDRY_PROJECT_ENDPOINT to your Foundry project endpoint.');
}

// One project handle carries the endpoint and the identity for every Foundry component.
// `DefaultAzureCredential` covers `az login` locally and a managed identity in Azure.
const project = new FoundryProject(projectEndpoint, new DefaultAzureCredential());

const client = new FoundryChatClient({
  project,
  target: { model: process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME ?? 'gpt-4o-mini' },
});

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

const agent = new Agent({
  client,
  name: 'Assistant',
  instructions: 'You are a helpful assistant. Answer in one short sentence.',
  tools: [getWeather],
});

const session = agent.createSession();

const first = await agent.run('Hello. Please introduce yourself in one sentence.', { session });
console.log('[await]', first.text);
console.log('[usage]', first.usageDetails);

process.stdout.write('[for await] ');
for await (const update of agent.run('What is the weather in Tokyo? Use the available tool.', { session })) {
  process.stdout.write(update.text);
}
process.stdout.write('\n');

// An agent that already exists in the project is the other target. The service owns its
// instructions and model, so only the conversation is ours.
const serverAgentName = process.env.FOUNDRY_SERVER_AGENT;
if (serverAgentName !== undefined) {
  const serverAgent = new Agent({
    client: new FoundryChatClient({ project, target: { serverAgent: serverAgentName } }),
  });
  console.log('[server agent]', (await serverAgent.run('Hello')).text);
}
