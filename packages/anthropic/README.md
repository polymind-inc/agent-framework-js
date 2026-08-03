# @polymind-inc/agent-framework-anthropic

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

---

Part of [Agent Framework for TypeScript](https://github.com/polymind-inc/agent-framework) — an
independent community implementation of the Microsoft Agent Framework programming model. Not an
official Microsoft product, and not affiliated with or endorsed by Microsoft. MIT licensed.
