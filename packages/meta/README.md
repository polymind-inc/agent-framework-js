# @polymind-inc/agent-framework

Umbrella package for the Agent Framework for TypeScript. One install brings in the whole family —
the runtime-agnostic core, the OpenAI / Azure OpenAI, Anthropic and Microsoft Foundry providers,
the MCP and A2A clients, and the Foundry hosting pieces — mirroring what `pip install
agent-framework` gives you in the Python implementation. ESM only.

```sh
npm install @polymind-inc/agent-framework
```

The root entry is the core; everything else lives under a subpath:

| Import | Re-exports |
| ------ | ---------- |
| `@polymind-inc/agent-framework` | [`@polymind-inc/agent-framework-core`](https://www.npmjs.com/package/@polymind-inc/agent-framework-core) — `Agent`, `AgentSession`, `tool()`, middleware, the `ChatClient` seam |
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
If install size matters more than convenience — this package pulls in every provider SDK and the
hosting server's OpenTelemetry dependencies — install the individual packages instead; they are
the same code, and the two styles can be mixed freely.

Requirements: Node.js >= 24, ESM only (no CommonJS build).
