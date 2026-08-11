# Hosted Agent with Toolbox MCP Skills (Microsoft Foundry)

A Hosted Agent that gets its domain knowledge from **Agent Skills served by a Foundry toolbox**.
Skills are authored as `SKILL.md`, published by the toolbox over MCP, and pulled into the model's
context only when a task needs one — so the policies an agent must follow ship separately from the
agent's code, and updating them does not mean redeploying the container.

| File                  | What it is                                                                     |
| --------------------- | ------------------------------------------------------------------------------ |
| `main.ts`             | The agent, its skills provider, and the server that publishes it               |
| `agent.yaml`          | The Foundry agent definition (`kind: hosted`, protocol declaration, resources) |
| `agent.manifest.yaml` | The `azd` manifest: the chat deployment this agent needs                        |
| `Dockerfile`          | Copies the prebuilt bundle into `node:24-slim` and exposes port 8088            |
| `tsdown.config.ts`    | Bundles the TypeScript host and all runtime dependencies into `dist/main.mjs`  |

## What the provider does

`toolbox.asSkillsProvider()` is a `ContextProvider`. Before each run it reads the toolbox's
`skill://index.json` and puts **only** each skill's name and description into the system prompt.
The model then decides:

- `load_skill` — fetch a skill's full `SKILL.md` body;
- `read_skill_resource` — fetch a document that body refers to.

(`run_skill_script` is registered too, but a skill served over MCP carries no runnable scripts —
there is no remote-execution protocol behind it — so calling it answers `Script not found`.
Scripts exist for skills defined in code; see the extensibility example.)

That is the point of the design: twenty skills cost a couple of thousand tokens per run, not twenty
full bodies. A skill's body is fetched once per discovered skill and reused for the rest of the
conversation.

Discovery uses the connection the toolbox's tools already use, so it carries the same per-call
Entra token and the same `x-agent-foundry-call-id` — there is no second credential to configure.
The sample wires both halves — `tools: await toolbox.getTools()` and the skills provider — and
sets `loadTools: false`, which makes that `getTools()` answer an empty list without asking the
gateway. Drop the flag and the model gets the toolbox's tools alongside its skills, which is often
what you want, since a skill body is frequently instructions for using exactly those tools.

## Set it up

Configure a toolbox in the Foundry project and publish skills to it, then:

```bash
export FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
export AZURE_AI_MODEL_DEPLOYMENT_NAME=gpt-4o-mini
export FOUNDRY_TOOLBOX_NAME=<toolbox>
```

A toolbox that publishes no skill index is not an error: the provider contributes nothing and the
agent runs as an ordinary assistant. An entry the framework cannot use — an `archive` skill, a
malformed name — is skipped and named through `onSkillError` rather than failing the turn. A
toolbox that *refuses* the request, on the other hand, fails the run, because an agent quietly
running without the policies it was configured with is worse than one that reports why it cannot.

## Run it locally

From the repository root:

```bash
pnpm install && pnpm -r build
```

Then start the bundle:

```bash
pnpm --filter example-02-foundry toolbox-skills
```

For source-level development without rebuilding after every edit, use `toolbox-skills:dev`.

### See it load a skill

```bash
curl -sS -X POST localhost:8088/responses -H 'content-type: application/json' -H 'x-agent-user-id: rin' -d '{"input": "What is our policy on refunds over $500?"}'
```

The response items show `load_skill` being called before the answer. Ask something no skill covers
and it answers without loading one — which is the disclosure working rather than a failure.

## Approval

Every skill tool requires approval by default, so a skill operation surfaces on
`response.userInputRequests` before it runs. A hosted agent runs unattended, so `main.ts` relaxes
the two read tools. `run_skill_script` keeps its default untouched because for toolbox skills it
has nothing to guard: skills served over MCP carry no runnable scripts, and calling it answers
`Script not found`.

## Deploy it

Same as the [Hosted Agent sample](../02-hosted-agent/README.md) — build the bundle, build the
image, push it, and `azd ai agent deploy`. Two differences:

- the agent's managed identity needs to reach the toolbox (the same access its tools require) —
  and for skills specifically, the **Foundry User** role on the AI services account: without it the
  gateway serves the skill *index*, so discovery and advertisement work, but every `load_skill`
  body read is refused and the tool reports a failure;
- `FOUNDRY_TOOLBOX_NAME` has to reach the container, which `agent.yaml` already declares.

If a tool source behind the toolbox needs the end user's OAuth consent, the gateway refuses with
`CONSENT_REQUIRED`. Where that refusal lands depends on what runs first. With `loadTools` dropped,
the factory's `await toolbox.getTools()` runs `tools/list` while the agent is being built, and the
host turns the refusal into an `oauth_consent_request` item the caller can act on. With
`loadTools: false` the gateway is first contacted by skill discovery, which happens inside the
run, so the same refusal fails the turn instead — keep the tools loaded if the toolbox has
consent-gated sources.
