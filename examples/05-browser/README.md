# Browser example

A Vite + vanilla TypeScript chat page that runs the agent loop entirely in the browser. It
demonstrates what only makes sense client-side:

- **Streaming into the DOM** — the page iterates the run stream and appends text as it arrives.
- **Client-side tools** — the function-calling loop executes in the page, so tools reach browser
  APIs directly: `set_theme` restyles the page, `get_local_time` reads the visitor's clock.
- **Session persistence in `localStorage`** — the session is plain JSON, so persisting it is
  `JSON.stringify(session)` and resuming after a reload is `agent.deserializeSession(...)`.

Run the dev server from the repository root (after `pnpm install` and `pnpm -r build`):

```bash
pnpm --filter example-05-browser dev
```

Open the printed URL, paste an OpenAI API key into the page, and chat. Try:

> Switch the page to dark mode, then tell me my time zone.

## A note on API keys

The key you paste stays in the tab's memory; the page never stores it. But any key that reaches a
browser is readable by whoever uses that browser, which is why the OpenAI SDK requires the
explicit `dangerouslyAllowBrowser` opt-in this example sets. For anything beyond a local demo, run
agents server-side and keep provider credentials there — or point the **Base URL** field at a
proxy that holds the real key.
