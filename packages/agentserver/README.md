# @polymind-inc/agent-framework-agentserver

> **Constituent package.** The supported way to use the Agent Framework is the main
> [`@polymind-inc/agent-framework`](https://www.npmjs.com/package/@polymind-inc/agent-framework)
> package, which re-exports everything here under `@polymind-inc/agent-framework/agentserver`
> (plus `/agentserver/node` and `/agentserver/observability`) and pins this package to its exact
> version. Installing this package directly works and resolves to the same modules, but examples
> and documentation import through the main package.

The Microsoft Foundry hosted-agent container protocols, as servers. Independent of the
Agent Framework; the Agent Framework adapters live in
`@polymind-inc/agent-framework-foundry/hosting`. Both are exposed as Web-standard fetch handlers
with a Node adapter on the `./node` subpath:

- **`ResponsesServer`** — the Responses container protocol v2.0.0: routing, SSE framing and
  sequence numbers, the lifecycle contract, id generation, the header contract, storage
  abstractions, and error shapes.
- **`InvocationsServer`** — the Invocations protocol, for callers that cannot speak the Responses
  request shape. The payload is deliberately unprescribed: the request body reaches the handler
  unread, and the handler's `Response` — its body, status and content type — is what the caller
  gets. This layer owns the routes (`POST /invocations`, `GET /invocations/{id}`,
  `POST /invocations/{id}/cancel`, `/readiness`), invocation and session id resolution and their
  response headers, cancellation, error classification, SSE keep-alive injection, and trace
  propagation.

```sh
npm install @polymind-inc/agent-framework-agentserver
```

## Response store

`new ResponsesServer({ handler })` stores responses on the **filesystem** by default, so a
`previous_response_id` chain survives a restart. Both reference servers make the same local
choice — .NET registers `FileResponsesProvider` for a non-hosted host, Python's
`ResponsesAgentServerHost` falls through to `FileResponseStore`.

| Variable                 | Effect                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `AGENTSERVER_STATE_ROOT` | Root for local persistence. Defaults to `~/.agentserver`; responses live in `responses/`. |

**Security and retention.** A response holds a whole conversation, and it is written as plain
JSON: anything the user or the model said is readable by anyone who can read that directory, and
by anything else running as the same account. Nothing here expires, rotates or bounds those
files — retention and cleanup belong to whoever runs the process. Give the directory the
protection the conversations deserve, or move it somewhere that has it:

```sh
AGENTSERVER_STATE_ROOT=/var/lib/my-agent node server.js
```

To opt out and keep every conversation in the process, pass the in-memory store explicitly:

```ts
new ResponsesServer({ handler, store: new InMemoryResponseProvider() });
```

That is also what a test wants: a suite that lets the default apply must point
`AGENTSERVER_STATE_ROOT` at a temporary directory it cleans up, or it will write into the
developer's home.

## Trust model

This server is designed to run **behind the Microsoft Foundry gateway**. It trusts the
`x-agent-user-id` header for user partitioning and, per the container contract, `serve` binds
`0.0.0.0:${PORT:-8088}`. Exposing that port outside the gateway means trusting whoever can reach
it to say who the user is — anyone on the network could then read any user's conversations from
the local response store. Do not expose it directly.

## Known protocol deviations

Deliberate second-order deviations from the reference implementations, kept until a protocol
revision makes a coordinated change worthwhile: `response.created`
reports `status: "queued"` where Python reports `in_progress`; null-ish
`ResponseObject` fields are omitted; `_internal_metadata` is not stripped on ingress; reads are
served (not 503) while draining; conversation ids are alias-stored as responses; the request's
`instructions` field is ignored; versioned toolbox endpoint formats are unsupported; error
messages are carried in the HTTP body as well (Python only carries them on streamed terminal
events). Background
runs replay-fail-closed when the store cannot persist events. The Azure Monitor exporter
dependency is a `beta` release line, pinned exactly for that reason.

## Telemetry

`serve` configures OpenTelemetry before it binds — the reference hosts (.NET
`Azure.AI.AgentServer.Core`, Python `azure-ai-agentserver-core`) do the same at startup, so a
deployed container needs **no code** to light up tracing. The protocol layer itself touches only
`@opentelemetry/api`; the SDK wiring lives on the `./observability` subpath
(`setupHostObservability`) and is driven by the environment:

| Variable                                                                               | Effect                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APPLICATIONINSIGHTS_CONNECTION_STRING`                                                | Azure Monitor export. A Foundry deployment injects this.                                                                                                                                                                                   |
| `APPLICATIONINSIGHTS_AUTH_MODE=entra`                                                  | Authenticate Azure Monitor with the managed identity.                                                                                                                                                                                      |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (or a per-signal `…_TRACES_/…_METRICS_ENDPOINT`)         | OTLP export. `OTEL_EXPORTER_OTLP_PROTOCOL` (or per-signal) picks `http/protobuf` (default) or `grpc` — gRPC needs the optional `@opentelemetry/exporter-trace-otlp-grpc` / `@opentelemetry/exporter-metrics-otlp-grpc` packages installed. |
| `FOUNDRY_AGENT_NAME` / `_VERSION` / `_INSTANCE_CLIENT_ID` / `FOUNDRY_PROJECT_ARM_ID` … | Resource identity (`service.name`, `service.version`) and the Foundry attributes stamped on every span (`gen_ai.agent.*`, `microsoft.foundry.project.id`, …).                                                                              |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`                                   | Opt into recording message content on spans. Read by `@polymind-inc/agent-framework-core`; off by default.                                                                                                                                              |

With no exporter variable set, providers and propagation are still registered but nothing is
exported — the container behaves exactly as before. Every turn force-flushes on completion, because
a hosted sandbox may be frozen the moment the response is out: every answered request flushes as it
is answered — refusals and handler failures included — except the two answers that outlive their
request, which flush when the SSE stream closes and when the background run ends. Inbound
`traceparent` / `baggage` headers are always propagated to the handler's spans, and `POST
/responses` additionally stamps its own `azure.ai.agentserver.response_id` / `.conversation_id` /
`.streaming` / `.x-request-id` baggage, so `gen_ai.conversation.id` lands on spans whether or not
the caller speaks baggage. No server span is created, so the framework's `invoke_agent` parents
directly under the calling service.

Opt out, or pass options through:

```ts
await serve(server, { observability: false });
```

---

Part of [Agent Framework for TypeScript](https://github.com/polymind-inc/agent-framework-js) — an
independent community implementation of the Microsoft Agent Framework programming model. Not an
official Microsoft product, and not affiliated with or endorsed by Microsoft. MIT licensed.
