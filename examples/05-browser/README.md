# Browser examples

A Vite + vanilla TypeScript app whose pages each run the agent loop entirely in the browser.
Start the dev server from the repository root (after `pnpm install` and `pnpm -r build`):

```bash
pnpm --filter example-05-browser dev
```

Open the printed URL, paste an API key into the page, and try the pages — they link to each other:

| Page | What it demonstrates |
| --- | --- |
| [`/`](index.html) — Chat | Streaming into the DOM, client-side tools (`set_theme`, `get_local_time`), and session persistence in `localStorage`: the session is plain JSON, so persisting it is `JSON.stringify(session)` and resuming after a reload is `agent.deserializeSession(...)` |
| [`/canvas.html`](canvas.html) — Canvas | An agent that paints: every drawing primitive is a `tool()` executing against a 2D canvas context, so one instruction becomes a series of tool calls rendered as they run |
| [`/structured.html`](structured.html) — Structured output | A schema passed as `responseFormat`; the typed, validated `response.value` fills the page's fields directly |
| [`/anthropic.html`](anthropic.html) — Anthropic | The chat page with `AnthropicChatClient` swapped in — the rest of the code is identical, which is the point |

Suggested first prompts:

> Switch the page to dark mode, then tell me my time zone.

> Draw a snowman on a blue background.

## A note on API keys

The key you paste stays in the tab's memory; the pages never store it. But any key that reaches a
browser is readable by whoever uses that browser, which is why both the OpenAI and Anthropic SDKs
require the explicit `dangerouslyAllowBrowser` opt-in these pages set. For anything beyond a local
demo, run agents server-side and keep provider credentials there — or point the **Base URL** field
at a proxy that holds the real key.
