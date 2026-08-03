# @polymind-inc/agent-framework-mcp

Model Context Protocol client integration for the Agent Framework: `MCPClient` connects to an MCP
server and exposes its tools as framework `FunctionTool`s, so an agent calls them like any other
tool. Built on `@modelcontextprotocol/client` v2. Each `tools/call` is traced as an MCP client span
per the OpenTelemetry MCP semantic conventions.

```sh
npm install @polymind-inc/agent-framework-core @polymind-inc/agent-framework-mcp
```

## Scope: tools only

This package implements the **tool** half of MCP (`tools/list`, `tools/call`). The following parts
of the protocol are deliberately **not supported**, and the client advertises no capability for the
server-initiated ones — so a well-behaved server never issues them:

| Not supported                  | What it is                                                     | Why                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sampling/createMessage`       | The server asks the _client_ to run a model call on its behalf | Needs a chat client wired back into the MCP connection plus a security gate: the requester is untrusted remote code. The Python reference implementation supports it only behind a deny-by-default approval callback with per-session request and token caps (`_mcp.py`); .NET has no equivalent. Out of scope until the framework has somewhere to put that gate. |
| `elicitation/create`           | The server asks the client to collect input from the human     | **No reference implementation supports it** — neither Python's MCP integration nor .NET's `Microsoft.Agents.AI.Mcp` — so there is no parity gap to close.                                                                                                                                                                                                          |
| `prompts/list` / `prompts/get` | Reusable prompt templates a server publishes                   | Python can load them as extra tools (`load_prompts`, default on); .NET does not. Not implemented here: a prompt is a message template rather than a callable, and turning one into a `FunctionTool` is a modelling decision, not a mapping.                                                                                                                        |

Resources (`resources/list`, `resources/read`) are likewise not enumerated. Resource _content_
returned by a tool call is fully supported: `resource` and `resource_link` blocks in a
`CallToolResult` are mapped to framework content internally.

A tool result's `_meta` envelope is preserved: it is copied onto every content item produced from
that result under `additionalProperties._meta`, matching the reference implementation, so a layer
above can read per-item labels a server attached.

## Connection sources

`MCPClient` accepts exactly one connection source:

- `url` creates a fresh Streamable HTTP transport when the connection must be reopened.
- `transportFactory` creates a fresh stdio, in-memory, or custom transport per connection attempt
  and therefore supports automatic reconnect.
- `transport` accepts one already-created transport for simple embedding and tests. Automatic
  reconnect is disabled because common SDK transports cannot be started again after they close.

---

Part of [Agent Framework for TypeScript](https://github.com/polymind-inc/agent-framework) — an
independent community implementation of the Microsoft Agent Framework programming model. Not an
official Microsoft product, and not affiliated with or endorsed by Microsoft. MIT licensed.
