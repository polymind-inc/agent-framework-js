import type { AccessToken, TokenCredential } from '@azure/identity';
import type { CallToolRequestOptions, CallToolResult } from '@modelcontextprotocol/client';
import { Client, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import {
  createRequestContext,
  HEADERS,
  runWithRequestContext,
} from '@polymind-inc/agent-framework-agentserver';
import type { ContextProvider, Tool } from '@polymind-inc/agent-framework-core';
import {
  AgentSession,
  ConfigurationError,
  isFunctionTool,
  ToolInvocationError,
} from '@polymind-inc/agent-framework-core';
import { assert, describe, expect, it, vi } from 'vitest';
import { FoundryProject } from '../project.js';
import { ToolboxConsentRequiredError } from './consent.js';
import { FoundryToolbox } from './toolbox.js';

const PROJECT = 'https://my-resource.services.ai.azure.com/api/projects/my-project';

let tokenCounter = 0;
const credential: TokenCredential = {
  async getToken(): Promise<AccessToken> {
    tokenCounter++;
    return { token: `token-${tokenCounter}`, expiresOnTimestamp: Date.now() + 3_600_000 };
  },
};

interface RecordedCall {
  method: string;
  headers: Record<string, string>;
  /** The tool name a `tools/call` request carried, absent for other methods. */
  toolName?: string;
}

/** An MCP tool declaration. `inputSchema` is required by the protocol. */
interface StubTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * A stub MCP server, spoken over the real `StreamableHTTPClientTransport`.
 *
 * Driving the actual transport rather than a fake `Client` is the point: the property under test
 * is which headers reach the wire, and that only exists inside the `fetch` the transport calls.
 */
function stubToolbox(
  options: {
    tools?: StubTool[];
    allowedTools?: string[];
    toolFails?: boolean;
    /** Answer `tools/call` with exactly this result, verbatim. */
    toolResult?: Record<string, unknown>;
    failFirstConnect?: boolean;
    /** 1-based `tools/call` indices answered with HTTP 404 — the expired-session signal. */
    dieOnToolCalls?: readonly number[];
    /** Answer this MCP method with the gateway's JSON-RPC `-32006` CONSENT_REQUIRED error. */
    consentOn?: 'tools/list' | 'tools/call' | 'resources/read';
    /** Resources the toolbox serves over `resources/read`, keyed by URI. */
    resources?: Record<string, string>;
    /** Passed straight to the toolbox; `false` hides its tools from the model. */
    loadTools?: boolean;
    /** Passed straight to the toolbox: namespaces the exposed tool names. */
    toolNamePrefix?: string;
    /** The first request awaits this before reaching the stub, so a test can race `close()` in. */
    holdFirstRequest?: Promise<void>;
    /** `tools/call` requests await this forever, so a test can abort one in flight. */
    holdToolCalls?: Promise<void>;
    /** Resolved once a `tools/call` has reached the stub. */
    onToolCall?: () => void;
  } = {},
): {
  toolbox: FoundryToolbox;
  calls: RecordedCall[];
} {
  const tools: StubTool[] = (
    options.tools ?? [{ name: 'search_docs', description: 'Search the documentation' }]
  ).map((tool) => ({
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    ...tool,
  }));
  const calls: RecordedCall[] = [];
  let failedOnce = false;
  let held = false;
  let toolCallCount = 0;

  const fetchStub = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (options.holdFirstRequest !== undefined && !held) {
      held = true;
      await options.holdFirstRequest;
    }
    if (options.failFirstConnect === true && !failedOnce) {
      failedOnce = true;
      throw new Error('connection reset');
    }
    const request = JSON.parse(String(init?.body ?? '{}')) as {
      id?: number;
      method?: string;
      params?: { name?: string };
    };
    if (request.method === 'tools/call' && (options.dieOnToolCalls ?? []).includes(++toolCallCount)) {
      // What a Foundry toolbox answers once it has expired the MCP session.
      return new Response('Session terminated', { status: 404 });
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    calls.push({
      method: request.method ?? '(none)',
      headers,
      ...(typeof request.params?.name === 'string' && request.method === 'tools/call'
        ? { toolName: request.params.name }
        : {}),
    });

    if (request.method === 'tools/call' && options.holdToolCalls !== undefined) {
      options.onToolCall?.();
      await options.holdToolCalls;
    }

    // A notification has no id and expects no body.
    if (request.id === undefined) {
      return new Response(null, { status: 202 });
    }

    if (options.consentOn !== undefined && request.method === options.consentOn) {
      // What the Foundry MCP gateway answers when a tool source needs the user's OAuth consent:
      // a JSON-RPC error *answer* with code -32006 whose message embeds the consent envelope
      // (Python `consent_url_from_error` documents the format).
      const message =
        `${options.consentOn} failed for 1 tool source(s), succeeded for 0 tool source(s) ` +
        '{"errors":[{"name":"github","type":"mcp","error":' +
        '{"code":"CONSENT_REQUIRED","message":"https://consent.example.com/auth"}}]}';
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32006, message } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (request.method === 'resources/read') {
      const uri = String((request as { params?: { uri?: unknown } }).params?.uri);
      const text = options.resources?.[uri];
      const answer =
        text === undefined
          ? { error: { code: -32602, message: `Resource not found: ${uri}`, data: { uri } } }
          : { result: { contents: [{ uri, mimeType: 'text/plain', text }] } };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...answer }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const result =
      request.method === 'initialize'
        ? {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'stub-toolbox', version: '1.0.0' },
          }
        : request.method === 'tools/list'
          ? { tools }
          : (options.toolResult ??
            (options.toolFails === true
              ? { content: [{ type: 'text', text: 'the upstream API rejected it' }], isError: true }
              : { content: [{ type: 'text', text: 'stub result' }] }));

    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  return {
    toolbox: new FoundryToolbox({
      name: 'my-toolbox',
      project: new FoundryProject(PROJECT, credential),
      fetch: fetchStub,
      ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
      ...(options.loadTools === undefined ? {} : { loadTools: options.loadTools }),
      ...(options.toolNamePrefix === undefined ? {} : { toolNamePrefix: options.toolNamePrefix }),
    }),
    calls,
  };
}

/** Runs `fn` as though it were serving a platform request. */
async function asPlatformRequest<T>(headers: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext(createRequestContext(new Headers(headers)), fn);
}

describe('FoundryToolbox endpoint', () => {
  it('builds the toolbox MCP endpoint with the data-plane api-version', () => {
    const { toolbox } = stubToolbox();
    expect(toolbox.url).toBe(`${PROJECT}/toolboxes/my-toolbox/mcp?api-version=v1`);
  });

  it('escapes the toolbox name so it cannot climb out of the path', () => {
    const toolbox = new FoundryToolbox({
      name: 'a/../../evil',
      project: new FoundryProject(PROJECT, credential),
    });
    expect(toolbox.url).toBe(`${PROJECT}/toolboxes/a%2F..%2F..%2Fevil/mcp?api-version=v1`);
  });

  it('refuses a relative endpoint at construction rather than failing on the first request', () => {
    // A misconfigured endpoint should surface where it was configured, not as a broken MCP URL on
    // the first tool call.
    expect(() => new FoundryProject('/api/projects/p', credential)).toThrow(ConfigurationError);
  });

  it('retries the connection on the next request after a failed attempt', async () => {
    // A transient failure — the toolbox briefly unreachable, a token refused — must fail the one
    // request that hit it, not stay cached as a rejection until the container restarts.
    const { toolbox } = stubToolbox({ failFirstConnect: true });

    await expect(toolbox.getTools()).rejects.toThrow(/connection reset/);
    expect(toolbox.connected).toBe(false);

    const tools = await toolbox.getTools();
    expect(tools.map((tool) => tool.name)).toEqual(['search_docs']);
    await toolbox.close();
  });

  it('does not connect until the tools are actually needed', async () => {
    const { toolbox, calls } = stubToolbox();

    // Connecting at construction would put a flaky toolbox on the readiness path, where a failure
    // takes every invocation down with `session_not_ready`.
    expect(toolbox.connected).toBe(false);
    expect(calls).toHaveLength(0);

    await toolbox.getTools();
    expect(toolbox.connected).toBe(true);
    await toolbox.close();
  });
});

describe('FoundryToolbox tools', () => {
  it('exposes the server’s tools as function tools', async () => {
    const { toolbox } = stubToolbox();

    const tools = await toolbox.getTools();

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      kind: 'function',
      name: 'search_docs',
      description: 'Search the documentation',
    });
    const firstTool = tools[0];
    assert.exists(firstTool);
    expect(isFunctionTool(firstTool)).toBe(true);
    await toolbox.close();
  });

  it('leaves the description empty when the server declares none', async () => {
    // Python parity (`tool.description or ""`): the name is not reused as a stand-in description.
    const { toolbox } = stubToolbox({ tools: [{ name: 'undescribed' }] });

    const tools = await toolbox.getTools();

    expect(tools[0]).toMatchObject({ name: 'undescribed', description: '' });
    await toolbox.close();
  });

  it('calls through to the server when a tool runs', async () => {
    const { toolbox, calls } = stubToolbox();

    const [tool] = await toolbox.getTools();
    const result = await tool?.execute?.({ q: 'hello' }, { callId: 'c1' });

    expect(calls.map((c) => c.method)).toContain('tools/call');
    expect(result).toEqual([{ type: 'text', text: 'stub result' }]);
    await toolbox.close();
  });

  it('raises when the server reports the call itself failed', async () => {
    // MCP signals a tool failure in the payload rather than by rejecting. Passing it back as a
    // result would tell the model the call succeeded and hand it the error text as the answer.
    const { toolbox } = stubToolbox({ toolFails: true });

    const [tool] = await toolbox.getTools();
    await expect(tool?.execute?.({ q: 'hello' }, { callId: 'c1' })).rejects.toThrow(
      /the upstream API rejected it/,
    );
    await toolbox.close();
  });

  describe('failure text of an isError result', () => {
    // The rule is the one `McpClient` applies, shared rather than re-implemented: each text block
    // on its own line, blocks without text contributing nothing, structured content as the last
    // line, and a fallback naming the tool when the result said nothing. The reference
    // implementation has no second assembly to drift — its toolbox inherits the plain MCP tool's.

    async function failWith(toolResult: Record<string, unknown>): Promise<unknown> {
      const { toolbox } = stubToolbox({ toolResult });
      const [tool] = await toolbox.getTools();
      try {
        await tool?.execute?.({ q: 'x' }, { callId: 'c1' });
        return undefined;
      } catch (error) {
        return error;
      } finally {
        await toolbox.close();
      }
    }

    it('puts each text block on its own line', async () => {
      const error = await failWith({
        isError: true,
        content: [
          { type: 'text', text: 'the upstream API rejected it' },
          { type: 'text', text: 'retry after 30s' },
        ],
      });

      expect(error).toBeInstanceOf(ToolInvocationError);
      expect((error as Error).message).toBe('the upstream API rejected it\nretry after 30s');
    });

    it('skips blocks with no text instead of contributing blank lines', async () => {
      const error = await failWith({
        isError: true,
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: '' },
          { type: 'image', data: 'AA==', mimeType: 'image/png' },
          { type: 'text', text: 'second' },
        ],
      });

      expect((error as Error).message).toBe('first\nsecond');
    });

    it('reports structured content as the last line', async () => {
      const error = await failWith({
        isError: true,
        content: [{ type: 'text', text: 'rate limited' }],
        structuredContent: { retryAfter: 30 },
      });

      expect((error as Error).message).toBe('rate limited\n{"retryAfter":30}');
    });

    it('names the tool when the failure carries no text at all', async () => {
      const error = await failWith({
        isError: true,
        content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }],
      });

      expect((error as Error).message).toBe('MCP tool "search_docs" reported an error.');
    });
  });

  describe('declaration normalization', () => {
    // The same rules `McpClient` applies, shared rather than re-implemented: a provider only
    // accepts `[A-Za-z0-9_.-]` in a function name and refuses an object schema without
    // `properties`, so an unnormalized declaration makes the tool unreachable with a 400.

    it('normalizes a bare zero-argument schema so providers accept the declaration', async () => {
      const { toolbox } = stubToolbox({
        tools: [{ name: 'ping', inputSchema: { type: 'object' } }],
      });

      const [tool] = await toolbox.getTools();

      expect(tool?.jsonSchema).toEqual({ type: 'object', properties: {} });
      await toolbox.close();
    });

    it('exposes a normalized name while calling the server with the remote one', async () => {
      const { toolbox, calls } = stubToolbox({
        tools: [{ name: 'search docs!', description: 'Search the docs' }],
      });

      const [tool] = await toolbox.getTools();
      expect(tool?.name).toBe('search-docs-');

      await tool?.execute?.({ q: 'hello' }, { callId: 'c1' });
      expect(calls.find((c) => c.method === 'tools/call')?.toolName).toBe('search docs!');
      await toolbox.close();
    });

    it('namespaces the exposed names under the configured prefix', async () => {
      const { toolbox, calls } = stubToolbox({
        tools: [{ name: 'search docs!' }],
        toolNamePrefix: 'github',
      });

      const [tool] = await toolbox.getTools();
      expect(tool?.name).toBe('github_search-docs-');

      await tool?.execute?.({ q: 'hello' }, { callId: 'c1' });
      expect(calls.find((c) => c.method === 'tools/call')?.toolName).toBe('search docs!');
      await toolbox.close();
    });

    it('refuses two remote names that collide on one exposed name', async () => {
      // The MCP client's claim rule, shared: silently keeping one would make the other
      // unreachable, and which survived would depend on the server's listing order.
      const { toolbox } = stubToolbox({ tools: [{ name: 'a b' }, { name: 'a-b' }] });

      await expect(toolbox.getTools()).rejects.toThrow(/exposed name is the same "a-b"/);
      await toolbox.close();
    });

    it('keeps the first entry when the same tool is listed twice', async () => {
      const { toolbox } = stubToolbox({
        tools: [{ name: 'search_docs' }, { name: 'search_docs' }],
      });

      const tools = await toolbox.getTools();

      expect(tools.map((t) => t.name)).toEqual(['search_docs']);
      await toolbox.close();
    });

    it('filters allowedTools by the remote name, prefix or not', async () => {
      const { toolbox } = stubToolbox({
        tools: [{ name: 'search docs!' }, { name: 'other' }],
        allowedTools: ['search docs!'],
        toolNamePrefix: 'github',
      });

      const tools = await toolbox.getTools();

      expect(tools.map((t) => t.name)).toEqual(['github_search-docs-']);
      await toolbox.close();
    });

    it('still raises the typed consent refusal for a tool exposed under a normalized name', async () => {
      // Consent correlation rides on the call id, not the tool name, so renaming must not turn
      // the gateway's refusal into an ordinary tool failure — and the request that triggered it
      // must still name the remote tool.
      const { toolbox, calls } = stubToolbox({
        tools: [{ name: 'search docs!' }],
        consentOn: 'tools/call',
      });

      const [tool] = await toolbox.getTools();
      const failure = tool?.execute?.({ q: 'x' }, { callId: 'c1' });

      await expect(failure).rejects.toBeInstanceOf(ToolboxConsentRequiredError);
      await expect(failure).rejects.toMatchObject({
        consents: [{ serverLabel: 'github', consentLink: 'https://consent.example.com/auth' }],
      });
      expect(calls.find((c) => c.method === 'tools/call')?.toolName).toBe('search docs!');
      await toolbox.close();
    });
  });

  it('reconnects and retries once when the server has expired the session', async () => {
    // The MCP session is long-lived; Foundry answers 404 once it has expired it. The tool was
    // obtained on the first connection, so this also proves tools resolve the live connection
    // rather than the instance they were built on.
    const { toolbox, calls } = stubToolbox({ dieOnToolCalls: [1] });

    const [tool] = await toolbox.getTools();
    const result = await tool?.execute?.({ q: 'hello' }, { callId: 'c1' });

    expect(result).toEqual([{ type: 'text', text: 'stub result' }]);
    expect(calls.filter((c) => c.method === 'initialize')).toHaveLength(2);
    await toolbox.close();
  });

  it('retries at most once when the reconnected session dies too', async () => {
    const { toolbox } = stubToolbox({ dieOnToolCalls: [1, 2] });

    const [tool] = await toolbox.getTools();
    await expect(tool?.execute?.({ q: 'hello' }, { callId: 'c1' })).rejects.toThrow(/Session terminated/);

    // The instance recovers: the next call reconnects once more and succeeds.
    const result = await tool?.execute?.({ q: 'again' }, { callId: 'c2' });
    expect(result).toEqual([{ type: 'text', text: 'stub result' }]);
    await toolbox.close();
  });

  it('does not let a connect that raced close() resurrect the connection', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { toolbox } = stubToolbox({ holdFirstRequest: gate });

    const pending = toolbox.getTools();
    await toolbox.close();
    release();

    await expect(pending).rejects.toThrow(/closed while connecting/);
    expect(toolbox.connected).toBe(false);

    // The instance is still usable: a later request opens a fresh connection.
    const tools = await toolbox.getTools();
    expect(tools.map((tool) => tool.name)).toEqual(['search_docs']);
    await toolbox.close();
  });

  it('restricts the exposed tools to the allowed set', async () => {
    const listed = [
      { name: 'search_docs', description: 'Search' },
      { name: 'delete_everything', description: 'Delete' },
    ];

    const unfiltered = stubToolbox({ tools: listed });
    expect((await unfiltered.toolbox.getTools()).map((t) => t.name)).toEqual([
      'search_docs',
      'delete_everything',
    ]);
    await unfiltered.toolbox.close();

    // The server still advertises both; the model is only shown the one that was allowed.
    const filtered = stubToolbox({ tools: listed, allowedTools: ['search_docs'] });
    expect((await filtered.toolbox.getTools()).map((t) => t.name)).toEqual(['search_docs']);
    await filtered.toolbox.close();
  });
});

