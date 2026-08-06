/**
 * 01 — Talking to a remote A2A agent.
 *
 * `A2AAgent.fromUrl` resolves the agent card from a well-known URI and picks a transport from the
 * interfaces the card advertises. The result is an agent like any other: awaiting the run blocks
 * until the answer is complete, iterating it streams the parts as they arrive.
 *
 * Start the local agent first (`pnpm --filter example-04-a2a server`), then run:
 * `pnpm --filter example-04-a2a remote-agent`
 */
import { A2AAgent } from '@polymind-inc/agent-framework/a2a';

const url = process.env.A2A_AGENT_URL ?? 'http://localhost:4100';

const agent = await A2AAgent.fromUrl(url);
console.log(`Connected to "${agent.name}" — ${agent.description}\n`);

// Awaited: one blocking request, folded into a finished response.
const session = agent.createSession();
const response = await agent.run('Was invoice 42 paid?', { session });
console.log('awaited :', response.text);
console.log('  finish:', response.finishReason);
// The remote side owns the conversation; its id is what the session carries.
console.log('  context:', session.serviceSessionId);

// Streamed: the same turn, delivered as it is produced.
const streamed = agent.createSession();
process.stdout.write('\nstreamed: ');
const stream = agent.run('Was invoice 99 paid?', { session: streamed });
for await (const update of stream) {
  process.stdout.write(update.text);
}
const final = await stream.finalResponse();
console.log(`\n  finish: ${final.finishReason}`);
