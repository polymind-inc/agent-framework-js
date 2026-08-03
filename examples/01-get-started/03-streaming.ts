/**
 * 03 — Streaming and `finalResponse()`.
 *
 * Iterating gives you the text as it arrives; `finalResponse()` then folds the same run into the
 * complete response, with usage and finish reason. The stream is single-consumption: iterate it
 * once, then ask for the final result.
 *
 * Run: `OPENAI_API_KEY=... pnpm --filter example-01-get-started streaming`
 */
import { Agent, tool } from '@polymind-inc/agent-framework-core';
import { OpenAIChatClient } from '@polymind-inc/agent-framework-openai';
import { z } from 'zod';

const rollDice = tool({
  name: 'roll_dice',
  description: 'Roll a number of six-sided dice',
  parameters: z.object({ count: z.number().int().min(1).max(10) }),
  execute: ({ count }) => Array.from({ length: count }, () => 1 + Math.floor(Math.random() * 6)),
});

const agent = new Agent({
  client: new OpenAIChatClient({ model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini' }),
  instructions: 'You are a game master. Narrate dice rolls with a little flair.',
  tools: [rollDice],
});

const stream = agent.run('Roll three dice and narrate the results.');

for await (const update of stream) {
  if (update.text !== '') {
    process.stdout.write(update.text);
  }
  for (const content of update.contents) {
    if (content.type === 'function_result') {
      process.stdout.write(`\n  [rolled ${JSON.stringify(content.result)}]\n`);
    }
  }
}
process.stdout.write('\n');

const final = await stream.finalResponse();
console.log('---');
console.log('finishReason:', final.finishReason);
console.log('usage:', final.usageDetails);
console.log('messages:', final.messages.length);

// Breaking out early still runs cleanup (history persistence, provider afterRun hooks).
const partial = agent.run('Count from 1 to 20.');
let chunks = 0;
for await (const update of partial) {
  process.stdout.write(update.text);
  if (++chunks >= 5) {
    break;
  }
}
console.log('\n(stopped early after 5 updates)');