describe('FoundryToolbox OAuth consent', () => {
  it('retypes a -32006 answer to a tool call as ToolboxConsentRequiredError with the link', async () => {
    const { toolbox, calls } = stubToolbox({ consentOn: 'tools/call' });

    const [tool] = await toolbox.getTools();
    const failure = tool?.execute?.({ q: 'x' }, { callId: 'c1' });

    await expect(failure).rejects.toBeInstanceOf(ToolboxConsentRequiredError);
    await expect(failure).rejects.toMatchObject({
      consents: [{ serverLabel: 'github', consentLink: 'https://consent.example.com/auth' }],
    });
    // A JSON-RPC error *answer* is a definitive response: the reconnect-and-retry must not
    // replay it (one initialize means no reconnect happened).
    expect(calls.filter((call) => call.method === 'initialize')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'tools/call')).toHaveLength(1);
    await toolbox.close();
  });

  it('retypes a -32006 answer to tools/list the same way', async () => {
    // Python hits consent here (the gateway refuses `tools/list` on lazy agent entry).
    const { toolbox } = stubToolbox({ consentOn: 'tools/list' });

    const failure = toolbox.getTools();
    await expect(failure).rejects.toBeInstanceOf(ToolboxConsentRequiredError);
    await expect(failure).rejects.toMatchObject({
      consents: [{ serverLabel: 'github', consentLink: 'https://consent.example.com/auth' }],
    });
    await toolbox.close();
  });
});

