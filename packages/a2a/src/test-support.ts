/**
 * Test doubles for the A2A client.
 *
 * Protocol objects are built with the SDK's own `fromJSON`, from the JSON a server would send, so
 * tests see exactly the shapes the real transports produce — including the fields the SDK fills in
 * (`filename: ''`, byte arrays for `raw`, numeric task states) rather than hand-written stand-ins.
 */

import {
  AgentCard,
  type CancelTaskRequest,
  type GetExtendedAgentCardRequest,
  type GetTaskPushNotificationConfigRequest,
  type GetTaskRequest,
  type ListTaskPushNotificationConfigsRequest,
  type ListTasksRequest,
  Message,
  type SendMessageRequest,
  StreamResponse,
  type SubscribeToTaskRequest,
  Task,
  type TaskPushNotificationConfig,
} from '@a2a-js/sdk';
import { Client, type ClientConfig, type RequestOptions, type Transport } from '@a2a-js/sdk/client';

/** Wire JSON for an agent card, filled in with everything the SDK expects. */
export function agentCard(overrides: Record<string, unknown> = {}): AgentCard {
  return AgentCard.fromJSON({
    name: 'Invoice agent',
    description: 'Answers questions about invoices.',
    version: '1.0.0',
    supportedInterfaces: [
      { url: 'https://example.test/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' },
    ],
    capabilities: { streaming: true },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
    ...overrides,
  });
}

/** Builds a `Task` from its wire JSON. */
export function task(json: Record<string, unknown>): Task {
  return Task.fromJSON(json);
}

/** Builds a `Message` from its wire JSON. */
export function message(json: Record<string, unknown>): Message {
  return Message.fromJSON(json);
}

/** Builds a stream event from its wire JSON, e.g. `{ statusUpdate: { ... } }`. */
export function streamEvent(json: Record<string, unknown>): StreamResponse {
  return StreamResponse.fromJSON(json);
}

/** One transport call a test can assert on. */
export interface RecordedCall {
  method: string;
  params: unknown;
  options?: RequestOptions | undefined;
}

/** What a {@link FakeTransport} should answer with. */
export interface FakeTransportScript {
  /** Result of a blocking `sendMessage`. */
  sendMessage?: Message | Task | (() => Message | Task | Promise<Message | Task>);
  /** Events of a `sendMessageStream` call. */
  sendMessageStream?: StreamResponse[] | (() => AsyncGenerator<StreamResponse>);
  /** Result of `getTask`. */
  getTask?: Task | (() => Task | Promise<Task>);
  /** Events of a `resubscribeTask` call. */
  resubscribeTask?: StreamResponse[] | (() => AsyncGenerator<StreamResponse>);
}

function notImplemented(method: string): never {
  throw new Error(`FakeTransport does not implement ${method}.`);
}

async function* fromEvents(
  events: StreamResponse[] | (() => AsyncGenerator<StreamResponse>),
): AsyncGenerator<StreamResponse, void, undefined> {
  if (typeof events === 'function') {
    yield* events();
    return;
  }
  yield* events;
}

/** A `Transport` that answers from a script and records what it was asked. */
export class FakeTransport implements Transport {
  readonly calls: RecordedCall[] = [];
  readonly #script: FakeTransportScript;

  constructor(script: FakeTransportScript = {}) {
    this.#script = script;
  }

  get protocolName(): string {
    return 'JSONRPC';
  }

  get protocolVersion(): string {
    return '1.0';
  }

  #record(method: string, params: unknown, options?: RequestOptions): void {
    this.calls.push({ method, params, options });
  }

  async sendMessage(params: SendMessageRequest, options?: RequestOptions): Promise<Message | Task> {
    this.#record('sendMessage', params, options);
    const result = this.#script.sendMessage ?? notImplemented('sendMessage');
    return typeof result === 'function' ? result() : result;
  }

  async *sendMessageStream(
    params: SendMessageRequest,
    options?: RequestOptions,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    this.#record('sendMessageStream', params, options);
    yield* fromEvents(this.#script.sendMessageStream ?? notImplemented('sendMessageStream'));
  }

  async getTask(params: GetTaskRequest, options?: RequestOptions): Promise<Task> {
    this.#record('getTask', params, options);
    const result = this.#script.getTask ?? notImplemented('getTask');
    return typeof result === 'function' ? result() : result;
  }

  async *resubscribeTask(
    params: SubscribeToTaskRequest,
    options?: RequestOptions,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    this.#record('resubscribeTask', params, options);
    yield* fromEvents(this.#script.resubscribeTask ?? notImplemented('resubscribeTask'));
  }

  getExtendedAgentCard(_params: GetExtendedAgentCardRequest): Promise<AgentCard> {
    return notImplemented('getExtendedAgentCard');
  }
  cancelTask(_params: CancelTaskRequest): Promise<Task> {
    return notImplemented('cancelTask');
  }
  listTasks(_params: ListTasksRequest): never {
    return notImplemented('listTasks');
  }
  createTaskPushNotificationConfig(_params: TaskPushNotificationConfig): never {
    return notImplemented('createTaskPushNotificationConfig');
  }
  getTaskPushNotificationConfig(_params: GetTaskPushNotificationConfigRequest): never {
    return notImplemented('getTaskPushNotificationConfig');
  }
  listTaskPushNotificationConfig(_params: ListTaskPushNotificationConfigsRequest): never {
    return notImplemented('listTaskPushNotificationConfig');
  }
  deleteTaskPushNotificationConfig(_params: never): never {
    return notImplemented('deleteTaskPushNotificationConfig');
  }
}

/** A real SDK `Client` over a scripted transport, so client-side defaults are exercised too. */
export function fakeClient(
  script?: FakeTransportScript,
  card?: AgentCard,
  config?: ClientConfig,
): { client: Client; transport: FakeTransport } {
  const transport = new FakeTransport(script);
  return { client: new Client(transport, card ?? agentCard(), config), transport };
}
