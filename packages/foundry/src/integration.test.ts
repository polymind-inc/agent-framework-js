/**
 * Integration tests against a real Microsoft Foundry project.
 *
 * Skipped unless `RUN_INTEGRATION_TESTS=1` and `FOUNDRY_PROJECT_ENDPOINT` are set, so ordinary
 * test runs stay offline. Authentication uses `DefaultAzureCredential`, so `az login` (or a
 * managed identity) is enough.
 *
 * - `FOUNDRY_PROJECT_ENDPOINT` — e.g. `https://<resource>.services.ai.azure.com/api/projects/<p>`
 * - `AZURE_AI_MODEL_DEPLOYMENT_NAME` — model deployment name (default `gpt-4o-mini`). This is the
 *   name `agent.yaml` and `azd` use, so one variable configures the examples and these tests.
 * - `FOUNDRY_SERVER_AGENT` — optional; when set, the server-agent target is exercised too
 * - `FOUNDRY_TOOLBOX_NAME` — optional; when set, the hosted MCP toolbox is exercised too
 * - `FOUNDRY_STORAGE_WRITABLE=1` — optional; opts into the storage write tests, which only pass
 *   from inside a deployed container (see the block at the bottom)
 */
import { DefaultAzureCredential } from '@azure/identity';
import type { ResponseObject } from '@polymind-inc/agent-framework-agentserver';
import { ID_PREFIX, newId, newResponseId } from '@polymind-inc/agent-framework-agentserver';
import { Agent, tool } from '@polymind-inc/agent-framework-core';
import { must } from '@polymind-inc/agent-framework-core/internal';
import { describe, expect, it } from 'vitest';
import { FoundryChatClient } from './chat-client.js';
import { FoundryResponseStore } from './hosting/response-store.js';
import { FoundryToolbox } from './hosting/toolbox.js';
import { FoundryProject } from './project.js';

const projectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
const modelDeployment =
  process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME ?? process.env.FOUNDRY_MODEL_DEPLOYMENT ?? 'gpt-4o-mini';
const serverAgent = process.env.FOUNDRY_SERVER_AGENT;
const toolboxName = process.env.FOUNDRY_TOOLBOX_NAME;
const runIntegration = process.env.RUN_INTEGRATION_TESTS === '1';
const TIMEOUT = 60_000;

const project = (): FoundryProject => new FoundryProject(must(projectEndpoint), new DefaultAzureCredential());

const deploymentClient = (): FoundryChatClient =>
  new FoundryChatClient({ project: project(), target: { model: modelDeployment } });

describe.runIf(runIntegration && projectEndpoint !== undefined && projectEndpoint !== '')(
  'Foundry (integration)',
  () => {
    it('answers a basic prompt', { timeout: TIMEOUT }, async () => {
      const response = await new Agent({ client: deploymentClient() }).run(
        'Reply with the single word: pong',
      );

      expect(response.text.toLowerCase()).toContain('pong');
      expect(response.usageDetails?.inputTokenCount).toBeGreaterThan(0);
    });

    it('runs the tool loop end to end', { timeout: TIMEOUT }, async () => {
      let executed = 0;
      const getWeather = tool({
        name: 'get_weather',
        description: 'Get the current weather for a location',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
          additionalProperties: false,
        },
        execute: async () => {
          executed++;
          return 'Sunny, 25C';
        },
      });

      const agent = new Agent({ client: deploymentClient(), tools: [getWeather] });
      const response = await agent.run("What's the weather in Tokyo? Use the tool.");

      expect(executed).toBe(1);
      expect(response.text).not.toBe('');
    });

    it.runIf(serverAgent !== undefined && serverAgent !== '')(
      'talks to an existing server agent',
      { timeout: TIMEOUT },
      async () => {
        const client = new FoundryChatClient({
          project: project(),
          target: { serverAgent: must(serverAgent) },
        });

        const response = await new Agent({ client }).run('Hello');
        expect(response.text).not.toBe('');
      },
    );
  },
);

/**
 * Foundry Toolbox (hosted MCP tools).
 *
 * Skipped unless `FOUNDRY_TOOLBOX_NAME` names a toolbox registered in the project. `az login` (or
 * a managed identity) supplies the credential.
 */
