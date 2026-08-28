/**
 * Extensibility integration tests against a real Microsoft Foundry project: middleware, context
 * providers, provider parity, and observability.
 *
 * The unit tests pin the semantics against a mock; these prove the same code paths survive a real
 * provider. The pieces most worth checking live are the ones that touch the wire — the
 * served-model header, rich tool output, the approval round trip — and the ones whose behaviour
 * only shows up against a real stream.
 *
 * Skipped unless `FOUNDRY_PROJECT_ENDPOINT` is set, so `pnpm -r test` stays offline by default.
 * See `integration.test.ts` for the environment variables.
 */

import { DefaultAzureCredential } from '@azure/identity';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import type { ContextProvider, FunctionApprovalRequestContent } from '@polymind-inc/agent-framework-core';
import {
  Agent,
  agentMiddleware,
  agentResponse,
  agentResponseUpdate,
  approvalResponse,
  functionMiddleware,
  textContent,
  tool,
  toolApprovalMiddleware,
} from '@polymind-inc/agent-framework-core';
import { must } from '@polymind-inc/agent-framework-core/internal';
import { describe, expect, it } from 'vitest';
import { FoundryChatClient } from './chat-client.js';
import { FoundryProject } from './project.js';

const projectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
const modelDeployment =
  process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME ?? process.env.FOUNDRY_MODEL_DEPLOYMENT ?? 'gpt-4o-mini';
const TIMEOUT = 120_000;

const deploymentClient = (): FoundryChatClient =>
  new FoundryChatClient({
    project: new FoundryProject(must(projectEndpoint), new DefaultAzureCredential()),
    target: { model: modelDeployment },
  });

/** A weather tool, the smallest thing that makes a real model call a function. */
const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a location',
  parameters: {
    type: 'object',
    properties: { location: { type: 'string' } },
    required: ['location'],
    additionalProperties: false,
  },
  execute: async () => 'Sunny, 25C',
});

describe.runIf(projectEndpoint !== undefined && projectEndpoint !== '')('middleware (integration)', () => {
  it('wraps a real run and a real tool invocation', { timeout: TIMEOUT }, async () => {
    const order: string[] = [];
    const outer = agentMiddleware(async (ctx, next) => {
      order.push(`agent:before:${ctx.stream ? 'stream' : 'await'}`);
      await next();
      order.push(`agent:after:${ctx.response === undefined ? 'none' : 'response'}`);
    });
    const timing = functionMiddleware(async (ctx, next) => {
      order.push(`function:before:${ctx.tool.name}`);
      await next();
      order.push(`function:after:${String(ctx.result)}`);
    });

    const agent = new Agent({
      client: deploymentClient(),
      tools: [getWeather],
      middleware: [outer, timing],
    });
    const response = await agent.run("What's the weather in Tokyo? Use the tool.");

    expect(order).toEqual([
      'agent:before:await',
      'function:before:get_weather',
      'function:after:Sunny, 25C',
      'agent:after:response',
    ]);
    expect(response.text).not.toBe('');
  });

  it('short-circuits without reaching the service', { timeout: TIMEOUT }, async () => {
    let reachedInner = false;
    const canned = agentMiddleware(async (ctx) => {
      ctx.response = agentResponse({
        messages: [{ role: 'assistant', contents: [textContent('from cache')] }],
      });
    });
    const inner = agentMiddleware(async (_ctx, next) => {
      reachedInner = true;
      await next();
    });

    const agent = new Agent({ client: deploymentClient(), middleware: [canned, inner] });
    const response = await agent.run('This must never reach the service.');

    expect(response.text).toBe('from cache');
    expect(reachedInner).toBe(false);
  });

  it('transforms a real stream through ctx.onUpdate', { timeout: TIMEOUT }, async () => {
    const shout = agentMiddleware(async (ctx, next) => {
      expect(ctx.stream).toBe(true);
      ctx.onUpdate((update) =>
        agentResponseUpdate({ ...update, contents: [textContent(update.text.toUpperCase())] }),
      );
      await next();
    });

    const agent = new Agent({ client: deploymentClient(), middleware: [shout] });
    const stream = agent.run('Reply with exactly: pong pong pong');
    let seen = '';
    for await (const update of stream) {
      seen += update.text;
    }
    const folded = await stream.finalResponse();

    // What the caller reads is transformed; what the framework folded — and would persist — is not.
    expect(seen).toBe(seen.toUpperCase());
    expect(seen.toLowerCase()).toContain('pong');
    expect(folded.text.toLowerCase()).toContain('pong');
    expect(folded.text).not.toBe(folded.text.toUpperCase());
  });

  it('sends a call to a human, then executes it once approved', { timeout: TIMEOUT }, async () => {
    let executed = 0;
    const transfer = tool({
      name: 'transfer_funds',
      description: 'Transfer money between accounts',
      parameters: {
        type: 'object',
        properties: { amount: { type: 'number' } },
        required: ['amount'],
        additionalProperties: false,
      },
      execute: async () => {
        executed++;
        return 'transfer complete';
      },
    });

    const agent = new Agent({
      client: deploymentClient(),
      tools: [transfer],
      middleware: [toolApprovalMiddleware([{ tools: 'transfer_funds', reason: 'Irreversible' }])],
    });
    const session = agent.createSession();

    const pending = await agent.run('Transfer 500 using the tool.', { session });

    expect(pending.userInputRequests).toHaveLength(1);
    expect(executed).toBe(0);
    const request = pending.userInputRequests[0] as FunctionApprovalRequestContent;
    expect(request.type).toBe('function_approval_request');
    expect(request.additionalProperties?.requiredByMiddleware).toBe(true);

    const resumed = await agent.run(approvalResponse(request, true, { reason: 'approved' }), { session });

    // Executed exactly once, and the resumed turn is not asked to approve again.
    expect(executed).toBe(1);
    expect(resumed.userInputRequests).toHaveLength(0);
  });
});

