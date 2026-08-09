# Hosted Agent (Microsoft Foundry)

An agent built with `agent-framework-js`, published over the **Responses container protocol
v2.0.0** and deployable to Microsoft Foundry.

| File                  | What it is                                                                     |
| --------------------- | ------------------------------------------------------------------------------ |
| `main.ts`             | The agent, and the server that publishes it                                    |
| `agent.yaml`          | The Foundry agent definition (`kind: hosted`, protocol declaration, resources) |
| `agent.manifest.yaml` | The `azd` manifest: the model deployment this agent needs                      |
| `Dockerfile`          | Copies the prebuilt bundle into `node:24-slim` and exposes port 8088            |
| `tsdown.config.ts`    | Bundles the TypeScript host and all runtime dependencies into `dist/main.mjs`  |

## Run it locally

From the repository root:

```bash
pnpm install && pnpm -r build
```

The recursive build compiles the framework packages first, then creates the Hosted Agent's
self-contained ESM bundle. With `az login` done and the project endpoint set, start that bundle:

```bash
FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project> AZURE_AI_MODEL_DEPLOYMENT_NAME=gpt-4o-mini pnpm --filter example-02-foundry host
```

For source-level development without rebuilding the bundle after every edit, use `host:dev`.

The server binds `0.0.0.0:8088` (override with `PORT`).

### Check it

Readiness — this is the probe the platform waits on before sending any traffic:

```bash
curl localhost:8088/readiness
```

A first turn:

```bash
curl -sS -X POST localhost:8088/responses -H 'content-type: application/json' -d '{"input": "Hi"}'
```

The response carries an `id` like `caresp_…`. Continue the conversation by passing it back — the
container loads the transcript from its store, so the second turn sees the first:

```bash
curl -sS -X POST localhost:8088/responses -H 'content-type: application/json' -d '{"input": "Continue.", "previous_response_id": "caresp_REPLACE_ME"}'
```

Stream instead of waiting:

```bash
curl -sS -N -X POST localhost:8088/responses -H 'content-type: application/json' -d '{"input": "Hi", "stream": true}'
```

## Deploy it to Foundry

These steps run against a real subscription and are left to you; nothing here is automated.

1. Install the CLI extension:

```bash
azd ext install azure.ai.agents
```

2. Initialize from the manifest, which provisions the model deployment:

```bash
azd ai agent init -m agent.manifest.yaml
```

3. Provision the project resources:

```bash
azd provision
```

4. Build the framework packages and the Hosted Agent bundle from the repository root:

```bash
pnpm install --frozen-lockfile && pnpm -r build
```

5. Run the container locally against the provisioned project — same protocol, real credentials:

```bash
azd ai agent run
```

6. Deploy:

```bash
azd deploy
```

### Deploying against a project you already have

If the model deployment and the Foundry project already exist, skip the provisioning steps and
point `init` at them. Build the bundle from the repository root, then build and push the image.
The image build uses the Hosted Agent directory as its context and does not build TypeScript:

```bash
pnpm install --frozen-lockfile && pnpm -r build
docker build -t <registry>.azurecr.io/weather-agent:v1 examples/02-foundry/02-hosted-agent
```

```bash
azd ai agent init --image <registry>.azurecr.io/weather-agent:v1 --agent-name weather-agent --protocol responses --project-id <project-resource-id> --model-deployment <deployment>
```

Notes from doing this against a live project (extension `azure.ai.agents` 1.0.0-beta.7):

- `init` refuses to run in a non-empty directory even with `--no-prompt --force`, so run it in an
  empty directory; it writes its own `azure.yaml` and `src/<agent>/agent.yaml`.
- `--project-id` takes an ARM resource id. From Git Bash, prefix the command with
  `MSYS_NO_PATHCONV=1` or the leading `/` is rewritten into a Windows path and the id is rejected
  as malformed.
- **`environment_variables` did not reach the container** from either `azure.yaml` or
  `src/<agent>/agent.yaml` — the registered definition came back without them. Check with
  `GET /agents/<name>/versions/<n>` before relying on one; the platform does inject
  `FOUNDRY_PROJECT_ENDPOINT` on its own, but `AZURE_AI_MODEL_DEPLOYMENT_NAME` has to arrive
  somehow, and a missing one fails as `404 The API deployment for this resource does not exist`.

### Where the transcript is stored

A deployed container persists responses in the **Foundry storage service**
(`FoundryResponseStore`) by default, the same activation the reference implementations make —
responses then survive sandbox recycling and a conversation can continue from any sandbox. To
keep a deployment on its sandbox filesystem instead, pass the store explicitly:

```ts
new ResponsesHostServer({ agent, store: new FileResponseProvider() });
```

Two service behaviours worth knowing, both measured against a live project: storage writes are
gated on the **hosted-agent credential**, so `FoundryResponseStore` works from inside a deployed
container and answers an opaque `500` from a workstation login; and every write must carry an
`agent_reference` with a non-empty name, which the server stamps onto each response
automatically. The storage service has no events API, so a background response's replay log stays
beside the sandbox state.

Afterwards the agent answers at
`{projectEndpoint}/agents/weather-agent/endpoint/protocols/openai`, which is exactly what
`FoundryChatClient` with `target: { serverAgent: 'weather-agent' }` talks to — so a deployed agent
can be called from another agent with the same client used in `01-foundry-chat.ts`.

## What the platform sets

`agent.yaml` declaring `version: 2.0.0` is what makes the platform inject
`x-agent-foundry-call-id`. The container refuses a hosted request without it (501,
`unsupported_container_protocol_version`) rather than proceeding: that header is the only runtime
signal of the protocol version, and without it every call to a Foundry first-party service would
be unattributable.

The other headers the platform sets are `x-agent-user-id` (the end user, used to partition state
and never forwarded anywhere) and `x-request-id` (echoed back).

## Observability

Nothing to wire up: `serve` configures OpenTelemetry at startup, the way the reference hosts do.
A Foundry deployment injects `APPLICATIONINSIGHTS_CONNECTION_STRING`, so traces (`invoke_agent` /
`chat` / `execute_tool` spans with GenAI attributes, plus HTTP client spans for the outbound
`fetch` calls — the model and storage requests) and token-usage metrics appear in the project's
observability page / Application Insights without any code — the startup log prints
`exporting telemetry via: azure-monitor` when the wiring is live.

Locally, point OTLP at any collector (an Aspire dashboard, Jaeger):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm --filter example-02-foundry host
```

Message _content_ (prompts, system instructions, tool arguments, results) is never recorded on
spans unless you opt in with `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` — set it in
`agent.yaml`'s `environment_variables` if your tracing backend is allowed to see conversations.
(The Python hosting SDK turns content capture **on** unless that variable says otherwise, so a
Python agent shows message text in the portal where this host stays silent by default — that
difference is deliberate.) If you set it, verify it actually reached the registered version with
`GET /agents/<name>/versions/<n>`: as noted above, `environment_variables` does not arrive
through every deployment flow.
