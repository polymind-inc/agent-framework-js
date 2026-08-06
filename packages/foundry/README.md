# @polymind-inc/agent-framework-foundry

> **Constituent package.** The supported way to use the Agent Framework is the main
> [`@polymind-inc/agent-framework`](https://www.npmjs.com/package/@polymind-inc/agent-framework)
> package, which re-exports everything here under `@polymind-inc/agent-framework/foundry` (and
> `/foundry/hosting`) and pins this package to its exact version. Installing this package directly
> works and resolves to the same modules, but examples and documentation import through the main
> package.

Microsoft Foundry provider for the Agent Framework: `FoundryChatClient` talks to a Foundry
project (model deployments or server agents) with Microsoft Entra authentication, and the
`@polymind-inc/agent-framework-foundry/hosting` subpath publishes an `Agent` as a Foundry Hosted Agent over
the Responses container protocol implemented by `@polymind-inc/agent-framework-agentserver`.

```sh
npm install @polymind-inc/agent-framework-core @polymind-inc/agent-framework-foundry

# Only needed to host an agent:
npm install @polymind-inc/agent-framework-agentserver
```

`@polymind-inc/agent-framework-agentserver` is an optional peer dependency: only the `./hosting` subpath
needs it, so consumers using just `FoundryChatClient` can leave it uninstalled.

Known limitations:

- **Hosted background responses against Foundry storage are fail-closed (501)** until
  `FoundryResponseStore` implements event persistence; foreground turns and the file-backed
  store are unaffected.
- The default hosted response store is file-backed: writes to the Foundry storage service were
  observed to fail server-side, so `FoundryResponseStore` is opt-in.

---

Part of [Agent Framework for TypeScript](https://github.com/polymind-inc/agent-framework-js) — an
independent community implementation of the Microsoft Agent Framework programming model. Not an
official Microsoft product, and not affiliated with or endorsed by Microsoft. MIT licensed.
