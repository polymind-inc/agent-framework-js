# @polymind-inc/agent-framework-foundry

> **Constituent package.** The supported way to use the Agent Framework is the main
> [`@polymind-inc/agent-framework`](https://www.npmjs.com/package/@polymind-inc/agent-framework)
> package, which re-exports everything here under `@polymind-inc/agent-framework/foundry` (and
> `/foundry/hosting`) and pins this package to its exact version. Installing this package directly
> works and resolves to the same modules, but examples and documentation import through the main
> package.

Microsoft Foundry provider for the Agent Framework: `FoundryChatClient` talks to a Foundry
project (model deployments or server agents) with Microsoft Entra authentication, and the
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

Known limitations:

- `FoundryResponseStore` (the hosted default) keeps the response resource in the Foundry storage
  service and the background replay log beside the sandbox state — the storage service has no
  events API — so stream replay after a sandbox recycle fails closed rather than resuming.

---

Part of [Agent Framework for TypeScript](https://github.com/polymind-inc/agent-framework-js) — an
independent community implementation of the Microsoft Agent Framework programming model. Not an
official Microsoft product, and not affiliated with or endorsed by Microsoft. MIT licensed.
