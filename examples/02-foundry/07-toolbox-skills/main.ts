/**
 * A Hosted Agent whose knowledge comes from a Foundry toolbox's Agent Skills.
 *
 * A toolbox publishes two independent things: tools the agent can call, and skills — domain
 * knowledge authored as `SKILL.md` and served over the same MCP endpoint. This agent takes only
 * the skills: with `loadTools: false`, the `getTools()` call below answers with an empty list
 * without ever asking the gateway, and `asSkillsProvider()` advertises the skills instead.
 *
 * Nothing extra is authenticated. Skill discovery rides the connection the tools use, with the
 * same per-call Entra token and the same `x-agent-foundry-call-id`.
 *
 * Locally:
 *   pnpm --filter example-02-foundry build
 *   pnpm --filter example-02-foundry toolbox-skills
 *
 * On Foundry: see README.md.
 */

import { DefaultAzureCredential } from '@azure/identity';
import { Agent } from '@polymind-inc/agent-framework';
import { serve } from '@polymind-inc/agent-framework/agentserver/node';
import { FoundryChatClient, FoundryProject } from '@polymind-inc/agent-framework/foundry';
import { FoundryToolbox, ResponsesHostServer } from '@polymind-inc/agent-framework/foundry/hosting';

const projectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
if (projectEndpoint === undefined) {
  throw new Error('Set FOUNDRY_PROJECT_ENDPOINT to your Foundry project endpoint.');
}
const toolboxName = process.env.FOUNDRY_TOOLBOX_NAME;
if (toolboxName === undefined) {
  throw new Error('Set FOUNDRY_TOOLBOX_NAME to the toolbox whose skills this agent should use.');
}

// One project handle for both components, so they share one identity and one token cache.
// `DefaultAzureCredential` covers `az login` locally and the container's managed identity on
// Foundry.
const project = new FoundryProject(projectEndpoint, new DefaultAzureCredential());

const toolbox = new FoundryToolbox({
  name: toolboxName,
  project,
  // Skills only: `getTools()` answers with nothing and the gateway is never asked to list tools.
  // Drop this line to give the model the toolbox's tools as well — the two compose, and a skill
  // body is often instructions for using exactly those tools.
  loadTools: false,
});

const server = new ResponsesHostServer({
  // Built through a factory, so construction-time work runs on the first request rather than at
  // startup. That is where `tools/list` runs once `loadTools` is dropped — and where a
  // CONSENT_REQUIRED refusal from a consent-gated tool source becomes an `oauth_consent_request`
  // item the caller can act on, instead of a container that never comes up.
  agent: async () =>
    new Agent({
      client: new FoundryChatClient({
        project,
        target: { model: process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME ?? 'gpt-4o-mini' },
      }),
      name: 'toolbox-skills-agent',
      instructions:
        'You are a support assistant. Skills carry the policies you must follow; load the relevant ' +
        'one before answering, and follow it exactly rather than improvising. Answer in one or two ' +
        'short sentences.',
      tools: await toolbox.getTools(),
      contextProviders: [
        toolbox.asSkillsProvider({
          // Unattended: there is no one to answer an approval request mid-turn, and reading a skill
          // the agent was configured with is the mechanism working as intended. Toolbox skills
          // carry no runnable scripts — `run_skill_script` answers "Script not found" — so its
          // default approval is left alone.
          approvals: { loadSkill: 'never_require', readSkillResource: 'never_require' },
          // Skills come from outside this codebase. A malformed or unsupported entry is skipped and
          // named here rather than taking the catalogue — or the turn — down with it.
          onSkillError: ({ skill, error }) => console.warn('[skill-error]', skill ?? '(unnamed)', error),
        }),
      ],
      // The hosting infrastructure owns the transcript and replays it each turn.
      defaultOptions: { store: false },
    }),
});

const { port } = await serve(server);
console.log(`listening on 0.0.0.0:${port}`);
