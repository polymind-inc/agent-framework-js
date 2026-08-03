/**
 * 02 — Multi-turn conversations, including a question from the agent.
 *
 * A remote agent can stop and ask for something before it can answer. The session remembers which
 * task that was, so the next message continues it rather than starting a new one — which is what
 * makes a follow-up read as an answer to the question rather than as a fresh request.
 *
 * Start the local agent first, then run:
 * `pnpm --filter example-04-a2a multi-turn`
 */
import { A2AAgent } from '@polymind-inc/agent-framework-a2a';

const agent = await A2AAgent.fromUrl(process.env.A2A_AGENT_URL ?? 'http://localhost:4100');
const session = agent.createSession();

// The agent cannot answer without an invoice number, so it asks for one.
const asked = await agent.run('Has my invoice been paid?', { session });
console.log('agent :', asked.text);

// A session that ends on a question keeps the task open. Answering continues it.
const answered = await agent.run('42', { session });
console.log('agent :', answered.text);

// A finished task is referenced as prior context rather than continued, so the agent can see what
// came before without the new question being taken as more input for the old one.
const next = await agent.run('And invoice 43?', { session });
console.log('agent :', next.text);

// Sessions are plain JSON: save one, restore it, and the conversation carries on.
const saved = JSON.stringify(session);
const restored = agent.deserializeSession(JSON.parse(saved));
console.log('\ncontext:', restored.serviceSessionId);
console.log('resumed:', (await agent.run('And invoice 44?', { session: restored })).text);
