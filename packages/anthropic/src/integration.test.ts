/**
 * Integration tests against the real Anthropic Messages API.
 *
 * Skipped unless `RUN_INTEGRATION_TESTS=1` and `ANTHROPIC_API_KEY` are set, so ordinary test runs
 * stay offline.
 *
 * - `ANTHROPIC_API_KEY` — the API key
 * - `ANTHROPIC_MODEL` — model to use (default `claude-haiku-4-5-20251001`, the cheapest current one)
 * - `ANTHROPIC_THINKING_MODEL` — model for the extended-thinking test (default: the same one)
 *
 * What is worth checking here is what a mock cannot show: the wire shapes the service actually
 * accepts (role regrouping around tool_use/tool_result, image blocks, `output_config.format`), the
 * signature round-trip that makes replayed thinking valid, and the streamed-usage arithmetic —
 * Anthropic streams *cumulative* usage, so an error there only appears against a real stream.
 */
import type {
  Content,
  FunctionApprovalRequestContent,
  TextReasoningContent,
} from '@polymind-inc/agent-framework-core';
import {
  Agent,
  approvalResponse,
  mergeChatUpdates,
  textContent,
  tool,
} from '@polymind-inc/agent-framework-core';
import { assert, describe, expect, it } from 'vitest';
import { AnthropicChatClient } from './chat-client.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';
const thinkingModel = process.env.ANTHROPIC_THINKING_MODEL ?? model;
const TIMEOUT = 120_000;

function client(override?: string): AnthropicChatClient {
  assert.exists(apiKey);
  return new AnthropicChatClient({ model: override ?? model, apiKey });
}

const contentsOf = (response: { messages: Array<{ contents: Content[] }> }): Content[] =>
  response.messages.flatMap((message) => message.contents);

