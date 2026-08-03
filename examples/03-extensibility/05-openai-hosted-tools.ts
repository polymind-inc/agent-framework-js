/**
 * 05 — OpenAI hosted tools.
 *
 * Hosted tools execute inside the model provider rather than this process. This example gives one
 * agent web search for current information and Code Interpreter for calculations.
 *
 * Run: `OPENAI_API_KEY=... OPENAI_MODEL=... pnpm --filter example-03-extensibility hosted-tools`
 */
import { Agent } from '@polymind-inc/agent-framework-core';
import { codeInterpreterTool, OpenAIChatClient, webSearchTool } from '@polymind-inc/agent-framework-openai';

const model = process.env.OPENAI_MODEL;
if (model === undefined) {
  console.error('Set OPENAI_MODEL to a model that supports web search and Code Interpreter.');
  process.exit(1);
}

const agent = new Agent({
  client: new OpenAIChatClient({ model }),
  instructions: 'Use the provider-hosted tools when the request needs them. Cite web sources.',
  tools: [webSearchTool({ searchContextSize: 'low' }), codeInterpreterTool()],
});

const searched = await agent.run(
  'Use web search to find the latest stable Node.js release and summarize the result with sources.',
);
console.log('[web search]', searched.text);

const calculated = await agent.run(
  'Use Code Interpreter to calculate the first 20 Fibonacci numbers and report their sum.',
);
console.log('[code interpreter]', calculated.text);
