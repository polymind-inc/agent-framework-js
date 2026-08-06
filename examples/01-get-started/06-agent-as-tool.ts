/**
 * 06 — Agent as a tool.
 *
 * `agent.asTool()` lets a coordinating agent delegate a focused task to another agent. The
 * sub-agent receives the tool argument as its input and returns its final text to the coordinator.
 *
 * Run: `OPENAI_API_KEY=... pnpm --filter example-01-get-started agent-as-tool`
 */
import { Agent } from '@polymind-inc/agent-framework';
import { OpenAIChatClient } from '@polymind-inc/agent-framework/openai';

const client = new OpenAIChatClient({ model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini' });

const researcher = new Agent({
  client,
  name: 'researcher',
  description: 'Produces concise factual notes for another agent.',
  instructions: 'Research the requested topic from your existing knowledge. Return three concise facts.',
});

const writer = new Agent({
  client,
  name: 'writer',
  instructions: 'Delegate factual research to the researcher, then write a short paragraph using its notes.',
  tools: [researcher.asTool()],
});

const response = await writer.run('Explain why type safety helps maintain a large codebase.');
console.log(response.text);
