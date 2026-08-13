/**
 * 04 — MCP tools.
 *
 * `McpClient` turns an MCP server's tools into framework tools, so the agent calls them exactly
 * like local ones. The connection opens on the first `getTools()` and each `tools/call` is traced
 * as an MCP client span.
 *
 * Run: `OPENAI_API_KEY=... MCP_SERVER_URL=https://… pnpm --filter example-03-extensibility mcp`
 */
import { Agent, approvalResponse } from '@polymind-inc/agent-framework';
import { McpClient } from '@polymind-inc/agent-framework/mcp';
import { OpenAIChatClient } from '@polymind-inc/agent-framework/openai';

const url = process.env.MCP_SERVER_URL;
if (url === undefined) {
  console.error('Set MCP_SERVER_URL to an MCP server’s Streamable HTTP endpoint.');
  process.exit(1);
}

const mcp = new McpClient({
  url,
  ...(process.env.MCP_AUTH_TOKEN === undefined
    ? {}
    : { headers: { authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } }),
  // An MCP server is remote code chosen by URL: its tools run with whatever this process can
  // reach, and its tool descriptions and results enter the model's context. For a server you do
  // not operate, put a human in front of every call.
  approvalMode: 'always_require',
});

const tools = await mcp.getTools();
console.log(`${tools.length} tool(s):`, tools.map((entry) => entry.name).join(', '));

const agent = new Agent({
  client: new OpenAIChatClient({ model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini' }),
  instructions: 'Use the available tools to answer.',
  tools,
});

const session = agent.createSession();
const first = await agent.run(process.argv[2] ?? 'What can you do with the available tools?', {
  session,
});

if (first.userInputRequests.length === 0) {
  console.log(first.text);
} else {
  // Approve everything here for the sake of the example; a real caller asks a person.
  const decisions = first.userInputRequests
    .filter((request) => request.type === 'function_approval_request')
    .map((request) => {
      console.log(
        `approving ${request.functionCall.name}(${JSON.stringify(request.functionCall.arguments)})`,
      );
      return approvalResponse(request, true, { reason: 'approved by the example' });
    });
  console.log((await agent.run(decisions, { session })).text);
}

await mcp.close();
