# Changelog

All `@polymind-inc/agent-framework-*` packages are versioned in lockstep; one entry here covers the
set. During 0.x, **minor releases may contain breaking changes**; patch releases are fixes only.

## Unreleased

## 0.1.0 — Baseline v0.1

Initial public release of the TypeScript implementation of the Microsoft Agent Framework
programming model.

- **`@polymind-inc/agent-framework-core`** — `Agent`, `AgentSession`, the wire-compatible
  `Message` / `Content` model, `tool()` with Standard Schema support, the function-calling loop
  with approvals and continuation tokens, middleware, `ContextProvider` / `HistoryProvider`, and
  OpenTelemetry GenAI instrumentation. One runtime dependency: `@opentelemetry/api`.
- **`@polymind-inc/agent-framework-openai`** — OpenAI and Azure OpenAI chat client over the
  Responses API, including the provider-hosted tools.
- **`@polymind-inc/agent-framework-anthropic`** — Anthropic chat client over the Messages API,
  including extended thinking and remote MCP servers.
- **`@polymind-inc/agent-framework-mcp`** — MCP client integration; server tools become framework
  tools.
- **`@polymind-inc/agent-framework-a2a`** — Agent2Agent (A2A) protocol client. `A2AAgent` makes a
  remote A2A agent usable wherever the framework expects an agent — awaited or streamed, with
  sessions, background tasks and re-subscription. Built on `@a2a-js/sdk` (A2A protocol v1.0).
- **`@polymind-inc/agent-framework-foundry`** — Microsoft Foundry chat client and the Hosted Agent
  hosting adapter.
- **`@polymind-inc/agent-framework-agentserver`** — Microsoft Foundry Responses container protocol
  v2.0.0 server, independent of the rest of the framework.

The API surface of this release is frozen as Baseline v0.1 (2026-08-02). Known limitations are
listed in the root [README](README.md).
