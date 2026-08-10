# Examples

Run commands from the repository root after installing and building the workspace:

```bash
pnpm install --frozen-lockfile
pnpm -r build
```

Most provider examples make real API calls. Set the environment variables shown below before
running them. All commands use pnpm filters, so they work from the repository root.

## Get started

These examples use `OPENAI_API_KEY` and optionally `OPENAI_MODEL`.

| Example | What it demonstrates | Command |
| --- | --- | --- |
| Basic conversation | Awaited and streamed runs | `pnpm --filter example-01-get-started basic` |
| Tools | Typed local tools and the automatic function-calling loop | `pnpm --filter example-01-get-started tools` |
| Streaming | Incremental updates and folding the final response | `pnpm --filter example-01-get-started streaming` |
| Structured output | Schema-validated, typed response values | `pnpm --filter example-01-get-started structured-output` |
| Sessions | Multi-turn history, persistence, and restoration | `pnpm --filter example-01-get-started session` |
| Agent as a tool | Delegation from a coordinating agent to a specialist | `pnpm --filter example-01-get-started agent-as-tool` |
| Multimodal input | Sending a local image with a text prompt | `pnpm --filter example-01-get-started multimodal ./photo.png` |

## Microsoft Foundry

Foundry chat examples use Azure credentials from `DefaultAzureCredential`. Set
`FOUNDRY_PROJECT_ENDPOINT` and, when needed, `AZURE_AI_MODEL_DEPLOYMENT_NAME`.

| Example | What it demonstrates | Command |
| --- | --- | --- |
| Foundry chat | Calling a model deployment through a Foundry project | `pnpm --filter example-02-foundry chat` |
| Hosted Agent | Building and serving the Responses container protocol | `pnpm --filter example-02-foundry build`, then `pnpm --filter example-02-foundry host` |
| Invocations Hosted Agent | Serving the same agent over the Invocations protocol | `pnpm --filter example-02-foundry build`, then `pnpm --filter example-02-foundry invocations` |
| Tool approval | Pausing, persisting, approving, denying, and resuming locally | `pnpm --filter example-02-foundry approval` |
| Foundry Toolbox | Calling tools exposed by a Foundry Toolbox MCP endpoint | `pnpm --filter example-02-foundry toolbox` |
| Memory | Recalling facts across conversations, scoped per user | `pnpm --filter example-02-foundry memory:provision`, then `build` and `pnpm --filter example-02-foundry memory` |

See [`02-foundry/02-hosted-agent/README.md`](02-foundry/02-hosted-agent/README.md) for container
build and deployment instructions, and
[`02-foundry/06-memory-agent/README.md`](02-foundry/06-memory-agent/README.md) for the memory
store the memory sample needs.

## Extensibility and providers

| Example | What it demonstrates | Command and configuration |
| --- | --- | --- |
| Middleware | Agent and function middleware, caching, policy, and per-run hooks | `OPENAI_API_KEY=... pnpm --filter example-03-extensibility middleware` |
| Context provider | Injecting and persisting application context | `OPENAI_API_KEY=... pnpm --filter example-03-extensibility context-provider` |
| Anthropic | Tools, streaming, thinking, and structured output with Claude | `ANTHROPIC_API_KEY=... pnpm --filter example-03-extensibility anthropic` |
| MCP | Discovering and invoking remote MCP tools with approval | Set `OPENAI_API_KEY` and `MCP_SERVER_URL`, then run `pnpm --filter example-03-extensibility mcp` |
| OpenAI hosted tools | Provider-hosted web search and Code Interpreter | Set `OPENAI_API_KEY` and `OPENAI_MODEL`, then run `pnpm --filter example-03-extensibility hosted-tools` |

## Agent2Agent (A2A)

These examples need no API key: they run against a local A2A agent built with the A2A SDK's own
server. Start it first and leave it running, then run any of the clients in another terminal. Point
them at a different agent with `A2A_AGENT_URL`.

```bash
pnpm --filter example-04-a2a server
```

| Example | What it demonstrates | Command |
| --- | --- | --- |
| Local agent | The A2A agent the client examples talk to (JSON-RPC + agent card) | `pnpm --filter example-04-a2a server` |
| Remote agent | Card resolution, then the same turn awaited and streamed | `pnpm --filter example-04-a2a remote-agent` |
| Multi-turn | A question from the agent, task linking, and session persistence | `pnpm --filter example-04-a2a multi-turn` |
| Background | Continuation tokens: resuming a task, and re-subscribing to a live one | `pnpm --filter example-04-a2a background` |
| Authentication | A static token, and one that expires and is refreshed on a 401 | Start the agent with `A2A_TOKEN=invoice-secret`, then run `A2A_TOKEN=invoice-secret pnpm --filter example-04-a2a authentication` |
