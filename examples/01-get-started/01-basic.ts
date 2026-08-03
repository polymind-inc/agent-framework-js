/**
 * 01 — Basic conversation.
 *
 * The same `run()` call serves both modes: `await` it for a complete response, `for await` it to
 * stream. Nothing is sent until the result is consumed.
 *
 * Run: `OPENAI_API_KEY=... pnpm --filter example-01-get-started basic`
 */
import { Agent } from '@polymind-inc/agent-framework-core';
import { OpenAIChatClient } from '@polymind-inc/agent-framework-openai';

const agent = new Agent({
  client: new OpenAIChatClient({ model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini' }),
  name: 'Assistant',
  instructions: 'You are a helpful assistant. Answer in one short sentence.',
});

// Non-streaming: await the run.
const response = await agent.run('Hello. Please introduce yourself in one sentence.');
console.log('[await]', response.text);
console.log('[usage]', response.usageDetails);

// Streaming: iterate the same call shape.
process.stdout.write('[for await] ');
for await (const update of agent.run('Now tell me one advantage of TypeScript.')) {
  process.stdout.write(update.text);
}
process.stdout.write('\n');
