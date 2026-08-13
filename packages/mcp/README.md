# @polymind-inc/agent-framework-mcp

> **Constituent package.** The supported way to use the Agent Framework is the main
> [`@polymind-inc/agent-framework`](https://www.npmjs.com/package/@polymind-inc/agent-framework)
> package, which re-exports everything here under `@polymind-inc/agent-framework/mcp` and pins
> this package to its exact version. Installing this package directly works and resolves to the
> same modules, but examples and documentation import through the main package.

Model Context Protocol client integration for the Agent Framework: `McpClient` connects to an MCP
server and exposes its tools as framework `FunctionTool`s, so an agent calls them like any other
tool. Built on `@modelcontextprotocol/client` v2. Each `tools/call` is traced as an MCP client span
per the OpenTelemetry MCP semantic conventions.

`mcpSkillsSource` — also reachable as `client.skillsSource()` — discovers the **Agent Skills** a
server publishes, for `skillsProvider` from the core:

```ts
const agent = new Agent({ client, contextProviders: [skillsProvider(mcp.skillsSource())] });
```

It reads the well-known `skill://index.json` catalogue and fetches each skill's `SKILL.md` body,
and any document that body refers to, only when the model asks for it.

```sh
npm install @polymind-inc/agent-framework-core @polymind-inc/agent-framework-mcp
```

## Scope: tools and skills

This package implements the **tool** half of MCP (`tools/list`, `tools/call`) plus the
`resources/read` requests skill discovery needs. The following parts
of the protocol are deliberately **not supported**, and the client advertises no capability for the
server-initiated ones — so a well-behaved server never issues them:

| Not supported                  | What it is                                                     | Why                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sampling/createMessage`       | The server asks the _client_ to run a model call on its behalf | Needs a chat client wired back into the MCP connection plus a security gate: the requester is untrusted remote code. The Python reference implementation supports it only behind a deny-by-default approval callback with per-session request and token caps (`_mcp.py`); .NET has no equivalent. Out of scope until the framework has somewhere to put that gate. |
| `elicitation/create`           | The server asks the client to collect input from the human     | **No reference implementation supports it** — neither Python's MCP integration nor .NET's `Microsoft.Agents.AI.Mcp` — so there is no parity gap to close.                                                                                                                                                                                                          |
| `prompts/list` / `prompts/get` | Reusable prompt templates a server publishes                   | Python can load them as extra tools (`load_prompts`, default on); .NET does not. Not implemented here: a prompt is a message template rather than a callable, and turning one into a `FunctionTool` is a modelling decision, not a mapping.                                                                                                                        |

Resources are **read, not enumerated**: `McpConnection.readResource` fetches a URI, and the skills
source uses it for the catalogue, the bodies and their referenced documents, but `resources/list`
and subscriptions are not implemented. Resource _content_ returned by a tool call is fully
supported: `resource` and `resource_link` blocks in a `CallToolResult` are mapped to framework
content internally.

Skill discovery covers `skill-md` index entries. `archive` entries — a whole skill packed into a
ZIP or TAR — are skipped and reported, because unpacking one means a ZIP and TAR reader this
package will not take a dependency on. `mcp-resource-template` entries and direct `skill://`
references are likewise skipped: the specification work behind them is still a draft, and the
reference implementations have deferred their design too. Skills served over MCP carry no runnable
scripts — there is no remote-execution protocol behind `run_skill_script`, so calling it on one
answers `Script not found`, as it does in the reference implementations.

A tool result's `_meta` envelope is preserved: it is copied onto every content item produced from
that result under `additionalProperties._meta`, matching the reference implementation, so a layer
above can read per-item labels a server attached.

## Connection sources

`McpClient` accepts exactly one connection source:

- `url` creates a fresh Streamable HTTP transport when the connection must be reopened.
- `transportFactory` creates a fresh stdio, in-memory, or custom transport per connection attempt
  and therefore supports automatic reconnect.
- `transport` accepts one already-created transport for simple embedding and tests. Automatic
  reconnect is disabled because common SDK transports cannot be started again after they close.

---

Part of [Agent Framework for TypeScript](https://github.com/polymind-inc/agent-framework-js) — an
independent community implementation of the Microsoft Agent Framework programming model. Not an
official Microsoft product, and not affiliated with or endorsed by Microsoft. MIT licensed.
