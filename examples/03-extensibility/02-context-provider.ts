/**
 * 02 — A custom ContextProvider.
 *
 * A provider sees every run twice: `beforeRun` to contribute context (messages, instructions,
 * tools), and `afterRun` to learn from the result. Its state lives in its own partition of the
 * session, so it survives serialization and never collides with another provider's.
 *
 * Run: `OPENAI_API_KEY=... pnpm --filter example-03-extensibility context-provider`
 */
import type {
  AnyFunctionTool,
  ContextProvider,
  ProviderAfterRunContext,
  ProviderRunContext,
} from '@polymind-inc/agent-framework-core';
import { Agent, textContent, tool } from '@polymind-inc/agent-framework-core';
import { OpenAIChatClient } from '@polymind-inc/agent-framework-openai';
import { z } from 'zod';

/**
 * Remembers facts the user states about themselves, and replays them into later runs.
 *
 * ## Security considerations
 *
 * Everything a provider injects is indistinguishable from user input to the model. Remembered
 * text is untrusted: it came from a conversation, so it can carry an instruction aimed at the
 * model. Never remember credentials, and keep memories out of authorization decisions.
 */
class MemoryProvider implements ContextProvider {
  readonly sourceId = 'memory';
  /** Extra session-state keys this provider claims; the agent fails fast on a collision. */
  readonly stateKeys = ['memoryStats'];

  beforeRun(ctx: ProviderRunContext): void {
    const facts = (ctx.state.facts as string[] | undefined) ?? [];
    if (facts.length > 0) {
      // Injected messages are stamped with this provider's source id automatically.
      ctx.extendMessages([
        { role: 'user', contents: [textContent(`What I know about the user: ${facts.join('; ')}`)] },
      ]);
    }
    ctx.extendInstructions('Use what you already know about the user; do not ask twice.');
    // Providers can also contribute tools for the run.
    ctx.extendTools([remember(ctx)]);
  }

  afterRun(ctx: ProviderAfterRunContext): void {
    if (ctx.error !== undefined) {
      return;
    }
    const stats = (ctx.session.state.memoryStats as { runs?: number } | undefined) ?? {};
    ctx.session.state.memoryStats = { runs: (stats.runs ?? 0) + 1 };
  }
}

/** The tool the provider hands the model so it can write to the provider's own state. */
function remember(ctx: ProviderRunContext): AnyFunctionTool {
  return tool({
    name: 'remember',
    description: 'Remember a durable fact about the user',
    parameters: z.object({ fact: z.string() }),
    execute: async ({ fact }) => {
      const facts = (ctx.state.facts as string[] | undefined) ?? [];
      ctx.state.facts = [...facts, fact];
      return `remembered: ${fact}`;
    },
  });
}

const agent = new Agent({
  client: new OpenAIChatClient({ model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini' }),
  instructions: 'You are a helpful assistant.',
  contextProviders: [new MemoryProvider()],
});

const session = agent.createSession();

console.log((await agent.run('My name is Rin and I only drink black coffee.', { session })).text);
console.log((await agent.run('Order me a coffee.', { session })).text);

// Each provider owns its own slot of the session, and the session is plain JSON.
console.log('memory state:', JSON.stringify(session.state.memory));
console.log('stats:', JSON.stringify(session.state.memoryStats));