describe.runIf(process.env.RUN_INTEGRATION_TESTS === '1' && apiKey !== undefined && apiKey !== '')(
  'Anthropic (integration)',
  () => {
    it('answers a basic prompt and reports usage', { timeout: TIMEOUT }, async () => {
      const response = await new Agent({ client: client() }).run('Reply with the single word: pong');

      expect(response.text.toLowerCase()).toContain('pong');
      expect(response.usageDetails?.inputTokenCount).toBeGreaterThan(0);
      expect(response.usageDetails?.outputTokenCount).toBeGreaterThan(0);
    });

    it('runs the tool loop, replaying the call and result as the API demands', {
      timeout: TIMEOUT,
    }, async () => {
      let executed = 0;
      const getWeather = tool({
        name: 'get_weather',
        description: 'Get the current weather for a location',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
          additionalProperties: false,
        },
        execute: async () => {
          executed++;
          return 'Sunny, 25C';
        },
      });

      const agent = new Agent({ client: client(), tools: [getWeather] });
      const response = await agent.run("What's the weather in Tokyo? Use the tool.");

      // The second request carries the tool_use on an assistant turn and the tool_result on a user
      // turn; the service rejects the request outright if that regrouping is wrong.
      expect(executed).toBe(1);
      expect(response.text).not.toBe('');
    });

    it('produces the same transcript streamed as awaited', { timeout: TIMEOUT }, async () => {
      const prompt = 'List exactly three Japanese cities, comma separated, nothing else.';
      const messages = [{ role: 'user' as const, contents: [textContent(prompt)] }];

      const awaited = await client().getResponse(messages, { temperature: 0 });

      const stream = client().getResponse(messages, { temperature: 0 });
      const updates = [];
      for await (const update of stream) {
        updates.push(update);
      }
      const folded = await stream.finalResponse();
      const refolded = mergeChatUpdates(updates);

      // Invariant: how the caller consumed the response cannot change what it contains.
      expect(folded.messages.flatMap((m) => m.contents.map((c) => c.type))).toEqual(
        awaited.messages.flatMap((m) => m.contents.map((c) => c.type)),
      );
      expect(refolded.text).toBe(folded.text);
      expect(folded.finishReason).toBe(awaited.finishReason);
      expect(folded.model).toBe(awaited.model);
    });

    it('turns cumulative streamed usage into a correct total', { timeout: TIMEOUT }, async () => {
      const stream = client().getResponse([
        { role: 'user', contents: [textContent('Count from 1 to 20, numbers only.')] },
      ]);
      const perUpdate: number[] = [];
      for await (const update of stream) {
        for (const content of update.contents) {
          if (content.type === 'usage') {
            perUpdate.push(content.usageDetails.outputTokenCount ?? 0);
          }
        }
      }
      const folded = await stream.finalResponse();

      // Anthropic streams a running total; the client emits increments so the fold sums back to the
      // real figure instead of double-counting the seed.
      expect(perUpdate.length).toBeGreaterThan(1);
      const summed = perUpdate.reduce((total, value) => total + value, 0);
      expect(folded.usageDetails?.outputTokenCount).toBe(summed);
      expect(summed).toBeGreaterThan(10);
      console.log(`[usage] increments=${JSON.stringify(perUpdate)} total=${summed}`);
    });

    it('round-trips extended thinking, signature included', { timeout: TIMEOUT }, async () => {
      const agent = new Agent({ client: client(thinkingModel) });
      const session = agent.createSession();

      const first = await agent.run('What is 17 * 23? Think it through, then give the number.', {
        session,
        options: { maxTokens: 3000, thinking: { type: 'enabled', budgetTokens: 2000 } },
      });

      const reasoning = contentsOf(first).filter(
        (content): content is TextReasoningContent => content.type === 'text_reasoning',
      );
      expect(reasoning.length).toBeGreaterThan(0);
      // The opaque signature is what makes a replayed thinking block acceptable to the service.
      expect(reasoning.some((content) => typeof content.protectedData === 'string')).toBe(true);
      expect(first.text).toContain('391');

      // The follow-up replays the thinking, signature and all. A broken thinking-block mapping
      // fails here with a 400 rather than silently degrading.
      const second = await agent.run('Now multiply that result by 2.', {
        session,
        options: { maxTokens: 3000, thinking: { type: 'enabled', budgetTokens: 2000 } },
      });
      expect(second.text).toContain('782');
    });

    it('parses structured output through output_config.format', { timeout: TIMEOUT }, async () => {
      const response = await new Agent({ client: client() }).run('Where is Mount Fuji?', {
        responseFormat: {
          name: 'location',
          schema: {
            type: 'object',
            properties: { country: { type: 'string' }, prefecture: { type: 'string' } },
            required: ['country', 'prefecture'],
            additionalProperties: false,
          },
        },
      });

      expect(response.value).toBeDefined();
      expect(String((response.value as { country: string }).country)).not.toBe('');
      console.log('[structured]', JSON.stringify(response.value));
    });

    it('sends an image and gets a description of it', { timeout: TIMEOUT }, async () => {
      // A 64×64 solid-red PNG, so the answer is checkable. Big enough for the service to accept it:
      // a 2×2 image is rejected with "Could not process image".
      const red =
        'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwIqof2UTMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj12qxUDxeFqrFAAAAABJRU5ErkJggg==';
      const response = await new Agent({ client: client() }).run([
        {
          role: 'user',
          contents: [
            textContent('What single colour is this image? Answer with one word.'),
            { type: 'data', uri: `data:image/png;base64,${red}`, mediaType: 'image/png' },
          ],
        },
      ]);

      console.log('[image]', response.text);
      expect(response.text.toLowerCase()).toContain('red');
    });

    it('surfaces a tool that needs approval, then runs it once approved', { timeout: TIMEOUT }, async () => {
      let executed = 0;
      const transfer = tool({
        name: 'transfer_funds',
        description: 'Transfer money between accounts',
        parameters: {
          type: 'object',
          properties: { amount: { type: 'number' } },
          required: ['amount'],
          additionalProperties: false,
        },
        approvalMode: 'always_require',
        execute: async () => {
          executed++;
          return 'transfer complete';
        },
      });

      const agent = new Agent({ client: client(), tools: [transfer] });
      const session = agent.createSession();

      // The tool choice is forced so the test measures the framework rather than whether this
      // particular model felt like calling a tool; it also exercises the `{required:[name]}` →
      // `{type:'tool', name}` mapping against the live API.
      const pending = await agent.run('Transfer 500.', {
        session,
        options: { toolChoice: { required: ['transfer_funds'] } },
      });
      expect(pending.userInputRequests).toHaveLength(1);
      expect(executed).toBe(0);

      const resumed = await agent.run(
        approvalResponse(pending.userInputRequests[0] as FunctionApprovalRequestContent, true),
        { session },
      );

      expect(executed).toBe(1);
      expect(resumed.text).not.toBe('');
    });
  },
);
