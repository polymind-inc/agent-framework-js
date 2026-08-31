# @polymind-inc/agent-framework-foundry

> **Constituent package.** The supported way to use the Agent Framework is the main
> [`@polymind-inc/agent-framework`](https://www.npmjs.com/package/@polymind-inc/agent-framework)
> package, which re-exports everything here under `@polymind-inc/agent-framework/foundry` (and
> `/foundry/hosting`) and pins this package to its exact version. Installing this package directly
> works and resolves to the same modules, but examples and documentation import through the main
> package.

Microsoft Foundry provider for the Agent Framework: `FoundryProject` names the project — the
endpoint requests go to and the Microsoft Entra identity they carry — and is shared by every
component here, the way an `AIProjectClient` is shared in the Azure SDKs. `FoundryChatClient`
talks to the project (model deployments or server agents),
`FoundryMemoryProvider` gives an agent persistent memory backed by a Foundry Memory Store, and the
`@polymind-inc/agent-framework-foundry/hosting` subpath publishes an `Agent` as a Foundry Hosted
Agent — `ResponsesHostServer` over the Responses container protocol, `InvocationsHostServer` over
the Invocations protocol — on the servers implemented by
`@polymind-inc/agent-framework-agentserver`.

```sh
npm install @polymind-inc/agent-framework-core @polymind-inc/agent-framework-foundry

# Only needed to host an agent:
npm install @polymind-inc/agent-framework-agentserver
```

`@polymind-inc/agent-framework-agentserver` is an optional peer dependency: only the `./hosting` subpath
needs it, so consumers using just `FoundryChatClient` can leave it uninstalled.

The hosting subpath also carries `FoundryToolbox`, which reaches a toolbox registered in the
project over MCP. A toolbox publishes two independent things and the class exposes both:
`getTools()` for its tools, and `asSkillsProvider()` for the **Agent Skills** it serves. Both ride
the same connection, so skills need no separate credential — and `loadTools: false` gives an agent
the skills without exposing the tools.

Known limitations:

- `FoundryToolbox.asSkillsProvider()` discovers skills inside the run rather than while the agent
  is being built, so a `CONSENT_REQUIRED` refusal raised by discovery fails the turn instead of
  becoming an `oauth_consent_request` item. Wiring the toolbox's tools as well — `tools: await
  toolbox.getTools()` in the hosted handler's agent factory — makes `tools/list` meet the same
  gate during construction, where the host does surface it.
- Skills served by a toolbox (or any MCP server) carry no runnable scripts: there is no
  remote-execution protocol behind `run_skill_script`, so calling it on one answers
  `Script not found`.
- `FoundryMemoryProvider` targets the preview memory-store API (`Foundry-Features:
  MemoryStores=V1Preview`) and implements the routes a context provider needs — search, update,
  update-result polling, scope deletion, and store creation. Memory *items* have their own CRUD
  routes, which are not covered.
- `FoundryResponseStore` (the hosted default) keeps the response resource in the Foundry storage
  service and the background replay log beside the sandbox state — the storage service has no
  events API — so stream replay after a sandbox recycle fails closed rather than resuming.

## Where a local run stores responses

`ResponsesHostServer` outside a container writes responses to
`${AGENTSERVER_STATE_ROOT}/responses` (`~/.agentserver/responses` by default), so restarting
`node main.ts` does not break a `previous_response_id` chain. Transcripts land there as plain
JSON: nothing encrypts, expires or bounds them, so retention and cleanup are yours, and the
directory needs the protection the conversations do. Point `AGENTSERVER_STATE_ROOT` elsewhere to
move it, or opt out entirely:

```ts
new ResponsesHostServer({ agent, store: new InMemoryResponseProvider() });
```

A hosted container is unchanged: the Foundry storage service when the platform injects the
project endpoint, the sandbox filesystem when it somehow does not.

---

Part of [Agent Framework for TypeScript](https://github.com/polymind-inc/agent-framework-js) — an
independent community implementation of the Microsoft Agent Framework programming model. Not an
official Microsoft product, and not affiliated with or endorsed by Microsoft. MIT licensed.
