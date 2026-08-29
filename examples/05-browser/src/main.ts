/**
 * 05 — Running an agent in the browser.
 *
 * The whole agent loop — model calls, the function-calling loop, streaming — runs in the page.
 * Tools can therefore touch browser APIs directly: one restyles the page, another reads the
 * visitor's clock. The session is plain JSON, persisted to `localStorage` across reloads.
 *
 * The API key entered in the page stays in this tab's memory, but anything shipped to a browser
 * is readable by its user — in production, run agents server-side and keep credentials there.
 *
 * Run: `pnpm --filter example-05-browser dev`
 */
import { Agent, type AgentSession, tool } from '@polymind-inc/agent-framework';
import { OpenAIChatClient } from '@polymind-inc/agent-framework/openai';
import OpenAI from 'openai';
import { z } from 'zod';

const SESSION_KEY = 'agent-framework-example.session';
const TRANSCRIPT_KEY = 'agent-framework-example.transcript';

// These tools run inside the page, so they can reach browser APIs the model cannot.
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

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) {
    throw new Error(`Missing element: ${selector}`);
  }
  return found;
}

const apiKeyInput = element<HTMLInputElement>('#api-key');
const baseUrlInput = element<HTMLInputElement>('#base-url');
const modelInput = element<HTMLInputElement>('#model');
const log = element<HTMLElement>('#log');
const composer = element<HTMLFormElement>('#composer');
const promptInput = element<HTMLInputElement>('#prompt');
const sendButton = element<HTMLButtonElement>('#send');
const clearButton = element<HTMLButtonElement>('#clear');

type TranscriptEntry = { role: 'user' | 'assistant'; text: string };

function bubble(kind: TranscriptEntry['role'] | 'error', text = ''): HTMLElement {
  const el = document.createElement('div');
  el.className = `bubble ${kind}`;
  el.textContent = text;
  log.append(el);
  el.scrollIntoView({ block: 'end' });
  return el;
}

function chip(text: string): void {
  const el = document.createElement('div');
  el.className = 'chip';
  el.textContent = text;
  log.append(el);
}

function loadJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private windows, quota); the page works without persistence.
  }
}

// The session is the source of truth the model sees; the transcript only redraws past bubbles.
const transcript: TranscriptEntry[] = loadJson<TranscriptEntry[]>(TRANSCRIPT_KEY) ?? [];
for (const entry of transcript) {
  bubble(entry.role, entry.text);
}
if (transcript.length > 0) {
  chip('conversation restored from localStorage');
}

let agent: Agent | undefined;
let session: AgentSession | undefined;
let agentSettings = '';

function currentAgent(): Agent {
  const apiKey = apiKeyInput.value.trim();
  if (apiKey === '') {
    apiKeyInput.focus();
    throw new Error('Enter an API key first.');
  }
  const baseURL = baseUrlInput.value.trim();
  const model = modelInput.value.trim() || 'gpt-4o-mini';
  const settings = JSON.stringify([apiKey, baseURL, model]);
  if (agent === undefined || settings !== agentSettings) {
    agent = new Agent({
      client: new OpenAIChatClient({
        model,
        // The OpenAI SDK refuses to run in a browser unless the risk of exposing the key is
        // acknowledged explicitly. Here the key is typed into the page and kept in memory only.
        client: new OpenAI({
          apiKey,
          dangerouslyAllowBrowser: true,
          ...(baseURL === '' ? {} : { baseURL }),
        }),
      }),
      name: 'BrowserAssistant',
      instructions:
        'You are a cheerful assistant living inside a web page. Your tools can restyle the page ' +
        "and read the visitor's clock. Answer briefly.",
      tools: [setTheme, getLocalTime],
    });
    agentSettings = settings;
  }
  return agent;
}

function currentSession(active: Agent): AgentSession {
  if (session === undefined) {
    const saved = loadJson<unknown>(SESSION_KEY);
    session = saved === undefined ? active.createSession() : active.deserializeSession(saved);
  }
  return session;
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
    bubble('error', error instanceof Error ? error.message : String(error));
    return;
  }
  promptInput.value = '';
  sendButton.disabled = true;
  bubble('user', text);
  transcript.push({ role: 'user', text });
  let reply: HTMLElement | undefined;
  try {
    const stream = active.run(text, { session: currentSession(active) });
    for await (const update of stream) {
      for (const content of update.contents) {
        if (content.type === 'function_call') {
          chip(`tool: ${content.name}`);
        }
      }
      if (update.text !== '') {
        reply ??= bubble('assistant');
        reply.textContent += update.text;
        reply.scrollIntoView({ block: 'end' });
      }
    }
    transcript.push({ role: 'assistant', text: reply?.textContent ?? '' });
    saveJson(SESSION_KEY, session);
    saveJson(TRANSCRIPT_KEY, transcript);
  } catch (error) {
    reply?.remove();
    bubble('error', error instanceof Error ? error.message : String(error));
  } finally {
    sendButton.disabled = false;
    promptInput.focus();
  }
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  void send();
});

clearButton.addEventListener('click', () => {
  session = undefined;
  transcript.length = 0;
  log.replaceChildren();
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(TRANSCRIPT_KEY);
  } catch {
    // Storage can be unavailable; there is then nothing to clear.
  }
});