describe.runIf(projectEndpoint !== undefined && projectEndpoint !== '')(
  'context providers (integration)',
  () => {
    it('carries a custom provider across two real turns', { timeout: TIMEOUT }, async () => {
      const provider: ContextProvider = {
        sourceId: 'memory',
        beforeRun(ctx) {
          const facts = (ctx.state.facts as string[] | undefined) ?? [];
          if (facts.length > 0) {
            ctx.extendMessages([
              { role: 'user', contents: [textContent(`Known about the user: ${facts.join('; ')}`)] },
            ]);
          }
          ctx.extendInstructions('Answer from what you already know; never ask the user twice.');
        },
        afterRun(ctx) {
          if (ctx.error !== undefined) {
            return;
          }
          const facts = (ctx.state.facts as string[] | undefined) ?? [];
          ctx.state.facts = [...facts, 'The user is called Rin.'];
        },
      };

      const agent = new Agent({ client: deploymentClient(), contextProviders: [provider] });
      const session = agent.createSession();

      await agent.run('My name is Rin.', { session });
      const second = await agent.run('What is my name? Answer with just the name.', { session });

      expect(second.text).toContain('Rin');
      // The provider's state lives in its own partition, and the session is still plain JSON.
      expect((session.state.memory as { facts: string[] }).facts).toHaveLength(2);
      expect(() => JSON.stringify(session.toJSON())).not.toThrow();
    });
  },
);

describe.runIf(projectEndpoint !== undefined && projectEndpoint !== '')(
  'provider parity (integration)',
  () => {
    it('reports the served model snapshot, not the deployment alias', { timeout: TIMEOUT }, async () => {
      // Read at the chat layer: the served model is a property of one model call, so it lives on
      // `ChatResponse`, not on the agent-level result.
      const client = deploymentClient();
      const awaited = await client.getResponse([{ role: 'user', contents: [textContent('Reply with: ok')] }]);

      const streamed = client.getResponse([{ role: 'user', contents: [textContent('Reply with: ok')] }]);
      for await (const _update of streamed) {
        // drain, so the streaming transport is the one exercised
      }
      const folded = await streamed.finalResponse();

      console.log(
        `[served-model] deployment=${modelDeployment} awaited=${String(awaited.model)} streamed=${String(folded.model)}`,
      );
      // Azure returns the deployment alias in the body and the snapshot that actually ran in
      // `x-ms-served-model`; the header wins, on both paths.
      expect(awaited.model).toBeDefined();
      expect(awaited.model).not.toBe(modelDeployment);
      expect(awaited.model).toContain(modelDeployment);
      expect(folded.model).toBe(awaited.model);
    });

    it('sends rich tool output as image parts', { timeout: TIMEOUT }, async () => {
      // A 1×1 PNG: enough to prove the service accepts an image part inside a tool result.
      const pixel =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const screenshot = tool({
        name: 'take_screenshot',
        description: 'Take a screenshot of the current screen',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: (async () => [
          { type: 'text', text: 'here is the screenshot' },
          { type: 'data', uri: `data:image/png;base64,${pixel}`, mediaType: 'image/png' },
        ]) as never,
      });

      const agent = new Agent({ client: deploymentClient(), tools: [screenshot] });
      const response = await agent.run('Call take_screenshot, then say what the tool returned.');

      const result = response.messages
        .flatMap((message) => message.contents)
        .find((content) => content.type === 'function_result') as { items?: unknown[] } | undefined;
      // Both shapes are carried; the openai layer turns `items` into `input_image` parts on the
      // wire, and the service accepted the turn.
      expect(result?.items).toHaveLength(2);
      expect(response.text).not.toBe('');
    });
  },
);

describe.runIf(projectEndpoint !== undefined && projectEndpoint !== '')('observability (integration)', () => {
  it('records GenAI metrics for a real call', { timeout: TIMEOUT }, async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 600_000 });
    const meterProvider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(meterProvider);
    try {
      await new Agent({ client: deploymentClient() }).run('Reply with the single word: pong');
      await reader.forceFlush();

      const batches = exporter.getMetrics();
      const scope = batches[batches.length - 1]?.scopeMetrics.find(
        (entry) => entry.scope.name === '@polymind-inc/agent-framework-core',
      );
      const tokens = scope?.metrics.find((m) => m.descriptor.name === 'gen_ai.client.token.usage');
      const duration = scope?.metrics.find((m) => m.descriptor.name === 'gen_ai.client.operation.duration');

      const points = (tokens?.dataPoints ?? []) as Array<{
        attributes: Record<string, unknown>;
        value: { sum: number };
      }>;
      const byType = Object.fromEntries(
        points.map((point) => [point.attributes['gen_ai.token.type'], point.value.sum]),
      );
      console.log(`[metrics] tokens=${JSON.stringify(byType)}`);

      // Real token counts, split by the convention's dimension.
      expect(byType.input).toBeGreaterThan(0);
      expect(byType.output).toBeGreaterThan(0);
      // `FoundryChatClient` reports its own provider name, not the OpenAI client's.
      expect(points[0]?.attributes['gen_ai.provider.name']).toBe('azure.ai.foundry');
      expect(points[0]?.attributes['gen_ai.request.model']).toBe(modelDeployment);
      expect(duration?.dataPoints).toHaveLength(1);
    } finally {
      await meterProvider.shutdown();
      metrics.disable();
    }
  });
});
