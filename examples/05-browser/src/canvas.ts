/**
 * Canvas — an agent that paints with client-side tools.
 *
 * Every drawing primitive is a `tool()` whose `execute` runs in the page against a 2D canvas
 * context. The function-calling loop turns one instruction ("draw a snowman") into a series of
 * tool calls, each rendered the moment it executes. The session lives in memory, so follow-up
 * instructions ("now add a hat") keep building on the same picture.
 *
 * Run: `pnpm --filter example-05-browser dev`, then open /canvas.html
 */
import { Agent, type AgentSession, tool } from '@polymind-inc/agent-framework';
import { OpenAIChatClient } from '@polymind-inc/agent-framework/openai';
import OpenAI from 'openai';
import { z } from 'zod';
import { bubble, chip, element, errorText, readSettings, streamingBubble } from './ui.js';

const canvas = element<HTMLCanvasElement>('#canvas');
const context = canvas.getContext('2d');
if (context === null) {
  throw new Error('This browser does not provide a 2D canvas context.');
}

const color = z.string().describe('Any CSS color, e.g. "tomato" or "#1d76db"').default('#1d76db');

const drawCircle = tool({
  name: 'draw_circle',
  description: 'Draw a filled circle on the canvas',
  parameters: z.object({ x: z.number(), y: z.number(), radius: z.number().positive(), color }),
  execute: (args) => {
    context.fillStyle = args.color;
    context.beginPath();
    context.arc(args.x, args.y, args.radius, 0, 2 * Math.PI);
    context.fill();
    return `Circle at (${args.x}, ${args.y}).`;
  },
});

const drawRect = tool({
  name: 'draw_rect',
  description: 'Draw a filled rectangle on the canvas',
  parameters: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    color,
  }),
  execute: (args) => {
    context.fillStyle = args.color;
    context.fillRect(args.x, args.y, args.width, args.height);
    return `Rectangle at (${args.x}, ${args.y}).`;
  },
});

const drawLine = tool({
  name: 'draw_line',
  description: 'Draw a straight line on the canvas',
  parameters: z.object({
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
    color,
    lineWidth: z.number().positive().default(2),
  }),
  execute: (args) => {
    context.strokeStyle = args.color;
    context.lineWidth = args.lineWidth;
    context.beginPath();
    context.moveTo(args.x1, args.y1);
    context.lineTo(args.x2, args.y2);
    context.stroke();
    return `Line from (${args.x1}, ${args.y1}) to (${args.x2}, ${args.y2}).`;
  },
});

const clearCanvas = tool({
  name: 'clear_canvas',
  description: 'Erase everything on the canvas',
  parameters: z.object({}),
  execute: () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    return 'The canvas is blank.';
  },
});

const log = element<HTMLElement>('#log');
const composer = element<HTMLFormElement>('#composer');
const promptInput = element<HTMLInputElement>('#prompt');
const sendButton = element<HTMLButtonElement>('#send');

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
        client: new OpenAI({
          apiKey: settings.apiKey,
          dangerouslyAllowBrowser: true,
          ...(settings.baseURL === '' ? {} : { baseURL: settings.baseURL }),
        }),
      }),
      name: 'CanvasPainter',
      instructions:
        `You paint on a ${canvas.width}×${canvas.height} canvas whose origin is the top-left ` +
        'corner. Compose pictures from your drawing tools — several calls per request is normal. ' +
        'After drawing, describe what you made in one short sentence.',
      tools: [drawCircle, drawRect, drawLine, clearCanvas],
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
  const reply = streamingBubble(log);
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
        reply.append(update.text);
      }
    }
  } catch (error) {
    reply.remove();
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
