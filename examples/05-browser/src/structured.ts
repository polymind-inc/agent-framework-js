/**
 * Structured output — typed extraction rendered straight into the page.
 *
 * Pass a schema as `responseFormat` and the parsed, validated value lands on `response.value`,
 * typed from the schema — no JSON.parse, no manual checks. Here the value fills a definition
 * list, which is exactly the kind of UI code that benefits from the value already being typed.
 *
 * Run: `pnpm --filter example-05-browser dev`, then open /structured.html
 */
import { Agent } from '@polymind-inc/agent-framework';
import { OpenAIChatClient } from '@polymind-inc/agent-framework/openai';
import OpenAI from 'openai';
import { z } from 'zod';
import { bubble, element, errorText, readSettings } from './ui.js';

const EventInfo = z.object({
  title: z.string(),
  date: z.string().describe('ISO 8601 date'),
  location: z.string(),
  attendees: z.array(z.string()),
});

const log = element<HTMLElement>('#log');
const form = element<HTMLFormElement>('#composer');
const input = element<HTMLTextAreaElement>('#source');
const extractButton = element<HTMLButtonElement>('#extract');
const result = element<HTMLElement>('#result');

function renderValue(value: z.infer<typeof EventInfo>): void {
  const rows: [string, string][] = [
    ['Title', value.title],
    ['Date', value.date],
    ['Location', value.location],
    ['Attendees', value.attendees.join(', ')],
  ];
  const dl = document.createElement('dl');
  for (const [term, detail] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = detail;
    dl.append(dt, dd);
  }
  result.replaceChildren(dl);
}

async function extract(): Promise<void> {
  const text = input.value.trim();
  if (text === '' || extractButton.disabled) {
    return;
  }
  let agent: Agent;
  try {
    const settings = readSettings('gpt-4o-mini');
    agent = new Agent({
      client: new OpenAIChatClient({
        model: settings.model,
        client: new OpenAI({
          apiKey: settings.apiKey,
          dangerouslyAllowBrowser: true,
          ...(settings.baseURL === '' ? {} : { baseURL: settings.baseURL }),
        }),
      }),
      instructions: 'Extract the event described in the user text.',
    });
  } catch (error) {
    bubble(log, 'error', errorText(error));
    return;
  }
  extractButton.disabled = true;
  try {
    const response = await agent.run(text, { responseFormat: EventInfo });
    // A suspended response has no value yet, so narrow it before use.
    if (response.value === undefined) {
      throw new Error('The run stopped before producing its structured output.');
    }
    renderValue(response.value);
  } catch (error) {
    bubble(log, 'error', errorText(error));
  } finally {
    extractButton.disabled = false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void extract();
});
