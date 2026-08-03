/**
 * 05 — Sessions and persistence.
 *
 * A session carries the conversation across runs. It is plain JSON, so persisting a conversation
 * is `JSON.stringify(session)` and resuming it is `agent.deserializeSession(...)`.
 *
 * `node:fs` is used here on purpose: it belongs in the application, not in
 * `@polymind-inc/agent-framework-core`, which stays runtime-agnostic.
 *
 * Run: `OPENAI_API_KEY=... pnpm --filter example-01-get-started session`
 */
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@polymind-inc/agent-framework-core';
import { OpenAIChatClient } from '@polymind-inc/agent-framework-openai';

const agent = new Agent({
  client: new OpenAIChatClient({ model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini' }),
  name: 'Assistant',
  instructions: 'You are a helpful assistant with a good memory. Answer briefly.',
});

const sessionFile = join(tmpdir(), 'agent-framework-example-session.json');

// --- Turn 1 and 2 in one process ---
const session = agent.createSession();

const first = await agent.run('My name is Taro, and my hobby is hiking.', { session });
console.log('1>', first.text);

const second = await agent.run('What was my hobby?', { session });
console.log('2>', second.text);

// --- Persist ---
await writeFile(sessionFile, JSON.stringify(session), 'utf8');
console.log(`(saved to ${sessionFile})`);

// --- Restore in a "later process" and keep going ---
const restored = agent.deserializeSession(JSON.parse(await readFile(sessionFile, 'utf8')));
console.log('(restored session', restored.sessionId, ')');

const third = await agent.run('Do you remember my name as well?', { session: restored });
console.log('3>', third.text);
