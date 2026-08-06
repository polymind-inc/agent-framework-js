/**
 * 04 — Foundry Toolbox (tools the project hosts, reached over MCP).
 *
 * A toolbox registered in the Foundry project exposes its tools over MCP. `FoundryToolbox` turns
 * them into ordinary framework tools, so the agent calls them exactly like local ones — the
 * function-calling loop, approval and telemetry all behave the same.
 *
 * The connection is opened on the first `getTools()`, not at construction: in a hosted container
 * an unreachable toolbox would otherwise keep `/readiness` red and take every invocation down.
 *
 * Run:
 *   az login
 *   FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project> \
 *   AZURE_AI_MODEL_DEPLOYMENT_NAME=gpt-4o-mini \
 *   FOUNDRY_TOOLBOX_NAME=<toolbox> \
 *   pnpm --filter example-02-foundry toolbox
 */
import { Agent } from '@polymind-inc/agent-framework';
import { FoundryChatClient } from '@polymind-inc/agent-framework/foundry';
import { FoundryToolbox } from '@polymind-inc/agent-framework/foundry/hosting';

const projectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
const toolboxName = process.env.FOUNDRY_TOOLBOX_NAME;
if (projectEndpoint === undefined || toolboxName === undefined) {
  throw new Error('Set FOUNDRY_PROJECT_ENDPOINT and FOUNDRY_TOOLBOX_NAME.');
}

const toolbox = new FoundryToolbox({
  name: toolboxName,
  projectEndpoint,
  // Narrow what the model may call with `allowedTools: ['...']`. The toolbox may expose more than
  // this agent should be able to reach.
});

try {
  const tools = await toolbox.getTools();
  console.log('[toolbox] tools:', tools.map((t) => `${t.name} — ${t.description}`).join('\n           '));

  const agent = new Agent({
    client: new FoundryChatClient({
      projectEndpoint,
      target: { modelDeployment: process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME ?? 'gpt-4o-mini' },
    }),
    name: 'toolbox-agent',
    instructions:
      'You have tools hosted by a Foundry toolbox. Use one when it helps, then answer in one ' +
      'short sentence.',
    tools,
  });

  const question =
    process.argv[2] ??
    `Use one of your tools and tell me what it returned. Tools: ${tools.map((t) => t.name).join(', ')}.`;

  const session = agent.createSession();
  const response = await agent.run(question, { session });
  console.log('[answer]', response.text);

  // Which tools actually ran, from the transcript.
  const called = response.messages
    .flatMap((message) => message.contents)
    .filter((content) => content.type === 'function_call')
    .map((content) => content.name);
  console.log('[called]', called.length === 0 ? '(none)' : called.join(', '));
} finally {
  // The MCP connection is long-lived; close it when the process is done with it.
  await toolbox.close();
}
