# @polymind-inc/agent-framework-anthropic

> **Constituent package.** The supported way to use the Agent Framework is the main
> [`@polymind-inc/agent-framework`](https://www.npmjs.com/package/@polymind-inc/agent-framework)
> package, which re-exports everything here under `@polymind-inc/agent-framework/anthropic` and
> pins this package to its exact version. Installing this package directly works and resolves to
> the same modules, but examples and documentation import through the main package.

Anthropic provider for the Agent Framework: `AnthropicChatClient` implements the `ChatClient`
interface from `@polymind-inc/agent-framework-core` on top of the official `@anthropic-ai/sdk` Messages API,
including streaming, extended thinking, structured output and remote MCP servers. Pass an
`AnthropicBedrock`, `AnthropicVertex` or `AnthropicFoundry` client to reach Claude through those
gateways — the wire format is identical.

```sh
npm install @polymind-inc/agent-framework-core @polymind-inc/agent-framework-anthropic
```

```ts
import { Agent } from '@polymind-inc/agent-framework-core';
import { AnthropicChatClient } from '@polymind-inc/agent-framework-anthropic';

const agent = new Agent({
  client: new AnthropicChatClient({ model: 'claude-sonnet-4-5' }), // reads ANTHROPIC_API_KEY
  instructions: 'You are a helpful assistant.',
});

const response = await agent.run('Summarize the Messages API in one sentence.');
console.log(response.text);
```

## Tool arguments that are not an object

The Messages API requires `tool_use.input` to be a JSON object. A normal response always produces
one, but a transcript can reach the conversion from elsewhere — an interrupted stream, a restored
or hand-built history, arguments another provider wrote — and carry a scalar, an array, or text
that is not valid JSON.

Those are sent as `{ raw: <the value> }` rather than replaced with `{}`, matching Python. Only an
empty string maps to `{}`. Preserving them keeps the corruption visible: for a tool whose
parameters are all optional, `{}` is byte-for-byte a valid no-argument call, and the API does not
validate a replayed `tool_use.input` against the tool's schema, so an erased payload becomes a
plausible invocation that nothing downstream can detect.

If one of your tools declares a parameter named `raw`, a corrupted call for that tool will look to
the model like a call with `raw` set. Rename the parameter if that ambiguity matters.

`FunctionCallContent.arguments` and serialized sessions are never rewritten — this applies only to
what goes on the wire.

---

Part of [Agent Framework for TypeScript](https://github.com/polymind-inc/agent-framework-js) — an
independent community implementation of the Microsoft Agent Framework programming model. Not an
official Microsoft product, and not affiliated with or endorsed by Microsoft. MIT licensed.
