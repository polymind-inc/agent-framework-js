/**
 * Anthropic — the same browser chat, different provider.
 *
 * `AnthropicChatClient` is a `ChatClient` like any other, so the page code is identical to the
 * OpenAI chat — only the client construction differs. The Anthropic SDK has the same explicit
 * browser opt-in as OpenAI's, and CORS on the Anthropic API allows direct calls from a page.
 *
 * Run: `pnpm --filter example-05-browser dev`, then open /anthropic.html
 */
import Anthropic from '@anthropic-ai/sdk';
import { Agent, type AgentSession, tool } from '@polymind-inc/agent-framework';
import { AnthropicChatClient } from '@polymind-inc/agent-framework/anthropic';
import { z } from 'zod';
import { bubble, chip, element, errorText, readSettings } from './ui.js';

const setTheme = tool({
  name: 'set_theme',
  description: 'Switch the page between the light and dark theme',
  parameters: z.object({ theme: z.enum(['light', 'dark']) }),
  execute: ({ theme }) => {
    document.documentElement.dataset.theme = theme;
    return `The page is now in ${theme} mode.`;
  },
});

const getLocalTime = tool({
  name: 'get_local_time',
  description: "Read the visitor's current local time and time zone from the browser",
  parameters: z.object({}),
  execute: () => ({
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    localTime: new Date().toString(),
  }),
});

const log = element<HTMLElement>('#log');
const composer = element<HTMLFormElement>('#composer');
const promptInput = element<HTMLInputElement>('#prompt');
const sendButton = element<HTMLButtonElement>('#send');

let agent: Agent | undefined;
let session: AgentSession | undefined;
let agentSettings = '';

function currentAgent(): Agent {
  const settings = readSettings('claude-sonnet-4-5');
  const fingerprint = JSON.stringify(settings);
  if (agent === undefined || fingerprint !== agentSettings) {
    agent = new Agent({
      client: new AnthropicChatClient({
        model: settings.model,
        client: new Anthropic({
          apiKey: settings.apiKey,
          dangerouslyAllowBrowser: true,
          ...(settings.baseURL === '' ? {} : { baseURL: settings.baseURL }),
        }),
      }),
      name: 'BrowserAssistant',
      instructions:
        'You are a cheerful assistant living inside a web page. Your tools can restyle the page ' +
        "and read the visitor's clock. Answer briefly.",
      tools: [setTheme, getLocalTime],
    });
    agentSettings = fingerprint;
  }
  return agent;
}

async function send(): Promise<void> {
  const text = promptInput.value.trim();
  if (text === '' || sendButton.disabled) {
    return;
  }
  let active: Agent;
  try {
    active = currentAgent();
  } catch (error) {
    bubble(log, 'error', errorText(error));
    return;
  }
  promptInput.value = '';
  sendButton.disabled = true;
  bubble(log, 'user', text);
  let reply: HTMLElement | undefined;
  try {
    session ??= active.createSession();
    const stream = active.run(text, { session });
    for await (const update of stream) {
      for (const content of update.contents) {
        if (content.type === 'function_call') {
          chip(log, `tool: ${content.name}`);
        }
      }
      if (update.text !== '') {
        reply ??= bubble(log, 'assistant');
        reply.textContent += update.text;
        reply.scrollIntoView({ block: 'end' });
      }
    }
  } catch (error) {
    reply?.remove();
    bubble(log, 'error', errorText(error));
  } finally {
    sendButton.disabled = false;
    promptInput.focus();
  }
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  void send();
});
