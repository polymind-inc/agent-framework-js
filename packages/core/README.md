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

A client whose service mints an identifier *during* a run — one the session then has to send on
every later request — can also implement `SessionScopedChatClient`. `Agent` asks it once per run
for a view of itself bound to that run's session, and that view wraps every service call of the
run, later tool rounds included, on awaited and streamed runs alike:

```ts
class MyChatClient implements ChatClient<MyOptions>, SessionScopedChatClient<MyOptions> {
  forSession(session: AgentSession): ChatClient<MyOptions> {
    return {
      metadata: this.metadata,
      getResponse: (messages, options) =>
        this.getResponse(messages, withTicket(options, session.state.myTicket)),
    };
  }
}
```

Keep the value in `session.state` rather than on the client — that is what keeps one session from
seeing another's, and what survives session serialization — and copy the options rather than
mutating what the caller passed in.

Function middleware wraps one tool call, and `next()` throws when that call fails — whether the
tool body threw or an inner middleware did. Catch it and assign `ctx.result` to answer in the
tool's place; let it out and it is reported to the model as that call's `function_result` while the
loop carries on, counting against `maxConsecutiveErrors`. Anything that must run either way belongs
in `finally`. To end the run instead of telling the model, throw `MiddlewareFailed`: it is never
turned into a result, it cancels the rest of a concurrent batch, and it reaches the caller of
`run()` — the escape a guardrail wants when it could not decide rather than decided "no".

Requirements: Node.js >= 24, ESM only (no CommonJS build).

Known limitations:

- **Workflows are not implemented yet** (graph/superstep engine, checkpointing, orchestrations —
  planned for a future release).
- The core runs in browsers, but calling model providers directly from a browser exposes your
  API key — run agents server-side.
- Agent Skills come from code (`inlineSkill`), from a `SKILL.md` document you supply
  (`markdownSkill`, with `parseSkillMarkdown` for the header alone), or from a `SkillsSource` you
  implement. Node applications can load a directory safely with `directorySkillsSource` from
  `@polymind-inc/agent-framework-core/node`; it refuses symlink/reparse-point escapes. The root
  entry remains filesystem-free for browser and edge runtimes.
- `agent.run()` returns a hybrid thenable/async-iterable stream. Type-aware lint rules such as
  `@typescript-eslint/no-floating-promises` will flag a deliberately unconsumed `run()` call;
  consume the stream or `void` it explicitly.

---

Part of [Agent Framework for TypeScript](https://github.com/polymind-inc/agent-framework-js) — an
independent community implementation of the Microsoft Agent Framework programming model. Not an
official Microsoft product, and not affiliated with or endorsed by Microsoft. MIT licensed.