describe.runIf(
  runIntegration &&
    projectEndpoint !== undefined &&
    projectEndpoint !== '' &&
    toolboxName !== undefined &&
    toolboxName !== '',
)('Foundry Toolbox (integration)', () => {
  const toolbox = (): FoundryToolbox => new FoundryToolbox({ name: must(toolboxName), project: project() });

  it('lists the toolbox tools over MCP', { timeout: TIMEOUT }, async () => {
    const box = toolbox();
    try {
      const tools = await box.getTools();

      // A registered toolbox exposes at least one tool; the framework sees them as function tools.
      expect(tools.length).toBeGreaterThan(0);
      for (const declared of tools) {
        expect(declared.kind).toBe('function');
        expect(declared.name).not.toBe('');
        expect(declared.jsonSchema).toBeDefined();
      }
      console.log('[toolbox] tools:', tools.map((t) => t.name).join(', '));
    } finally {
      await box.close();
    }
  });

  it('lets an agent call a toolbox tool', { timeout: TIMEOUT }, async () => {
    const box = toolbox();
    try {
      const tools = await box.getTools();
      const agent = new Agent({
        client: deploymentClient(),
        instructions:
          'You have tools from a Foundry toolbox. Use one when it can answer the question, then ' +
          'summarize what it returned in one short sentence.',
        tools,
      });

      const response = await agent.run(
        `Use one of your tools to answer something, then say what it returned. ` +
          `Available tools: ${tools.map((t) => t.name).join(', ')}.`,
      );

      expect(response.text).not.toBe('');
      console.log('[toolbox] answer:', response.text);
    } finally {
      await box.close();
    }
  });
});

/**
 * Foundry storage — the read path.
 *
 * The storage API is live on the project endpoint with nothing to enable: an Entra token for
 * `https://ai.azure.com/.default` is enough to reach it.
 */
describe.runIf(runIntegration && projectEndpoint !== undefined && projectEndpoint !== '')(
  'Foundry storage (integration)',
  () => {
    const store = (): FoundryResponseStore => new FoundryResponseStore({ project: project() });

    it('reaches the service and reports an unknown response as absent', { timeout: TIMEOUT }, async () => {
      const subject = store();
      const missing = newResponseId();

      // A reachable-but-empty result, not a transport error: the route exists, the token was
      // accepted and the id parsed.
      expect(await subject.get(missing, undefined)).toBeUndefined();
      expect(await subject.history(missing, undefined)).toBeUndefined();
      expect(await subject.delete(missing, undefined)).toBe(false);
    });
  },
);

/**
 * Foundry storage — the write path.
 *
 * Opt-in with `FOUNDRY_STORAGE_WRITABLE=1`, because `POST /storage/responses` answers an opaque
 * `500` from a developer workstation. Every combination tried failed the same way — with and
 * without `model`, and with and without fabricated `x-agent-foundry-call-id` / `x-agent-user-id`
 * headers — while reads on the same endpoint behave correctly. The likeliest reading is that a
 * write resolves platform-side caller context that only exists when the request is routed by
 * Foundry, i.e. from inside a deployed container; the error is opaque, so that stays a hypothesis.
 */
describe.runIf(
  runIntegration &&
    projectEndpoint !== undefined &&
    projectEndpoint !== '' &&
    process.env.FOUNDRY_STORAGE_WRITABLE === '1',
)('Foundry storage writes (integration)', () => {
  const store = (): FoundryResponseStore => new FoundryResponseStore({ project: project() });

  function draft(id: string): ResponseObject {
    return {
      id,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      output: [
        {
          type: 'message',
          id: newId(ID_PREFIX.message, id),
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'stored answer', annotations: [] }],
        },
      ],
    };
  }

  it('round-trips a response through the service', { timeout: TIMEOUT }, async () => {
    const subject = store();
    const id = newResponseId();
    const inputItems = [
      {
        type: 'message',
        id: newId(ID_PREFIX.message, id),
        role: 'user',
        content: [{ type: 'input_text', text: 'stored question' }],
      },
    ];

    try {
      await subject.put({ response: draft(id), inputItems });

      const read = await subject.get(id, undefined);
      expect(read?.response.id).toBe(id);
      expect(JSON.stringify(read?.response.output)).toContain('stored answer');
      expect(JSON.stringify(read?.inputItems)).toContain('stored question');

      // The transcript a follow-up turn replays: what was asked, then what was answered.
      const history = await subject.history(id, undefined);
      expect(JSON.stringify(history)).toContain('stored question');
      expect(JSON.stringify(history)).toContain('stored answer');
    } finally {
      await subject.delete(id, undefined);
    }
  });

  it('updates an existing response rather than failing on the conflict', { timeout: TIMEOUT }, async () => {
    const subject = store();
    const id = newResponseId();

    try {
      await subject.put({ response: draft(id) });
      // The same id again: create returns 409 and `put` falls through to the update route.
      await subject.put({ response: { ...draft(id), status: 'incomplete' } });

      expect((await subject.get(id, undefined))?.response.status).toBe('incomplete');
    } finally {
      await subject.delete(id, undefined);
    }
  });
});
