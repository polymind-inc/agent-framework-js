# Hosted Agent with memory (Microsoft Foundry)

A Hosted Agent that remembers what a user told it in an **earlier conversation**. The transcript
already carries the current conversation; a
[Foundry Memory Store](https://learn.microsoft.com/azure/ai-foundry/agents/concepts/agent-memory)
is what survives it.

| File                  | What it is                                                                     |
| --------------------- | ------------------------------------------------------------------------------ |
| `main.ts`             | The agent, its memory provider, and the server that publishes it               |
| `provision.ts`        | Creates the memory store once, and can erase one user's memories               |
| `agent.yaml`          | The Foundry agent definition (`kind: hosted`, protocol declaration, resources) |
| `agent.manifest.yaml` | The `azd` manifest: the chat and embedding deployments this agent needs         |
| `Dockerfile`          | Copies the prebuilt bundle into `node:24-slim` and exposes port 8088            |
| `tsdown.config.ts`    | Bundles the TypeScript host and all runtime dependencies into `dist/main.mjs`  |

## What the provider does

`FoundryMemoryProvider` is a `ContextProvider`, so it sees every run twice:

- **before the run** it searches the store — once per session for the user's profile memories, and
  on every turn for memories relevant to what was just said — and injects what it finds as a single
  user message under a `## Memories` heading;
- **after the run** it sends the turn to the store, which extracts memories from it asynchronously.

Memories are partitioned by **scope**. Here the scope is `hostedUserScope()`, which resolves to the
end-user id the platform injects with each request, so one long-lived provider serves every user of
the container without their memories ever meeting. Outside a hosted container there is no such
identity — pass a scope of your own (a string, or a function of the run).

## Set it up

```bash
export FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
export AZURE_AI_MODEL_DEPLOYMENT_NAME=gpt-4o-mini
export AZURE_AI_EMBEDDING_MODEL_DEPLOYMENT_NAME=text-embedding-3-small
export MEMORY_STORE_NAME=sample-memories
```

With `az login` done and **Azure AI User** on the project, create the store:

```bash
pnpm --filter example-02-foundry memory:provision
```

The store is configured with user-profile extraction on and chat summaries off, so it remembers
durable preferences rather than the shape of each conversation. Re-running the script is safe.

## Run it locally

From the repository root:

```bash
pnpm install && pnpm -r build
```

Then start the bundle:

```bash
pnpm --filter example-02-foundry memory
```

For source-level development without rebuilding after every edit, use `memory:dev`.

### See it remember

The memory scope comes from the caller's identity, so send one — locally the container accepts the
same header the platform sets:

```bash
curl -sS -X POST localhost:8088/responses -H 'content-type: application/json' -H 'x-agent-user-id: rin' -d '{"input": "I only drink black coffee, no sugar."}'
```

Extraction is asynchronous and takes a few seconds. Then start a **new** conversation — no
`previous_response_id`, so nothing of the first exchange is in the transcript:

```bash
curl -sS -X POST localhost:8088/responses -H 'content-type: application/json' -H 'x-agent-user-id: rin' -d '{"input": "Order me a coffee."}'
```

The answer comes back without sugar. Ask as a different user (`x-agent-user-id: kai`) and it has
nothing to go on — which is the isolation boundary doing its job.

To start over:

```bash
pnpm --filter example-02-foundry memory:provision -- --reset rin
```

## Deploy it

Same as the [Hosted Agent sample](../02-hosted-agent/README.md) — build the bundle, build the
image, push it, and `azd ai agent deploy`. Two differences:

- the agent's managed identity needs access to the memory store's project (**Azure AI User** on the
  project scope is enough for both the model and the store);
- `MEMORY_STORE_NAME` has to reach the container, which `agent.yaml` already declares.

Provision the store **before** the first deployment: a missing store makes every search and update
fail, and with the default `failureMode: 'continue'` that is a silent loss of memory rather than a
visible error. The `onFailure` hook in `main.ts` is what makes it visible in the container log.
