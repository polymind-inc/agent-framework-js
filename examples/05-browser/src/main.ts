/**
 * Chat — the agent loop running in the browser.
 *
 * The whole loop — model calls, function calling, streaming — runs in the page. Tools can
 * therefore touch browser APIs directly: one restyles the page, another reads the visitor's
 * clock. The session is plain JSON, persisted to `localStorage` across reloads.
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
import { bubble, chip, element, errorText, loadJson, readSettings, removeStored, saveJson } from './ui.js';

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

const log = element<HTMLElement>('#log');
const composer = element<HTMLFormElement>('#composer');
const promptInput = element<HTMLInputElement>('#prompt');
const sendButton = element<HTMLButtonElement>('#send');
const clearButton = element<HTMLButtonElement>('#clear');

type TranscriptEntry = { role: 'user' | 'assistant'; text: string };

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (entry.role === 'user' || entry.role === 'assistant') && typeof entry.text === 'string';
}

function restoreTranscript(): TranscriptEntry[] {
  const stored = loadJson<unknown>(TRANSCRIPT_KEY);
  if (stored === undefined) {
    return [];
  }
  if (Array.isArray(stored) && stored.every(isTranscriptEntry)) {
    return stored;
  }
  // Anything else parses but is not what this page wrote; drop it rather than render garbage.
  removeStored(TRANSCRIPT_KEY);
  return [];
}

// The session is the source of truth the model sees; the transcript only redraws past bubbles.
const transcript: TranscriptEntry[] = restoreTranscript();
for (const entry of transcript) {
  bubble(log, entry.role, entry.text);
}
if (transcript.length > 0) {
  chip(log, 'conversation restored from localStorage');
}

let agent: Agent | undefined;
let session: AgentSession | undefined;
let agentSettings = '';

function currentAgent(): Agent {
  const settings = readSettings('gpt-4o-mini');
  const fingerprint = JSON.stringify(settings);
  if (agent === undefined || fingerprint !== agentSettings) {
    agent = new Agent({
      client: new OpenAIChatClient({
        model: settings.model,
        // The OpenAI SDK refuses to run in a browser unless the risk of exposing the key is
        // acknowledged explicitly. Here the key is typed into the page and kept in memory only.
        client: new OpenAI({
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

function currentSession(active: Agent): AgentSession {
  if (session === undefined) {
    const saved = loadJson<unknown>(SESSION_KEY);
    if (saved !== undefined) {
      try {
        session = active.deserializeSession(saved);
      } catch {
        // Corrupted or incompatible saved state would fail every send; drop it and start over.
        removeStored(SESSION_KEY);
        chip(log, 'saved session could not be restored; starting fresh');
      }
    }
    session ??= active.createSession();
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
    bubble(log, 'error', errorText(error));
    return;
  }
  promptInput.value = '';
  sendButton.disabled = true;
  // Clearing mid-run would race the in-flight loop, which repopulates the log and storage.
  clearButton.disabled = true;
  bubble(log, 'user', text);
  transcript.push({ role: 'user', text });
  let reply: HTMLElement | undefined;
  try {
    const stream = active.run(text, { session: currentSession(active) });
    for await (const update of stream) {
      for (const content of update.contents) {
        if (content.type === 'function_call') {
          chip(log, `tool: ${content.name}`);
        }
      }
      if (update.text !== '') {
        reply ??= bubble(log, 'assistant');
        reply.append(update.text);
        reply.scrollIntoView({ block: 'end' });
      }
    }
    const replyText = reply?.textContent ?? '';
    if (replyText !== '') {
      transcript.push({ role: 'assistant', text: replyText });
    }
    saveJson(SESSION_KEY, session);
    saveJson(TRANSCRIPT_KEY, transcript);
  } catch (error) {
    reply?.remove();
    bubble(log, 'error', errorText(error));
  } finally {
    sendButton.disabled = false;
    clearButton.disabled = false;
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
  removeStored(SESSION_KEY);
  removeStored(TRANSCRIPT_KEY);
});
