/**
 * Provider-parity integration tests against the real OpenAI Responses API.
 *
 * Skipped unless `OPENAI_API_KEY` is set, so `pnpm -r test` stays offline by default.
 *
 * - `OPENAI_API_KEY` — the API key
 * - `OPENAI_MODEL` — model to use (default `gpt-4o-mini`)
 * - `OPENAI_HOSTED_TOOL_MODEL` — model for the hosted-tool test (default `gpt-4o-mini`)
 *
 * These cover behavior that only a real service can show:
 * the `output_item.done` path a hosted tool takes, an image referenced by `file_id`, and rich tool
 * output rendered as content parts.
 */
import type { Content } from '@polymind-inc/agent-framework-core';
import { Agent, textContent, tool } from '@polymind-inc/agent-framework-core';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { OpenAIChatClient } from './chat-client.js';
import { webSearchTool } from './hosted-tools.js';

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
const hostedToolModel = process.env.OPENAI_HOSTED_TOOL_MODEL ?? 'gpt-4o-mini';
const TIMEOUT = 120_000;

const client = (override?: string): OpenAIChatClient => new OpenAIChatClient({ model: override ?? model });

const typesOf = (response: { messages: Array<{ contents: Content[] }> }): string[] =>
  response.messages.flatMap((message) => message.contents.map((content) => content.type));

describe.runIf(apiKey !== undefined && apiKey !== '')('OpenAI provider parity (integration)', () => {
  it('produces the same transcript streamed as awaited when a hosted tool runs', {
    timeout: TIMEOUT,
  }, async () => {
    // A hosted tool reports nothing while it works: its call and result only exist on
    // `response.output_item.done`. If the streamed branch dropped what the awaited branch
    // keeps, the two transcripts would diverge here.
    const prompt = 'Search the web for the capital of France, then answer in one word.';
    const tools = [webSearchTool()];

    const awaited = await new Agent({ client: client(hostedToolModel), tools }).run(prompt);

    const stream = new Agent({ client: client(hostedToolModel), tools }).run(prompt);
    for await (const _update of stream) {
      // drain, so the streaming transport is the one exercised
    }
    const streamed = await stream.finalResponse();

    const awaitedTypes = new Set(typesOf(awaited));
    const streamedTypes = new Set(typesOf(streamed));
    console.log('[hosted] awaited:', [...awaitedTypes], 'streamed:', [...streamedTypes]);

    // The hosted call and its result are present on both paths.
    expect(awaitedTypes.has('search_tool_call')).toBe(true);
    expect(streamedTypes).toEqual(awaitedTypes);
    expect(streamed.text).not.toBe('');
  });

  it('references an uploaded image by file_id', { timeout: TIMEOUT }, async () => {
    // A 64×64 solid-red PNG.
    const red =
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwIqof2UTMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj12qxUDxeFqrFAAAAABJRU5ErkJggg==';
    const sdk = new OpenAI();
    const uploaded = await sdk.files.create({
      file: await OpenAI.toFile(Buffer.from(red, 'base64'), 'red.png', { type: 'image/png' }),
      purpose: 'vision',
    });

    try {
      const response = await new Agent({ client: client() }).run([
        {
          role: 'user',
          contents: [
            textContent('What single colour is this image? Answer with one word.'),
            {
              type: 'uri',
              // The service resolves the image from the id; the URI is only a local handle.
              uri: '',
              mediaType: 'image/png',
              additionalProperties: { file_id: uploaded.id },
            },
          ],
        },
      ]);

      console.log('[file_id]', uploaded.id, '->', response.text);
      expect(response.text.toLowerCase()).toContain('red');
    } finally {
      // The test owns this file, so it cleans it up rather than leaving it on the account.
      await sdk.files.delete(uploaded.id).catch(() => undefined);
    }
  });

  it('sends rich tool output as image parts the model can read', { timeout: TIMEOUT }, async () => {
    const red =
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwIqof2UTMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj12qxUDxeFqrFAAAAABJRU5ErkJggg==';
    const screenshot = tool({
      name: 'take_screenshot',
      description: 'Take a screenshot of the current screen',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: (async () => [
        { type: 'text', text: 'screenshot captured' },
        { type: 'data', uri: `data:image/png;base64,${red}`, mediaType: 'image/png' },
      ]) as never,
    });

    const agent = new Agent({
      client: client(),
      instructions: 'Call take_screenshot, then say what single colour fills the image it returned.',
      tools: [screenshot],
    });
    const response = await agent.run('Take a screenshot and tell me its colour in one word.');

    const result = response.messages
      .flatMap((message) => message.contents)
      .find((content) => content.type === 'function_result') as { items?: unknown[] } | undefined;

    // The tool result went out as `input_image` parts rather than JSON text — the model can only
    // name the colour if it actually saw the image.
    expect(result?.items).toHaveLength(2);
    console.log('[rich-output]', response.text);
    expect(response.text.toLowerCase()).toContain('red');
  });
});
