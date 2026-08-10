# Hosted Agent over the Invocations protocol (Microsoft Foundry)

An agent built with `agent-framework-js`, published over the **Invocations protocol** and
deployable to Microsoft Foundry. Use this protocol when your callers cannot speak the Responses
request shape — a webhook, a custom client, non-conversational processing. For the
OpenAI-compatible `/responses` endpoint, see [`../02-hosted-agent`](../02-hosted-agent).

| File                  | What it is                                                                     |
| --------------------- | ------------------------------------------------------------------------------ |
| `main.ts`             | The agent, and the server that publishes it                                    |
| `agent.yaml`          | The Foundry agent definition (`kind: hosted`, protocol declaration, resources) |
| `agent.manifest.yaml` | The `azd` manifest: the model deployment this agent needs                      |
| `Dockerfile`          | Copies the prebuilt bundle into `node:24-slim` and exposes port 8088           |
| `tsdown.config.ts`    | Bundles the TypeScript host and all runtime dependencies into `dist/main.mjs`  |

## Run it locally

From the repository root:

```bash
pnpm install && pnpm -r build
```

With `az login` done and the project endpoint set, start the bundle:

```bash
FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project> AZURE_AI_MODEL_DEPLOYMENT_NAME=gpt-4o-mini pnpm --filter example-02-foundry invocations
```

For source-level development without rebuilding the bundle after every edit, use
`invocations:dev`. The server binds `0.0.0.0:8088` (override with `PORT`).

### Check it

Readiness — the probe the platform waits on before sending any traffic:

```bash
curl localhost:8088/readiness
```

A first turn — the request shape is `{ "message": string, "stream"?: boolean }`, and the answer
comes back as plain text:

```bash
curl -sS -X POST localhost:8088/invocations -H 'content-type: application/json' -d '{"message": "My name is Alice."}'
```

The platform stores no conversation history for this protocol. To continue the conversation,
take the `x-agent-session-id` response header and pass it back as the `agent_session_id` query
parameter — hosted, that routes the turn to the same sandbox, whose memory holds the transcript:

```bash
curl -sS -X POST 'localhost:8088/invocations?agent_session_id=REPLACE_ME' -H 'content-type: application/json' -d '{"message": "What is my name?"}'
```

Stream instead of waiting:

```bash
curl -sS -N -X POST localhost:8088/invocations -H 'content-type: application/json' -d '{"message": "Hi", "stream": true}'
```

## Deploy it to Foundry

The flow is the same as the Responses sample's — the manifest and CLI are protocol-agnostic. From
this directory:

```bash
azd ext install azure.ai.agents
azd ai agent init -m agent.manifest.yaml
azd provision
```

Build the framework packages and the bundle from the repository root, then run locally against
the provisioned project or deploy:

```bash
pnpm install --frozen-lockfile && pnpm -r build
azd ai agent run   # local container, real credentials
azd deploy
```

See [`../02-hosted-agent/README.md`](../02-hosted-agent/README.md) for the notes on deploying
against an existing project — everything there applies, with `--protocol invocations` in place of
`--protocol responses`.
