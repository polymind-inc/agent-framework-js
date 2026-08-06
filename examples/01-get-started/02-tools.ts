/**
 * 02 — Tools.
 *
 * `tool()` takes any Standard Schema (Zod here) and infers the argument type of `execute`.
 * The agent runs the tool loop automatically: call → execute → feed the result back → answer.
 *
 * Run: `OPENAI_API_KEY=... pnpm --filter example-01-get-started tools`
 */
import { Agent, tool } from '@polymind-inc/agent-framework';
import { OpenAIChatClient } from '@polymind-inc/agent-framework/openai';
import { z } from 'zod';

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a location',
  parameters: z.object({
    location: z.string().describe('The city to get the weather for'),
  }),
  execute: async ({ location }) => {
    // `location` is typed as string, inferred from the Zod schema.
    console.log(`  (tool) get_weather(${location})`);
    return `${location} is sunny, 25°C`;
  },
});

const agent = new Agent({
  client: new OpenAIChatClient({ model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini' }),
  instructions: 'You are a helpful weather assistant.',
  tools: [getWeather],
});

const response = await agent.run('What is the weather in Tokyo and Osaka?');
console.log(response.text);

// The transcript contains the whole loop: the tool call and its result, not just the final text.
for (const message of response.messages) {
  for (const content of message.contents) {
    if (content.type === 'function_call') {
      console.log(`  call: ${content.name}(${JSON.stringify(content.arguments)})`);
    } else if (content.type === 'function_result') {
      console.log(`  result: ${JSON.stringify(content.result)}`);
    }
  }
}
