/**
 * 00 — A local A2A agent to talk to.
 *
 * A minimal invoice agent built with the A2A SDK's own server, so the client examples can be run
 * without an external agent. It covers the three shapes a real agent produces: an immediate
 * message, a task that streams artifacts, and a task that stops to ask a question.
 *
 * Run: `pnpm --filter example-04-a2a server`
 */
import { randomUUID } from 'node:crypto';
import { AgentCard, Message, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import express from 'express';

const port = Number(process.env.PORT ?? 4100);
const baseUrl = `http://localhost:${port}`;

const card = AgentCard.fromJSON({
  name: 'Invoice agent',
  description: 'Answers questions about invoices.',
  version: '1.0.0',
  supportedInterfaces: [{ url: baseUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: { streaming: true },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    {
      id: 'invoice_status',
      name: 'Invoice status',
      description: 'Reports whether an invoice has been paid.',
      tags: ['billing'],
    },
  ],
});

const textOf = (message: Message): string =>
  message.parts.map((part) => (part.content?.$case === 'text' ? part.content.value : '')).join(' ');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const executor: AgentExecutor = {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = ctx;
    const question = textOf(ctx.userMessage);
    const invoice = /\d+/.exec(question)?.[0];

    if (/^\s*(hi|hello)\b/i.test(question)) {
      // Small talk needs no task: an answer on its own is a complete turn.
      bus.publish({
        kind: 'message',
        data: Message.fromJSON({
          messageId: randomUUID(),
          contextId,
          role: 'ROLE_AGENT',
          parts: [{ text: 'Hello. Ask me about an invoice by number.' }],
        }),
      });
      bus.finished();
      return;
    }

    bus.publish({
      kind: 'task',
      data: Task.fromJSON({ id: taskId, contextId, status: { state: 'TASK_STATE_SUBMITTED' } }),
    });

    if (invoice === undefined) {
      // Nothing to look up yet: stop and ask. The client links its next message to this task.
      bus.publish({
        kind: 'statusUpdate',
        data: TaskStatusUpdateEvent.fromJSON({
          taskId,
          contextId,
          status: {
            state: 'TASK_STATE_INPUT_REQUIRED',
            message: {
              messageId: randomUUID(),
              contextId,
              taskId,
              role: 'ROLE_AGENT',
              parts: [{ text: 'Which invoice number?' }],
            },
          },
        }),
      });
      bus.finished();
      return;
    }

    bus.publish({
      kind: 'statusUpdate',
      data: TaskStatusUpdateEvent.fromJSON({ taskId, contextId, status: { state: 'TASK_STATE_WORKING' } }),
    });

    const artifactId = randomUUID();
    for (const chunk of [`Invoice ${invoice} `, 'was paid ', 'on 2026-07-14.']) {
      await sleep(150);
      bus.publish({
        kind: 'artifactUpdate',
        data: TaskArtifactUpdateEvent.fromJSON({
          taskId,
          contextId,
          artifact: { artifactId, name: 'answer', parts: [{ text: chunk }] },
          append: true,
        }),
      });
    }

    bus.publish({
      kind: 'statusUpdate',
      data: TaskStatusUpdateEvent.fromJSON({ taskId, contextId, status: { state: 'TASK_STATE_COMPLETED' } }),
    });
    bus.finished();
  },

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    bus.publish({
      kind: 'statusUpdate',
      data: TaskStatusUpdateEvent.fromJSON({
        taskId,
        contextId: '',
        status: { state: 'TASK_STATE_CANCELED' },
      }),
    });
    bus.finished();
  },
};

const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
const app = express();
app.use(express.json());

// Set A2A_TOKEN to require a bearer token, which is what `04-authentication.ts` connects to. The
// card is protected too: a real deployment rarely publishes what an agent can do to everyone.
const requiredToken = process.env.A2A_TOKEN;
if (requiredToken !== undefined) {
  app.use((req, res, next) => {
    if (req.headers.authorization !== `Bearer ${requiredToken}`) {
      res.status(401).set('www-authenticate', 'Bearer').json({ error: 'unauthorized' });
      return;
    }
    next();
  });
}

app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: requestHandler }));
app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

app.listen(port, () => {
  console.log(
    `Invoice agent listening on ${baseUrl}${requiredToken === undefined ? '' : ' (bearer token required)'}`,
  );
  console.log(`Agent card: ${baseUrl}/.well-known/agent-card.json`);
});
