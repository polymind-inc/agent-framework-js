/**
 * 04 — Structured output.
 *
 * Pass a schema as `responseFormat` and the parsed, validated value lands on `response.value`,
 * typed from the schema. It works the same whether the run is awaited or streamed: the value is
 * parsed once the whole response is in.
 *
 * Run: `OPENAI_API_KEY=... pnpm --filter example-01-get-started structured-output`
 */
import { Agent } from '@polymind-inc/agent-framework';
import { OpenAIChatClient } from '@polymind-inc/agent-framework/openai';
import { z } from 'zod';

const Person = z.object({
  name: z.string(),
  age: z.number().int(),
  hobbies: z.array(z.string()),
});

const agent = new Agent({
  client: new OpenAIChatClient({ model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini' }),
  instructions: 'Extract structured data from the user text.',
});

const response = await agent.run('Taro Tanaka is 30 years old and enjoys hiking and photography.', {
  responseFormat: Person,
});

// A suspended response has no value yet, so narrow it before use.
if (response.value === undefined) {
  throw new Error('The run stopped before producing its structured output.');
}
console.log('name:   ', response.value.name);
console.log('age:    ', response.value.age);
console.log('hobbies:', response.value.hobbies.join(', '));
