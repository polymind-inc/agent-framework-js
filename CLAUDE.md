# Notes for AI coding assistants

This repository is a TypeScript implementation of the Microsoft Agent Framework programming model,
written so that it could be contributed upstream to `microsoft/agent-framework`. Read
[CONTRIBUTING.md](CONTRIBUTING.md) first — it is the source of truth for how changes are made here.
The points below are the ones most often gotten wrong.

## Non-negotiable rules

1. **Semantics match the reference implementations exactly.** Signatures follow TypeScript idiom;
   behaviour does not get to. Default values, side effects, folding, loop behaviour, cancellation
   and serialization must match. When implementations disagree, the order of authority is **.NET,
   then Python, then Go**. Read the reference source — never infer behaviour, and never guess.
2. **Use the current (v1.13) naming generation.** `Agent`, `AgentSession`, `Message`, `Content`,
   `AgentResponse`. The pre-rename names — `ChatAgent`, `AgentThread`, `AgentRunResponse`,
   `ChatMessage` — appear nowhere, including comments and tests.
3. **Do not break the wire format.** Serialized properties are camelCase; `Content` discriminator
   values are the Python snake_case literals; unrecognized data is preserved and round-tripped.
4. **The core has exactly one runtime dependency**, `@opentelemetry/api`. Schema libraries are
   accepted through the Standard Schema interface, never depended on. No Node-specific APIs in the
   core — it has to keep running on Deno, Bun, edge runtimes and in browsers.
5. **The public API is frozen as Baseline v0.1.** Deviating from it is a deliberate act that gets
   discussed in an issue before it gets written.
6. **Fix bugs reproduction-first.** Write a test that fails against the current code, make the fix,
   then temporarily revert the fix and confirm the test fails again.
7. **Comments are self-contained.** They explain the code to a first-time reader. No references to
   internal design documents, milestone identifiers or decision logs.

## Platform

Node.js 24+ · TypeScript 7 · pnpm · ESM only · target ES2024 with `isolatedDeclarations` · Biome
for lint and format · tsdown for builds · Vitest for tests.

The public surface is the single package `@polymind-inc/agent-framework`: its root entry is the
core and every other capability is a subpath (`/openai`, `/anthropic`, `/mcp`, `/a2a`, `/foundry`,
`/agentserver`, `/testing`). It is built from `@polymind-inc/agent-framework-*` constituent
packages under `packages/`, which stay published (the main package depends on them, pinned
exactly) but are not the documented way in — examples and docs always import through the main
package. All are versioned in lockstep. `pnpm check` runs the same gate as CI.

## Status

Implemented: the agent core, providers (OpenAI / Azure OpenAI, Anthropic, Microsoft Foundry),
Foundry Hosted Agent hosting, the MCP client, and the A2A client. Not implemented: workflows —
the graph/superstep engine, checkpointing and the high-level orchestrations.
