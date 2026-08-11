# @polymind-inc/agent-framework-core

> **Constituent package.** The supported way to use the Agent Framework is the main
> [`@polymind-inc/agent-framework`](https://www.npmjs.com/package/@polymind-inc/agent-framework)
> package, whose root entry (and `/testing` subpath) re-exports everything here and pins this
> package to its exact version. Installing this package directly works and resolves to the same
> modules, but examples and documentation import through the main package.

Runtime-agnostic core of the Agent Framework for TypeScript: `Agent`, `AgentSession`, the
`Message` / `Content` model, `tool()` with Standard Schema support, the function-calling loop,
Agent Skills, and the `ChatClient` seam that providers implement. ESM only; the sole runtime
dependency is `@opentelemetry/api`. Semantics follow the Microsoft Agent Framework reference
implementations (.NET / Python / Go).

```sh
npm install @polymind-inc/agent-framework-core
```

A chat client comes from a provider package — for example
[`@polymind-inc/agent-framework-openai`](https://www.npmjs.com/package/@polymind-inc/agent-framework-openai),
[`@polymind-inc/agent-framework-anthropic`](https://www.npmjs.com/package/@polymind-inc/agent-framework-anthropic)
or [`@polymind-inc/agent-framework-foundry`](https://www.npmjs.com/package/@polymind-inc/agent-framework-foundry).
A custom client implements the `ChatClient` interface directly. One that manages conversations
service-side should declare which conversation ids are stable anchors via
`ChatClientMetadata.stableConversationId`; the function-calling loop and the agent's session
propagation consult that predicate, and without it every reported conversation id advances the
chain between tool rounds.

Requirements: Node.js >= 24, ESM only (no CommonJS build).

Known limitations:

- **Workflows are not implemented yet** (graph/superstep engine, checkpointing, orchestrations —
  planned for a future release).
- The core runs in browsers, but calling model providers directly from a browser exposes your
  API key — run agents server-side.
- Agent Skills come from code (`inlineSkill`), from a `SKILL.md` document you supply
  (`markdownSkill`, with `parseSkillMarkdown` for the header alone), or from a `SkillsSource` you
  implement. **Walking a directory of `SKILL.md` files is not part of this package** — the core has
  no filesystem, by design; the extensibility examples show the dozen lines of `node:fs` it takes.
- `agent.run()` returns a hybrid thenable/async-iterable stream. Type-aware lint rules such as
  `@typescript-eslint/no-floating-promises` will flag a deliberately unconsumed `run()` call;
  consume the stream or `void` it explicitly.

---

Part of [Agent Framework for TypeScript](https://github.com/polymind-inc/agent-framework-js) — an
independent community implementation of the Microsoft Agent Framework programming model. Not an
official Microsoft product, and not affiliated with or endorsed by Microsoft. MIT licensed.
