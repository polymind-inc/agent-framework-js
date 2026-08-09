# Changelog

The umbrella `@polymind-inc/agent-framework` package and all `@polymind-inc/agent-framework-*`
packages are versioned in lockstep; one entry here covers the set. During 0.x, **minor releases may
contain breaking changes**; patch releases are fixes only.

## 0.2.2

Fixes accumulated since 0.2.1, centred on running agents as Microsoft Foundry Hosted Agents:
persistence against the Foundry storage service, latency of streamed model calls, transcript
fidelity, and telemetry attribution.

- **`@polymind-inc/agent-framework-openai`**
  - A streamed Responses API call now releases its SSE stream as soon as the terminal event
    (`response.completed` / `response.incomplete` / `response.failed`) has been yielded, instead
    of draining to the connection close. Azure AI Foundry's `/openai/v1/responses` holds the
    socket open for ~5 seconds after the terminal event and never sends the `[DONE]` sentinel, so
    every streamed round paid that tail — for a deployed hosted agent, the measured end-to-end
    turn dropped from 9.7s to 3.5s. Against an endpoint that closes promptly after the terminal
    event this is a no-op. The wrapper is a workaround for the service-side behavior; its removal
    is tracked in [#40](https://github.com/polymind-inc/agent-framework-js/issues/40).
  - A failed response now surfaces its diagnostic: the parsed response and the `response.failed`
    stream event carry an `error` content built from `response.error`, with generic substitutes
    when the wire carries no usable message or code. Previously the reason a run failed was only
    available in `rawRepresentation`.
  - A local tool's approval no longer reaches the Responses API input. Only hosted (MCP)
    approvals serialize to `mcp_approval_request` / `mcp_approval_response` items; a local
    approval is resolved in-process, and serializing it produced an orphaned request
    (`server_label: null`) or a response referencing an id the API never issued. Mirrors the
    upstream Python fix.
- **`@polymind-inc/agent-framework-core`**
  - `AgentResponse.text` / `ChatResponse.text` join the texts of multiple messages with a
    newline, matching the .NET reference (previously concatenated without a separator).
  - `gen_ai.system_instructions` is recorded on chat spans only when sensitive-content capture is
    enabled, serialized as a parts array (`[{"type":"text","content":…}]`). It was previously
    stamped unconditionally as a bare string, so the system prompt reached the tracing backend
    even with capture off — the OpenTelemetry GenAI conventions treat the attribute as opt-in,
    and the .NET and Python implementations gate it the same way.
- **`@polymind-inc/agent-framework-foundry`**
  - `FoundryResponseStore` is production-ready and is now the hosted default. Writes carry the
    resolved `agent_reference` and forward the platform call id (the two undocumented
    requirements behind the service's opaque 500s), replayed history travels as item-id
    references instead of re-sent items, conversation ids resolve through the service's own
    linkage, ambiguous failures are retried with bounded backoff and reconciled against what the
    service actually holds, and background responses replay from a sandbox-local event mirror —
    removing the documented 501 limitation on background execution. A hosted container without a
    reachable project endpoint falls back to the sandbox filesystem.
  - The hosting converters cover the Responses v2 item set: twelve more inbound item types —
    provider-run searches, code interpreter and image generation among them — now convert to
    framework messages instead of being silently dropped from the replayed transcript, and the
    output builder emits the matching wire representations so those items survive into the next
    turn's history. Semantics cross-checked against the .NET and Python hosted converters.
- **`@polymind-inc/agent-framework-agentserver`**
  - An input item that arrives without an id is assigned a platform id under its type's prefix
    before persistence, covering the reference id generator's full per-type dispatch. The Foundry
    storage service refuses an id-less item with an opaque 500, so a turn whose `input` was an
    item array without ids — the Foundry Playground's request shape among them — ended in
    `response.failed` with `storage_error` instead of completing. An item that already carries an
    id keeps it, and an id-less item of an unrecognized type is left out of persistence.
  - `GET /responses/{id}` reports `cancelled` as soon as a cancel has been accepted, instead of
    `in_progress` for as long as the cancel waits out its grace period. Only the status is
    overridden; the cancelled terminal still clears the output when the winddown ends, matching
    the reference server's refresh.
  - The hosted observability setup instruments outbound `fetch` (undici), so model requests and
    Foundry storage writes appear as HTTP client spans nested under the `chat` / `invoke_agent`
    spans — a 7-second span now shows where the time went.
  - Hosted telemetry is attributed to the deployed agent: a processor stamps the
    `microsoft.gen_ai.main_agent.*` attributes (the only `microsoft.*` span attributes the Azure
    Monitor JS exporter forwards), and the resource carries `foundry.*` attributes mirroring the
    .NET host, so the Foundry portal can associate spans with the agent and project.
  - New public API from the storage work: `stateRoot` and `resolveAgentReference` are exported,
    and `FoundryResponseStoreConfig` accepts `replayRoot` and `retry`.
- Repository: issue and pull request labels are applied automatically from paths and templates.

## 0.2.1

Documentation and positioning only — no change to any published API.

- **`@polymind-inc/agent-framework` is now the single supported surface.** All examples, the
  repository README and every code sample import through the main package
  (`@polymind-inc/agent-framework`, `…/openai`, `…/foundry/hosting`, …). The
  `@polymind-inc/agent-framework-*` constituent packages remain published — the main package
  depends on them at exact versions, and importing one directly still resolves to the same
  modules — but their READMEs now state that the main package is the documented way in. This
  removes the awkwardness of two equivalent import styles for the same code.

## 0.2.0

One new package; no change to any existing published API.

- **`@polymind-inc/agent-framework`** — new umbrella package, mirroring the Python
  `agent-framework` distribution. It depends on every granular package and re-exports each
  under a subpath: the root entry is the core, and `/testing`, `/openai`, `/anthropic`, `/mcp`,
  `/a2a`, `/foundry`, `/foundry/hosting`, `/agentserver`, `/agentserver/node` and
  `/agentserver/observability` map one-to-one onto the packages they re-export. The granular
  packages are unchanged and remain the smaller install.
- **`@polymind-inc/agent-framework-agentserver`** — routing no longer trims the trailing slash of a
  request path with a backtracking regular expression. The old pattern cost time quadratic in the
  length of a run of slashes, so an unauthenticated `GET` on a path such as `/////…/a` could hold
  the event loop for seconds.
- **`@polymind-inc/agent-framework-core`** — generated ids (`Agent.id`, `AgentSession.sessionId`,
  the `messageId` of framework-emitted messages) always come from `crypto.randomUUID`. They
  previously fell back to `Math.random` on a runtime without it, which is not a suitable source for
  an identifier. A runtime that does not provide `crypto.randomUUID` — a browser on a page served
  over plain HTTP — now throws instead of producing a guessable id.

## 0.1.1

Metadata only — no code changes, and no change to any published API.

- The repository moved to `polymind-inc/agent-framework-js`, matching how the Agent Framework
  names a language implementation that lives outside the .NET/Python monorepo (compare
  `microsoft/agent-framework-go`). The `repository`, `homepage` and `bugs` fields of all seven
  packages point at the new location; 0.1.0 shipped with the previous one, which now only works
  through a redirect.

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