describe('FoundryToolbox skills', () => {
  const INDEX = 'skill://index.json';
  const catalogue = JSON.stringify({
    skills: [
      {
        name: 'escalation-policy',
        type: 'skill-md',
        description: 'When to escalate a ticket.',
        url: 'skill://escalation-policy/SKILL.md',
      },
    ],
  });
  const body = [
    '---',
    'name: escalation-policy',
    'description: When to escalate a ticket.',
    '---',
    'Escalate after two failed attempts.',
  ].join('\n');

  /** Runs the provider's `beforeRun` and returns what it contributed. */
  async function contribute(provider: ContextProvider): Promise<{ instructions: string[]; tools: Tool[] }> {
    const instructions: string[] = [];
    const tools: Tool[] = [];
    await provider.beforeRun?.({
      agent: { id: 'agent-1' },
      session: new AgentSession(),
      state: {},
      inputMessages: [],
      extendMessages: () => {},
      extendInstructions: (text) => instructions.push(text),
      extendTools: (added) => tools.push(...added),
    });
    return { instructions, tools };
  }

  it('discovers the toolbox skills over the same authenticated connection as its tools', async () => {
    const { toolbox, calls } = stubToolbox({
      resources: { [INDEX]: catalogue, 'skill://escalation-policy/SKILL.md': body },
    });

    const contributed = await asPlatformRequest({ [HEADERS.foundryCallId]: 'call-1' }, () =>
      contribute(toolbox.asSkillsProvider()),
    );

    expect(contributed.instructions.join('\n')).toContain('escalation-policy');
    expect(contributed.tools.map((entry) => entry.name)).toContain('load_skill');
    // Nothing new is authenticated: the discovery request carries the same per-call token and
    // call id every `tools/call` does.
    const read = calls.find((call) => call.method === 'resources/read');
    assert.exists(read);
    expect(read.headers.authorization).toMatch(/^Bearer token-/);
    expect(read.headers[HEADERS.foundryCallId]).toBe('call-1');
    await toolbox.close();
  });

  it('loads a skill body through the load_skill tool', async () => {
    const { toolbox } = stubToolbox({
      resources: { [INDEX]: catalogue, 'skill://escalation-policy/SKILL.md': body },
    });

    const contributed = await contribute(
      toolbox.asSkillsProvider({ approvals: { loadSkill: 'never_require' } }),
    );
    const loadSkill = contributed.tools.filter(isFunctionTool).find((t) => t.name === 'load_skill');
    assert.exists(loadSkill);
    const content = await (loadSkill.execute as (i: unknown, c: { callId: string }) => Promise<string>)(
      { skill_name: 'escalation-policy' },
      { callId: 'c1' },
    );

    expect(content).toContain('Escalate after two failed attempts.');
    expect(loadSkill.approvalMode).toBe('never_require');
    await toolbox.close();
  });

  it('hides the toolbox tools when loadTools is off, without asking the gateway to list them', async () => {
    const { toolbox, calls } = stubToolbox({
      loadTools: false,
      resources: { [INDEX]: catalogue, 'skill://escalation-policy/SKILL.md': body },
    });

    expect(await toolbox.getTools()).toEqual([]);
    await contribute(toolbox.asSkillsProvider());

    expect(calls.filter((call) => call.method === 'tools/list')).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'resources/read')).toHaveLength(1);
    await toolbox.close();
  });

  it('retypes a -32006 answer to resources/read as ToolboxConsentRequiredError', async () => {
    // The skills path goes through the same gateway as the tools, so a consent refusal reaches it
    // the same way and must arrive typed rather than as a bare JSON-RPC error.
    const { toolbox } = stubToolbox({ consentOn: 'resources/read', resources: { [INDEX]: catalogue } });

    const failure = contribute(toolbox.asSkillsProvider());

    await expect(failure).rejects.toBeInstanceOf(ToolboxConsentRequiredError);
    await expect(failure).rejects.toMatchObject({
      consents: [{ serverLabel: 'github', consentLink: 'https://consent.example.com/auth' }],
    });
    await toolbox.close();
  });

  it('contributes nothing when the toolbox publishes no skills', async () => {
    const { toolbox } = stubToolbox({ resources: {} });

    const contributed = await contribute(toolbox.asSkillsProvider());

    expect(contributed.instructions).toEqual([]);
    expect(contributed.tools).toEqual([]);
    await toolbox.close();
  });
});

