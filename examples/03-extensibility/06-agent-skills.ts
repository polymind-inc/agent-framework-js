/**
 * 06 — Agent Skills (progressive disclosure).
 *
 * A skill is domain knowledge the agent pulls in only when it needs it. The provider advertises
 * just the names and descriptions in the system prompt; the model calls `load_skill` to get a
 * body, `read_skill_resource` for a referenced document, and `run_skill_script` to run an action.
 * Twenty skills therefore cost a couple of thousand tokens per run instead of twenty full bodies.
 *
 * Two ways of authoring one are shown: `SKILL.md` files on disk, and a skill defined in code.
 *
 * The runtime-agnostic root has no filesystem — it runs in browsers and on edge runtimes. Node
 * applications use the hardened `directorySkillsSource` from the `/node` subpath instead.
 *
 * Run: `OPENAI_API_KEY=... pnpm --filter example-03-extensibility skills`
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Agent,
  aggregateSkills,
  cacheSkills,
  inlineSkill,
  inMemorySkillsSource,
  SKILL_TOOL_NAMES,
  skillResource,
  skillScript,
  skillsProvider,
  toolApprovalMiddleware,
} from '@polymind-inc/agent-framework';
import { directorySkillsSource } from '@polymind-inc/agent-framework/node';
import { OpenAIChatClient } from '@polymind-inc/agent-framework/openai';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));

/** A skill defined in code, with an action the model can run rather than reason through. */
const roundTrip = inlineSkill({
  name: 'shipping-estimate',
  description: 'Estimates a shipping cost from weight and destination zone.',
  instructions: [
    'Use the rate-card resource to find the zone, then run the estimate script.',
    'Never compute the total yourself: the script applies surcharges the rate card does not list.',
  ].join('\n'),
  resources: [
    skillResource({
      name: 'rate-card',
      description: 'Zones and their per-kilogram rate',
      content: 'zone A: 4.20/kg\nzone B: 6.80/kg\nzone C: 11.50/kg',
    }),
  ],
  scripts: [
    skillScript({
      name: 'estimate',
      description: 'Returns the total cost for a weight in a zone',
      parameters: z.object({
        weightKg: z.number().describe('Parcel weight in kilograms'),
        zone: z.enum(['A', 'B', 'C']),
      }),
      run: ({ weightKg, zone }) => {
        const rate = { A: 4.2, B: 6.8, C: 11.5 }[zone];
        const surcharge = weightKg > 20 ? 15 : 0;
        return { total: Number((weightKg * rate + surcharge).toFixed(2)), surcharge };
      },
    }),
  ],
});

const skills = aggregateSkills([
  cacheSkills(directorySkillsSource({ paths: [join(here, 'skills')] })),
  inMemorySkillsSource([roundTrip]),
]);

const agent = new Agent({
  client: new OpenAIChatClient({ model: 'gpt-4o-mini' }),
  name: 'skills-agent',
  instructions: 'You are a logistics assistant. Answer in one or two sentences.',
  contextProviders: [
    skillsProvider(skills, {
      // Every skill tool requires approval by default, and that default cannot be bypassed from
      // middleware — so this sample, which runs unattended, relaxes all three here. The middleware
      // below is then the policy in charge of scripts: with `allow` they run, and swapping it for
      // `require` puts a human back in front of them.
      approvals: {
        loadSkill: 'never_require',
        readSkillResource: 'never_require',
        runSkillScript: 'never_require',
      },
      onSkillError: (failure) => console.warn('[skill-error]', failure.skill, failure.error),
    }),
  ],
  middleware: [toolApprovalMiddleware([{ tools: SKILL_TOOL_NAMES.runSkillScript, decision: 'allow' }])],
});

const session = agent.createSession();
for (const question of [
  'How many pounds is 12 kilograms?',
  'What does it cost to ship a 25 kg parcel to zone B?',
]) {
  const response = await agent.run(question, { session });
  console.log(`\n[you] ${question}\n[agent] ${response.text}`);

  const called = response.messages
    .flatMap((message) => message.contents)
    .filter((content) => content.type === 'function_call')
    .map((content) => `${content.name}(${JSON.stringify(content.arguments)})`);
  console.log('[skill calls]', called.length === 0 ? '(none)' : called.join(' → '));
}
