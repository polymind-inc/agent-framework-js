# @polymind-inc/agent-framework

The Agent Framework for TypeScript in a single package — the runtime-agnostic core, the OpenAI /
Azure OpenAI, Anthropic and Microsoft Foundry providers, the MCP and A2A clients, and the Foundry
hosting pieces — mirroring what `pip install agent-framework` gives you in the Python
implementation. ESM only.

```sh
npm install @polymind-inc/agent-framework
```

The root entry is the core; everything else lives under a subpath:

| Import | Re-exports |
| ------ | ---------- |
| `@polymind-inc/agent-framework` | [`@polymind-inc/agent-framework-core`](https://www.npmjs.com/package/@polymind-inc/agent-framework-core) — `Agent`, `AgentSession`, `tool()`, middleware, Agent Skills, the `ChatClient` seam |
| `@polymind-inc/agent-framework/testing` | `@polymind-inc/agent-framework-core/testing` — `MockChatClient` |
| `@polymind-inc/agent-framework/openai` | [`@polymind-inc/agent-framework-openai`](https://www.npmjs.com/package/@polymind-inc/agent-framework-openai) |
| `@polymind-inc/agent-framework/anthropic` | [`@polymind-inc/agent-framework-anthropic`](https://www.npmjs.com/package/@polymind-inc/agent-framework-anthropic) |
| `@polymind-inc/agent-framework/mcp` | [`@polymind-inc/agent-framework-mcp`](https://www.npmjs.com/package/@polymind-inc/agent-framework-mcp) |
| `@polymind-inc/agent-framework/a2a` | [`@polymind-inc/agent-framework-a2a`](https://www.npmjs.com/package/@polymind-inc/agent-framework-a2a) |
| `@polymind-inc/agent-framework/foundry` | [`@polymind-inc/agent-framework-foundry`](https://www.npmjs.com/package/@polymind-inc/agent-framework-foundry) |
| `@polymind-inc/agent-framework/foundry/hosting` | `@polymind-inc/agent-framework-foundry/hosting` |
| `@polymind-inc/agent-framework/agentserver` | [`@polymind-inc/agent-framework-agentserver`](https://www.npmjs.com/package/@polymind-inc/agent-framework-agentserver) |
| `@polymind-inc/agent-framework/agentserver/node` | `@polymind-inc/agent-framework-agentserver/node` |
| `@polymind-inc/agent-framework/agentserver/observability` | `@polymind-inc/agent-framework-agentserver/observability` |

```ts
import { Agent, tool } from '@polymind-inc/agent-framework';
import { OpenAIChatClient } from '@polymind-inc/agent-framework/openai';
```

The subpaths are plain static re-exports, so a bundler tree-shakes whatever you do not import.
The constituent `@polymind-inc/agent-framework-*` packages are published as implementation detail
— this package pins them to its own exact version — and importing one directly resolves to the
same modules as the subpath above it. The supported, documented surface is this package; the
examples and every code sample in the repository import through it.

Requirements: Node.js >= 24, ESM only (no CommonJS build).
