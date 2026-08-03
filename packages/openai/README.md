# @polymind-inc/agent-framework-openai

OpenAI (and Azure OpenAI) provider for the Agent Framework: `OpenAIChatClient` implements the
`ChatClient` interface from `@polymind-inc/agent-framework-core` on top of the official `openai` SDK's
Responses API, including streaming, structured output, and the provider-hosted tools
(web search, file search, code interpreter, hosted MCP).

## Quick start

```sh
npm install @polymind-inc/agent-framework-core @polymind-inc/agent-framework-openai openai
```

```ts
import { Agent } from '@polymind-inc/agent-framework-core';
import { OpenAIChatClient } from '@polymind-inc/agent-framework-openai';

const agent = new Agent({
  client: new OpenAIChatClient({ model: 'gpt-4o' }), // reads OPENAI_API_KEY
  instructions: 'You are a helpful assistant.',
});

const response = await agent.run('What can the Responses API do?');
console.log(response.text);
```

Known limitations:

- **Responses API only.** `api: 'chat_completions'` is permanently out of scope and throws
  `NotImplementedError` at construction. Point a Chat Completions-only provider at a
  Responses-compatible endpoint via `baseURL`, or implement the `ChatClient` interface from
  `@polymind-inc/agent-framework-core` directly.

---

Part of [Agent Framework for TypeScript](https://github.com/polymind-inc/agent-framework) — an
independent community implementation of the Microsoft Agent Framework programming model. Not an
official Microsoft product, and not affiliated with or endorsed by Microsoft. MIT licensed.
