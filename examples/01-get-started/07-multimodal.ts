/**
 * 07 — Multimodal input.
 *
 * `dataContent()` turns local bytes into inline content. Text and content items passed in one
 * array become a single user message, so the model receives the instruction and image together.
 *
 * Run: `OPENAI_API_KEY=... pnpm --filter example-01-get-started multimodal ./photo.png`
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { Agent, dataContent } from '@polymind-inc/agent-framework';
import { OpenAIChatClient } from '@polymind-inc/agent-framework/openai';

const imagePath = process.argv[2];
if (imagePath === undefined) {
  console.error('Pass the path to a PNG, JPEG, GIF, or WebP image.');
  process.exit(1);
}

const mediaTypes: Readonly<Record<string, string>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const mediaType = mediaTypes[extname(imagePath).toLowerCase()];
if (mediaType === undefined) {
  console.error('The image must be PNG, JPEG, GIF, or WebP.');
  process.exit(1);
}

const agent = new Agent({
  client: new OpenAIChatClient({ model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini' }),
  instructions: 'Describe images accurately and concisely.',
});

const image = dataContent(await readFile(imagePath), mediaType);
const response = await agent.run(['Describe this image in one sentence.', image]);
console.log(response.text);
