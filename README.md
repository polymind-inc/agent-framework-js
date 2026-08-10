# Agent Framework for TypeScript

[![CI](https://github.com/polymind-inc/agent-framework-js/actions/workflows/ci.yml/badge.svg)](https://github.com/polymind-inc/agent-framework-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@polymind-inc/agent-framework.svg)](https://www.npmjs.com/package/@polymind-inc/agent-framework)
[![Node.js](https://img.shields.io/node/v/@polymind-inc/agent-framework.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A TypeScript implementation of the **Microsoft Agent Framework** programming model, designed for
semantic parity with the official [.NET and Python][agent-framework] and [Go][agent-framework-go]
implementations.

> **This is an independent community implementation.** It is not an official Microsoft product, and
> it is not affiliated with, endorsed by, or reviewed by Microsoft. See [Trademarks](#trademarks).

The Agent Framework has first-party implementations for .NET, Python and Go. There is no
TypeScript one. This project fills that gap on the framework's own terms rather than inventing a
parallel programming model: the same concepts, the same names, the same wire format, and the same
observable behaviour — expressed in TypeScript idioms. The explicit goal is for this code to be in
a shape that could be **adopted upstream**, the way [`microsoft/agent-framework-go`][agent-framework-go]
sits alongside the .NET and Python implementations in [`microsoft/agent-framework`][agent-framework].
Everything from the repository name to the package layout to the naming generation to the release
cadence is chosen with that in mind.

## Contents

- [Quickstart](#quickstart)
- [Packages](#packages)
- [Parity with the reference implementations](#parity-with-the-reference-implementations)
- [Where the TypeScript API differs in shape](#where-the-typescript-api-differs-in-shape)
- [Design principles](#design-principles)
- [Coverage](#coverage)
- [Requirements](#requirements)
- [Examples](#examples)
- [Known limitations](#known-limitations)
- [Stability and versioning](#stability-and-versioning)
- [Contributing](#contributing)

## Quickstart

```bash
npm install @polymind-inc/agent-framework zod
```

```ts
import { Agent, tool } from '@polymind-inc/agent-framework';
import { OpenAIChatClient } from '@polymind-inc/agent-framework/openai';
import { z } from 'zod';

const weather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a location',
  parameters: z.object({ location: z.string() }),
  execute: async ({ location }) => `${location} is sunny, 25°C`,
});

const agent = new Agent({
  client: new OpenAIChatClient({ model: 'gpt-4o-mini' }),
  instructions: 'You are a helpful weather assistant.',
  tools: [weather],
});

const session = agent.createSession();

// Streaming.
for await (const update of agent.run('What is the weather in Tokyo?', { session })) {
  process.stdout.write(update.text);
}

// Awaited — the same call, folded into a single response.
const res = await agent.run('And in Osaka?', { session });
console.log(res.text);
```

`agent.run()` returns one hybrid value that is both a `PromiseLike<AgentResponse>` and an
`AsyncIterable<AgentResponseUpdate>`. There is no second streaming method to learn, and the
non-streaming result is a fold of the stream rather than a separate code path — the same principle
the Go implementation uses.

## Packages

One package to install: **`@polymind-inc/agent-framework`**. The root entry is the agent core;
every other capability lives under a subpath. The subpaths are plain static re-exports, so a
bundler tree-shakes whatever you do not import.

| Import                                            | Provides                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `@polymind-inc/agent-framework`                   | `Agent`, `AgentSession`, the `Message`/`Content` model, `tool()`, middleware, and the `ChatClient` seam                              |
| `@polymind-inc/agent-framework/openai`            | OpenAI and Azure OpenAI chat client (Responses API)                                                                                  |
| `@polymind-inc/agent-framework/anthropic`         | Anthropic chat client (Messages API)                                                                                                 |
| `@polymind-inc/agent-framework/mcp`               | Model Context Protocol client integration — MCP server tools as framework tools                                                      |
| `@polymind-inc/agent-framework/a2a`               | Agent2Agent (A2A) protocol client — a remote A2A agent used as an agent                                                              |
| `@polymind-inc/agent-framework/foundry`           | Microsoft Foundry chat client, with the Hosted Agent adapter under `/foundry/hosting`                                                |
| `@polymind-inc/agent-framework/agentserver`       | Foundry container protocol servers (Responses v2.0.0 and Invocations), with `/agentserver/node` and `/agentserver/observability` companions |
| `@polymind-inc/agent-framework/testing`           | `MockChatClient` and friends for testing agents without a live provider                                                              |

Under the hood the framework is developed and published as a family of
`@polymind-inc/agent-framework-*` constituent packages, released in lockstep and pinned to exact
versions by the main package. They exist to keep the codebase modular and the upstream story
flexible; importing them directly works — every subpath above is a static re-export of one of
them — but the supported, documented surface is `@polymind-inc/agent-framework`. The names mirror
the Python distribution layout (`agent-framework`, `agent-framework-core`, `agent-framework-openai`,
…) so that a move to a first-party scope is a mechanical rename.

## Parity with the reference implementations

Parity here means **semantic** parity, not signature parity. The rule this project follows is the
one the Go implementation states for itself:

> Respect language idioms — signatures follow the host language; semantics (default values, side
> effects, event emission, checkpointing, tool invocation, serialization) match the other
> implementations exactly. A differently shaped API is not, by itself, a parity violation.

Concretely, that commitment has three parts.

**Naming follows the current (v1.13) generation.** Pre-rename names from older articles
(`ChatAgent`, `AgentThread`, `AgentRunResponse`, `ChatMessage`) are not used.

| Concept      | TypeScript                              | .NET                          | Python                    | Go                                  |
| ------------ | --------------------------------------- | ----------------------------- | ------------------------- | ----------------------------------- |
| Agent        | `Agent`                                 | `AIAgent` / `ChatClientAgent` | `Agent`                   | `agent.Agent`                       |
| Conversation | `AgentSession`                          | `AgentSession`                | `AgentSession`            | `agent.Session`                     |
| Message      | `Message`                               | `ChatMessage`                 | `Message`                 | `message.Message`                   |
| Content      | `Content` (discriminated union)         | `AIContent` hierarchy         | `Content` (single class)  | `message.Content`                   |
| Response     | `AgentResponse` / `AgentResponseUpdate` | same                          | same                      | `agent.Response` / `ResponseUpdate` |
| Chat client  | `ChatClient`                            | `IChatClient`                 | `SupportsChatGetResponse` | `ProviderConfig.Run`                |
| Tool         | `Tool` / `FunctionTool` / `tool()`      | `AITool` / `AIFunction`       | `FunctionTool` / `@tool`  | `tool.Tool` / `functool`            |
| History      | `HistoryProvider`                       | `ChatHistoryProvider`         | `HistoryProvider`         | `agent.HistoryProvider`             |
| Context      | `ContextProvider`                       | `AIContextProvider`           | `ContextProvider`         | `agent.ContextProvider`             |

**The wire format is interoperable.** Serialized messages, content, sessions and checkpoints use
camelCase properties and the same `type` discriminator literals as the Python implementation.
Unknown content is preserved and round-tripped rather than dropped, so a payload produced by
another implementation survives a trip through this one unchanged.

**Behaviour is verified against the reference source, not inferred.** Where the implementations
disagree, the order of authority is .NET, then Python, then Go. Defaults, folding rules, the
function-calling loop, the approval flow and cancellation semantics were each read out of the
reference code rather than guessed at.

## Where the TypeScript API differs in shape

Deliberate divergences, and the reason for each:

| Topic                | Reference implementations                                          | This implementation                                     | Why                                                         |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------- |
| Streaming            | .NET splits `RunAsync` / `RunStreamingAsync`; Python uses `stream=` | one `run()` returning a thenable **and** async-iterable  | Awaiting or iterating is the natural JS distinction          |
| Content model        | class hierarchy (.NET), single class + `type` (Python)             | discriminated union                                     | Exhaustiveness checking is TypeScript's strongest guarantee  |
| Tool schemas         | reflection (.NET), Pydantic (Python)                               | [Standard Schema v1][standard-schema] or raw JSON Schema | JS erases types at runtime, so schemas have to be values     |
| Middleware           | decorators + builder (.NET), mixin layers (Python)                 | koa-style `(ctx, next)` functions                        | The established composition idiom in the JS ecosystem        |
| Cancellation         | `CancellationToken`, `context.Context`                             | `AbortSignal`                                            | The web platform standard                                    |
| Dependency injection | `Microsoft.Extensions.DependencyInjection` (.NET)                  | none — explicit constructor injection                    | Matches the Python and Go decision                           |

## Design principles

1. **TypeScript-first, ESM only.** Types are part of the API. Discriminated unions, generics and
   overloads are used so that code which typechecks, works. There is no CommonJS build.
2. **A runtime-agnostic core.** The core runs on Node.js, Deno, Bun, edge runtimes and in browsers.
   Node-specific concerns live in other packages.
3. **Wire compatibility.** Serialization is interoperable with the other implementations, including
   preservation of content this implementation does not understand.
4. **Minimal dependencies.** The core's only runtime dependency is `@opentelemetry/api` — the API
   package alone, which is a no-op until an SDK is configured. Schema libraries are *accepted*
   through the Standard Schema interface, never depended on.
5. **Non-streaming is a fold of streaming.** There is one execution path, not two.
6. **Security is documented at the API.** Prompt injection, the trust boundary around session
   restoration, and unapproved tool execution each carry an explicit "Security considerations"
   note in the TSDoc.

## Coverage

| Area                                                              | Status                                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Agent, sessions, tools, middleware, streaming                     | Implemented                                                      |
| Function-calling loop, tool approval, continuation tokens          | Implemented                                                      |
| OpenAI / Azure OpenAI, Anthropic and Microsoft Foundry providers   | Implemented                                                      |
| Microsoft Foundry Hosted Agent hosting (Responses and Invocations protocols) | Implemented                                           |
| `ContextProvider` / `HistoryProvider`                             | Implemented                                                      |
| OpenTelemetry GenAI instrumentation                               | Implemented                                                      |
| MCP client (tools)                                                | Implemented                                                      |
| A2A client                                                        | Implemented                                                      |
| Workflows (graph/superstep engine, checkpointing, orchestrations) | Designed, not implemented — the next milestone                   |
| History compaction                                                | Planned                                                          |
| Generic hosting (A2A / AG-UI / OpenAI-compatible surfaces)        | Planned                                                          |
| DevUI, declarative YAML agents, durable execution, evaluation     | Out of scope by design (code-first, as in the Go implementation) |

## Requirements

- **Node.js >= 24** (active LTS). ESM only — there is no CommonJS build.
- **TypeScript**: type resolution is verified with TypeScript 7 under `moduleResolution: bundler`
  and `nodenext`. Declarations are emitted with `isolatedDeclarations`.

## Examples

Runnable examples live in [`examples/`](examples/): getting started, multimodal input, agent
delegation, Foundry chat and hosting, middleware, context providers, Anthropic, OpenAI hosted
tools, MCP, and A2A. See [`examples/README.md`](examples/README.md) for the commands and the
environment variables each one needs.

## Known limitations

- **Workflows are not implemented yet** — the graph/superstep engine, checkpointing and the
  high-level orchestrations are the next milestone.
- `OpenAIChatClient` supports the **Responses API only**. `api: 'chat_completions'` is permanently
  out of scope; point a Chat Completions-only provider at a Responses-compatible endpoint, or
  implement the `ChatClient` interface directly.
- The MCP integration covers **tools only** — no sampling, elicitation or prompts.
- The A2A package is a **client**. Serving a framework agent over A2A, push notifications, task
  listing and cancellation are not covered; use [`@a2a-js/sdk`][a2a-sdk] directly for those.
- A hosted container persists responses in the Foundry storage service by default (matching the
  reference implementations); the background replay log lives beside the sandbox state, so stream
  replay after a sandbox recycle fails closed rather than resuming.
- The core runs in browsers, but calling a model provider directly from a browser exposes your API
  key — **run agents server-side**.
- Because `agent.run()` returns a hybrid thenable, type-aware lint rules such as
  `@typescript-eslint/no-floating-promises` will flag a deliberately unconsumed call. Consume the
  stream or `void` it explicitly.
- Session envelope interoperability with the .NET and Python implementations is not finalized —
  their envelopes currently differ from each other.

## Stability and versioning

The public API is stable but not frozen: surface changes are made deliberately, motivated by
alignment with the reference implementations. During `0.x`, **minor releases may contain breaking
changes**; patch releases are fixes only. All packages are versioned and released in
lockstep, so a single [`CHANGELOG.md`](CHANGELOG.md) entry covers the set. Releases are published
from CI with [npm provenance][provenance].

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Parity bugs, where this
implementation behaves differently from .NET, Python or Go, are the highest-priority class of
issue. Because the goal is upstream contribution, changes are held to the naming, wire-format and
semantic rules described above; the contributing guide spells them out.

Security issues should be reported privately — see [SECURITY.md](SECURITY.md).

## Trademarks

"Microsoft", "Microsoft Agent Framework" and "Microsoft Foundry" are trademarks of Microsoft
Corporation. They are used here descriptively, to identify the programming model and the services
this project implements and interoperates with. This project is not affiliated with or endorsed by
Microsoft.

## License

[MIT](LICENSE)

[agent-framework]: https://github.com/microsoft/agent-framework
[agent-framework-go]: https://github.com/microsoft/agent-framework-go
[standard-schema]: https://github.com/standard-schema/standard-schema
[a2a-sdk]: https://github.com/a2aproject/a2a-js
[provenance]: https://docs.npmjs.com/generating-provenance-statements