describe('FoundryToolbox cancellation', () => {
  /** Replaces `callTool` so the request options each call receives can be asserted directly. */
  function spyCallTool(reply: (call: number) => Promise<CallToolResult>): {
    seen: Array<CallToolRequestOptions | undefined>;
    restore: () => void;
  } {
    const seen: Array<CallToolRequestOptions | undefined> = [];
    const spy = vi
      .spyOn(Client.prototype, 'callTool')
      .mockImplementation(async (_params, options): Promise<CallToolResult> => {
        seen.push(options);
        return reply(seen.length);
      });
    return { seen, restore: (): void => spy.mockRestore() };
  }

  it('forwards the tool context signal to the MCP request options', async () => {
    // The toolbox is remote code reached over MCP: until the request is cancelled on the wire, a
    // tool keeps running and keeps causing side effects after the caller has given up (a client
    // disconnect, or SIGTERM draining the container).
    const { seen, restore } = spyCallTool(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    try {
      const { toolbox } = stubToolbox();
      const [tool] = await toolbox.getTools();
      const controller = new AbortController();

      await tool?.execute?.({ q: 'hello' }, { callId: 'c1', signal: controller.signal });

      expect(seen).toHaveLength(1);
      expect(seen[0]?.signal).toBe(controller.signal);
      await toolbox.close();
    } finally {
      restore();
    }
  });

  it('uses the same signal on the reconnect retry', async () => {
    const { seen, restore } = spyCallTool(async (call) => {
      if (call === 1) {
        // What a Foundry toolbox answers once it has expired the MCP session.
        throw new SdkHttpError(SdkErrorCode.ConnectionClosed, 'Session terminated', { status: 404 });
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    try {
      const { toolbox } = stubToolbox();
      const [tool] = await toolbox.getTools();
      const controller = new AbortController();

      await tool?.execute?.({ q: 'hello' }, { callId: 'c1', signal: controller.signal });

      expect(seen).toHaveLength(2);
      expect(seen[0]?.signal).toBe(controller.signal);
      expect(seen[1]?.signal).toBe(controller.signal);
      await toolbox.close();
    } finally {
      restore();
    }
  });

  it('still carries the signal on the call that hits the consent refusal', async () => {
    // The out-of-band consent channel sits on the same `callTool`; the refusal path must
    // not be the one branch that reaches the gateway with no way to cancel it.
    const { toolbox, calls } = stubToolbox({ consentOn: 'tools/call' });
    const [tool] = await toolbox.getTools();
    const controller = new AbortController();
    controller.abort();

    await expect(tool?.execute?.({ q: 'x' }, { callId: 'c1', signal: controller.signal })).rejects.toThrow();
    // An aborted signal is checked before the request is written, so nothing reaches the gateway.
    expect(calls.filter((call) => call.method === 'tools/call')).toHaveLength(0);
    await toolbox.close();
  });

  it('never puts an already-aborted call on the wire', async () => {
    const { toolbox, calls } = stubToolbox();
    const [tool] = await toolbox.getTools();
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool?.execute?.({ q: 'hello' }, { callId: 'c1', signal: controller.signal }),
    ).rejects.toThrow();
    expect(calls.filter((call) => call.method === 'tools/call')).toHaveLength(0);
    await toolbox.close();
  });

  it('rejects a call that is aborted while it is in flight', async () => {
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { toolbox } = stubToolbox({
      holdToolCalls: new Promise<void>(() => {}),
      onToolCall: () => reached(),
    });
    const [tool] = await toolbox.getTools();
    const controller = new AbortController();

    const pending = tool?.execute?.({ q: 'hello' }, { callId: 'c1', signal: controller.signal });
    await arrived;
    controller.abort();

    await expect(pending).rejects.toThrow();
    await toolbox.close();
  });
});

describe('FoundryToolbox authorization', () => {
  it('sends the Entra bearer token on every MCP request', async () => {
    const { toolbox, calls } = stubToolbox();

    await toolbox.getTools();

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.headers.authorization).toMatch(/^Bearer token-/);
    }
    await toolbox.close();
  });

  it('forwards the call id of the request in flight, not one captured at connect time', async () => {
    const { toolbox, calls } = stubToolbox();

    // Connect under one request…
    await asPlatformRequest({ [HEADERS.foundryCallId]: 'call-1' }, () => toolbox.getTools());
    const afterConnect = calls.length;

    // …then invoke a tool under a different one. The MCP session is long-lived and serves every
    // user this container sees, so a call id baked in at connect time would mis-attribute this.
    const [tool] = await toolbox.getTools();
    await asPlatformRequest({ [HEADERS.foundryCallId]: 'call-2' }, () =>
      Promise.resolve(tool?.execute?.({ q: 'x' }, { callId: 'c1' })),
    );

    expect(calls[0]?.headers[HEADERS.foundryCallId]).toBe('call-1');
    expect(calls.at(-1)?.headers[HEADERS.foundryCallId]).toBe('call-2');
    expect(afterConnect).toBeGreaterThan(0);
    await toolbox.close();
  });

  it('never forwards the end user id to the toolbox', async () => {
    const { toolbox, calls } = stubToolbox();

    await asPlatformRequest({ [HEADERS.foundryCallId]: 'call-1', [HEADERS.userId]: 'alice' }, () =>
      toolbox.getTools(),
    );

    for (const call of calls) {
      expect(call.headers[HEADERS.userId]).toBeUndefined();
    }
    expect(JSON.stringify(calls)).not.toContain('alice');
    await toolbox.close();
  });

  it('works outside a request context, with only the token to send', async () => {
    const { toolbox, calls } = stubToolbox();

    await toolbox.getTools();

    expect(calls[0]?.headers.authorization).toMatch(/^Bearer /);
    expect(calls[0]?.headers[HEADERS.foundryCallId]).toBeUndefined();
    await toolbox.close();
  });
});
