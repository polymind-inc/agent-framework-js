/**
 * 03 — Anthropic.
 *
 * `AnthropicChatClient` is a `ChatClient` like any other, so tools, streaming, structured output
 * and sessions work unchanged — only the constructor differs. Pass an `AnthropicBedrock`,
 * `AnthropicVertex` or `AnthropicFoundry` client to reach Claude through those gateways.
 *
 * Run: `ANTHROPIC_API_KEY=... pnpm --filter example-03-extensibility anthropic`
 */

import type { AnthropicChatOptions } from '@polymind-inc/agent-framework-anthropic';
import { AnthropicChatClient } from '@polymind-inc/agent-framework-anthropic';
import { Agent, tool } from '@polymind-inc/agent-framework-core';
import { z } from 'zod';

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a location',
  parameters: z.object({ location: z.string() }),
  execute: async ({ location }) => {
    console.log(`  (tool) get_weather(${location})`);
    return `${location} is sunny, 25°C`;
  },
});

// Typing the agent with the provider's options keeps `run({ options })` fully checked.
const agent = new Agent<AnthropicChatOptions>({
  client: new AnthropicChatClient({ model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5' }),
  instructions: 'You are a concise assistant.',
  tools: [getWeather],
  // Messages API requires max_tokens; the framework defaults it to 1024 when you do not.
  defaultOptions: { maxTokens: 512 },
});

console.log((await agent.run('Weather in Tokyo?')).text);

// Streaming is the same hybrid stream as every other provider.
for await (const update of agent.run('Name three Japanese cities.')) {
  process.stdout.write(update.text);
}
console.log();

// Extended thinking is a provider option, and the reasoning arrives as `text_reasoning` content.
const reasoned = await agent.run('What is 17 * 23? Think it through.', {
  options: { maxTokens: 3000, thinking: { type: 'enabled', budgetTokens: 2000 } },
});
const thinking = reasoned.messages
  .flatMap((message) => message.contents)
  .filter((content) => content.type === 'text_reasoning');
console.log(`(${thinking.length} reasoning block(s)) ${reasoned.text}`);

// Structured output goes through Messages API's `output_config.format`.
const place = await agent.run('Where is Mount Fuji? Answer as JSON.', {
  responseFormat: z.object({ country: z.string(), prefecture: z.string() }),
});
console.log(place.value);
