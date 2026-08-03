# @polymind-inc/agent-framework-core

Runtime-agnostic core of the Agent Framework for TypeScript: `Agent`, `AgentSession`, the
`Message` / `Content` model, `tool()` with Standard Schema support, the function-calling loop,
and the `ChatClient` seam that providers implement. ESM only; the sole runtime dependency is
`@opentelemetry/api`. Semantics follow the Microsoft Agent Framework reference implementations
(.NET / Python / Go).

```sh
npm install @polymind-inc/agent-framework-core
```

A chat client comes from a provider package — for example
[`@polymind-inc/agent-framework-openai`](https://www.npmjs.com/package/@polymind-inc/agent-framework-openai),
[`@polymind-inc/agent-framework-anthropic`](https://www.npmjs.com/package/@polymind-inc/agent-framework-anthropic)
or [`@polymind-inc/agent-framework-foundry`](https://www.npmjs.com/package/@polymind-inc/agent-framework-foundry).

Requirements: Node.js >= 24, ESM only (no CommonJS build).

Known limitations:

- **Workflows are not implemented yet** (graph/superstep engine, checkpointing, orchestrations —
  planned for a future release).
- The core runs in browsers, but calling model providers directly from a browser exposes your
  API key — run agents server-side.
- `agent.run()` returns a hybrid thenable/async-iterable stream. Type-aware lint rules such as
  `@typescript-eslint/no-floating-promises` will flag a deliberately unconsumed `run()` call;
  consume the stream or `void` it explicitly.

---

Part of [Agent Framework for TypeScript](https://github.com/polymind-inc/agent-framework-js) — an
independent community implementation of the Microsoft Agent Framework programming model. Not an
official Microsoft product, and not affiliated with or endorsed by Microsoft. MIT licensed.
