/**
 * Integration tests against the real OpenAI Responses API.
 *
 * Skipped unless `RUN_INTEGRATION_TESTS=1` and `OPENAI_API_KEY` are set, so ordinary test runs
 * stay offline. The model defaults to `gpt-4o-mini`; override with `OPENAI_MODEL`.
 */
import { Agent, tool } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import { OpenAIChatClient } from './chat-client.js';

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
const TIMEOUT = 60_000;

describe.runIf(process.env.RUN_INTEGRATION_TESTS === '1' && apiKey !== undefined && apiKey !== '')(
  'OpenAI Responses API (integration)',
  () => {
    const client = (): OpenAIChatClient => new OpenAIChatClient({ model });

    it('answers a basic prompt and reports usage', { timeout: TIMEOUT }, async () => {
      const response = await new Agent({ client: client() }).run('Reply with the single word: pong');

      expect(response.text.toLowerCase()).toContain('pong');
      expect(response.responseId).toBeDefined();
      expect(response.finishReason).toBe('stop');
      expect(response.usageDetails?.inputTokenCount).toBeGreaterThan(0);
      expect(response.usageDetails?.outputTokenCount).toBeGreaterThan(0);
    });

    it('runs the tool loop end to end', { timeout: TIMEOUT }, async () => {
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
        execute: async (input) => {
          executed++;
          return `${String((input as { location?: unknown }).location)}: sunny, 25C`;
        },
      });

      const response = await new Agent({
        client: client(),
        instructions: 'Use the get_weather tool to answer weather questions.',
        tools: [getWeather],
      }).run('What is the weather in Tokyo right now?');

      expect(executed).toBe(1);
      const types = response.messages.flatMap((m) => m.contents.map((c) => c.type));
      expect(types).toContain('function_call');
      expect(types).toContain('function_result');
      expect(response.text.toLowerCase()).toContain('sunny');
    });

    it('streams updates and folds them into the same final response', { timeout: TIMEOUT }, async () => {
      const stream = new Agent({ client: client() }).run('Count from 1 to 5 as digits, nothing else.');

      let streamedText = '';
      for await (const update of stream) {
        streamedText += update.text;
      }
      const final = await stream.finalResponse();

      expect(streamedText).toBe(final.text);
      expect(final.text).toContain('5');
      expect(final.usageDetails?.totalTokenCount).toBeGreaterThan(0);
    });

    it('parses structured output into value', { timeout: TIMEOUT }, async () => {
      const response = await new Agent({ client: client() }).run('Taro is 30 years old.', {
        responseFormat: {
          name: 'person',
          schema: {
            type: 'object',
            properties: { name: { type: 'string' }, age: { type: 'integer' } },
            required: ['name', 'age'],
            additionalProperties: false,
          },
        },
      });

      expect(response.value).toMatchObject({ age: 30 });
    });

    it('keeps history across turns in one session', { timeout: TIMEOUT }, async () => {
      const agent = new Agent({ client: client(), instructions: 'Answer briefly.' });
      const session = agent.createSession();

      await agent.run('My favourite colour is vermilion. Remember it.', { session });
      const second = await agent.run('What is my favourite colour? One word only.', { session });

      expect(second.text.toLowerCase()).toContain('vermilion');
    });
  },
);
