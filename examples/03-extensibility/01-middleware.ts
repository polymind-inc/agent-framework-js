/**
 * 01 — Middleware.
 *
 * Two kinds, both `(ctx, next)`:
 *
 * - `agentMiddleware` wraps a whole `run()` — logging, caching, guardrails on the answer;
 * - `functionMiddleware` wraps one tool invocation — timing, argument rewriting, policy.
 *
 * They compose as an onion in registration order, so the first one registered is the outermost.
 *
 * Run: `OPENAI_API_KEY=... pnpm --filter example-03-extensibility middleware`
 */
import {
  Agent,
  agentMiddleware,
  agentResponse,
  functionMiddleware,
  textContent,
  tool,
  toolApprovalMiddleware,
} from '@polymind-inc/agent-framework-core';
import { OpenAIChatClient } from '@polymind-inc/agent-framework-openai';
import { z } from 'zod';

/** Observes a run from the outside: what went in, what came out, how long it took. */
const logging = agentMiddleware(async (ctx, next) => {
  const started = performance.now();
  console.log(`→ run (${ctx.stream ? 'streaming' : 'awaited'}), ${ctx.messages.length} message(s)`);
  await next();
  const elapsed = Math.round(performance.now() - started);
  // On an awaited run the response is available here; while streaming, use ctx.onResult.
  console.log(`← ${elapsed}ms ${ctx.response === undefined ? '(streamed)' : `"${ctx.response.text}"`}`);
});

/** Answers without calling the model at all when the question is one we already know. */
const cache = new Map<string, string>([['what is 2+2?', '4']]);
const cached = agentMiddleware(async (ctx, next) => {
  const question = ctx.messages
    .at(-1)
    ?.contents.map((c) => (c.type === 'text' ? c.text : ''))
    .join('');
  const hit = cache.get(question?.trim().toLowerCase() ?? '');
  if (hit !== undefined) {
    // Assigning a response short-circuits the run: the agent is never invoked.
    ctx.response = agentResponse({ messages: [{ role: 'assistant', contents: [textContent(hit)] }] });
    return;
  }
  await next();
});

/** Times every tool call, and could just as easily rewrite `ctx.arguments` or `ctx.result`. */
const timing = functionMiddleware(async (ctx, next) => {
  const started = performance.now();
  await next();
  console.log(`  (tool) ${ctx.tool.name} took ${Math.round(performance.now() - started)}ms`);
});

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a location',
  parameters: z.object({ location: z.string() }),
  execute: async ({ location }) => `${location} is sunny, 25°C`,
});

const sendEmail = tool({
  name: 'send_email',
  description: 'Send an email',
  parameters: z.object({ to: z.string(), body: z.string() }),
  execute: async ({ to }) => `sent to ${to}`,
});

const agent = new Agent({
  client: new OpenAIChatClient({ model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini' }),
  instructions: 'You are a helpful assistant.',
  tools: [getWeather, sendEmail],
  middleware: [
    logging,
    cached,
    timing,
    // Rules are evaluated in order and the first match decides. This one sends every `send_email`
    // to a human while leaving `get_weather` alone.
    toolApprovalMiddleware([{ tools: 'send_email', reason: 'Sending mail is irreversible' }]),
  ],
});

// 1. The cache answers this one; the model is never called.
console.log((await agent.run('What is 2+2?')).text);

// 2. This one reaches the model, and the tool call is timed.
console.log((await agent.run('Weather in Tokyo?')).text);

// 3. This one stops for approval instead of sending anything.
const session = agent.createSession();
const pending = await agent.run('Email alice@example.com saying hello', { session });
for (const request of pending.userInputRequests) {
  console.log('needs approval:', JSON.stringify(request));
}

// A per-run middleware is applied inside the agent's own ones.
const quiet = agentMiddleware(async (ctx, next) => {
  ctx.onUpdate((update) => {
    process.stdout.write(update.text);
    return undefined; // returning undefined leaves the update unchanged
  });
  await next();
});
for await (const _update of agent.run('Say hi in five words.', { middleware: [quiet] })) {
  // ctx.onUpdate already printed it
}
console.log();
