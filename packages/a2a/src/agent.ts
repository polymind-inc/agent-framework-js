import type { AgentCard, SendMessageConfiguration, SendMessageRequest } from '@a2a-js/sdk';
import {
  type Client,
  ClientFactory,
  DefaultAgentCardResolver,
  type RequestOptions,
} from '@a2a-js/sdk/client';
import {
  type AgentAsToolOptions,
  AgentFrameworkError,
  type AgentLike,
  type AgentResponse,
  type AgentResponseUpdate,
  type AgentRunInput,
  type AgentRunSpan,
  type AgentRunStream,
  AgentSession,
  agentAsTool,
  ConfigurationError,
  type ContinuationToken,
  createClientErrorNormalizer,
  createResponseStream,
  type FunctionTool,
  mergeUpdates,
  normalizeInput,
  startAgentRunSpan,
} from '@polymind-inc/agent-framework-core';
import { parseA2AContinuationToken } from './continuation.js';
import { type A2APayload, type ObservedTaskState, toA2AMessage, updatesFromPayload } from './convert.js';
import { A2AAgentError } from './errors.js';
import { A2A_STATE_KEY, contextMismatch, readA2ASessionState, writeA2ASessionState } from './session.js';

/** Goes to `gen_ai.provider.name`, lower-case as the conventions spell provider names. */
const PROVIDER_NAME = 'a2a';

/** The `google.rpc.ErrorInfo` reason for "this task can no longer be subscribed to". */
const UNSUPPORTED_OPERATION = 'UNSUPPORTED_OPERATION';

/** Construction options for {@link A2AAgent}. */
export interface A2AAgentConfig {
  /**
   * A fully constructed A2A client. Use this to control transport selection, interceptors or
   * authentication; otherwise pass {@link A2AAgentConfig.agentCard}.
   */
  client?: Client;
  /**
   * The remote agent's card. The client is built from it on the first run, choosing a transport
   * from the interfaces the card advertises.
   */
  agentCard?: AgentCard;
  /** Defaults to a generated id. Never taken from the card, whose name is not an identity. */
  id?: string;
  /** Defaults to the card's name, when a card was given. */
  name?: string;
  /** Defaults to the card's description, when a card was given. */
  description?: string;
}

/** Per-run options for {@link A2AAgent.run}. */
export interface A2ARunOptions {
  /** Continues an existing conversation; required to resume a background run later. */
  session?: AgentSession;
  /** Sent as the request's `metadata`, for context the protocol does not model. */
  metadata?: Record<string, unknown>;
  /** Resumes a task the agent is still working on. Pass no input alongside it. */
  continuationToken?: ContinuationToken;
  /**
   * Returns as soon as the task is accepted, with a `continuationToken` to resume from.
   *
   * Requires an explicit `session`: an auto-created session cannot be reached again, so the token
   * would have nothing to resume into.
   */
  allowBackgroundResponses?: boolean;
  signal?: AbortSignal;
}

/** Options for {@link A2AAgent.fromUrl}. */
export interface A2AAgentFromUrlOptions {
  id?: string;
  name?: string;
  description?: string;
  /** Overrides the well-known card path (`/.well-known/agent-card.json`). */
  cardPath?: string;
}

function randomMessageId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/** Whether an error the SDK raised carries a given `google.rpc.ErrorInfo` reason. */
function hasReason(error: unknown, reason: string): boolean {
  return typeof error === 'object' && error !== null && (error as { reason?: unknown }).reason === reason;
}

/**
 * A remote agent reached over the Agent2Agent (A2A) protocol.
 *
 * ```ts
 * const agent = await A2AAgent.fromUrl('https://example.com');
 * const session = agent.createSession();
 * const response = await agent.run('Invoice 42, please', { session });
 * ```
 *
 * The remote side owns the conversation: its context id is kept in `session.serviceSessionId`, and
 * only the current turn's input is ever sent. This agent therefore has no tools, instructions,
 * middleware or context providers of its own — what it can do is whatever the remote agent does.
 * Fields of the shared run options it does not declare (`tools`, `middleware`, `responseFormat`,
 * `options`) are ignored, as they are in the other implementations of this protocol.
 *
 * ## Security considerations
 *
 * - **The remote agent is untrusted.** Everything it returns — text, structured data, file URLs —
 *   is third-party content that reaches your model as conversation history, so treat it as a
 *   prompt-injection vector and never as instructions.
 * - **A continuation token names a task on the remote side.** Passing back a token from somewhere
 *   else resumes someone else's task; tokens are refused unless they have exactly the shape this
 *   package issues.
 * - **Authentication belongs to the client.** Pass a configured `client` to attach credentials;
 *   this package never reads them from the environment.
 */
export class A2AAgent implements AgentLike {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  /** The card this agent was built from, when it was built from one. */
  readonly agentCard?: AgentCard;

  readonly #client?: Client;
  #clientPromise?: Promise<Client>;

  readonly #normalizeError = createClientErrorNormalizer({
    wrap: (error, detail) =>
      // The framework's own errors are already the right ones: a misconfigured run and a payload
      // this client refused both explain themselves, and wrapping either in a transport failure
      // would say the remote agent broke when it did not.
      error instanceof AgentFrameworkError
        ? error
        : new A2AAgentError(`The A2A agent failed: ${detail}`, { cause: error }),
  });

  constructor(config: A2AAgentConfig) {
    if (config.client === undefined && config.agentCard === undefined) {
      throw new ConfigurationError(
        'An A2AAgent needs either a client or an agentCard. Use A2AAgent.fromUrl(url) to resolve a ' +
          'card from a well-known URI.',
      );
    }
    this.id = config.id ?? randomMessageId();
    // The card fills in only what the caller left out, and an explicitly empty name stays empty.
    const name = config.name ?? config.agentCard?.name;
    const description = config.description ?? config.agentCard?.description;
    if (name !== undefined) this.name = name;
    if (description !== undefined) this.description = description;
    if (config.agentCard !== undefined) this.agentCard = config.agentCard;
    if (config.client !== undefined) this.#client = config.client;
  }

  /**
   * Resolves an agent card from a well-known URI and builds an agent for it.
   *
   * The only construction path that performs I/O; the constructor itself never does.
   */
  static async fromUrl(url: string, options?: A2AAgentFromUrlOptions): Promise<A2AAgent> {
    const agentCard = await new DefaultAgentCardResolver().resolve(url, options?.cardPath);
    return new A2AAgent({
      agentCard,
      ...(options?.id === undefined ? {} : { id: options.id }),
      ...(options?.name === undefined ? {} : { name: options.name }),
      ...(options?.description === undefined ? {} : { description: options.description }),
    });
  }

  /**
   * Builds the client on first use, then reuses it.
   *
   * Transport selection reads the card and constructs a transport; it makes no request, so a
   * failure here is a configuration problem that will not resolve on a retry, and the settled
   * promise is kept either way.
   */
  #resolveClient(): Promise<Client> {
    this.#clientPromise ??=
      this.#client === undefined
        ? new ClientFactory().createFromAgentCard(this.agentCard as AgentCard).catch((error: unknown) => {
            // A card that names no transport this client speaks is a mismatched configuration, not
            // a failed request, and it reports as one wherever it is first noticed.
            throw new ConfigurationError(
              `No usable transport for this agent card: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          })
        : Promise.resolve(this.#client);
    return this.#clientPromise;
  }

  /**
   * Starts a conversation, optionally bound to a context and task the remote side already knows.
   *
   * @throws {ConfigurationError} When `taskId` is given without the `serviceSessionId` of the
   * conversation it belongs to — a task id alone does not identify anything the agent can continue.
   */
  createSession(options?: { sessionId?: string; serviceSessionId?: string; taskId?: string }): AgentSession {
    if (options?.taskId !== undefined && options.serviceSessionId === undefined) {
      throw new ConfigurationError(
        'A taskId can only be restored together with the serviceSessionId (A2A contextId) of the ' +
          'conversation it belongs to.',
      );
    }
    const session = new AgentSession({
      ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options?.serviceSessionId === undefined ? {} : { serviceSessionId: options.serviceSessionId }),
    });
    if (options?.taskId !== undefined && options.serviceSessionId !== undefined) {
      const partition = session.partition(A2A_STATE_KEY);
      partition.contextId = options.serviceSessionId;
      partition.taskId = options.taskId;
    }
    return session;
  }

  /**
   * Restores a session saved with `JSON.stringify(session)`.
   *
   * @throws {ConfigurationError} When the state is not a session, or its A2A partition is malformed.
   */
  deserializeSession(state: unknown): AgentSession {
    const session = AgentSession.fromJSON(state);
    // Validated now rather than on the next run, so a bad partition fails where it can be fixed.
    readA2ASessionState(session);
    return session;
  }

  /** Exposes this agent as a tool another agent can call. */
  asTool(options?: AgentAsToolOptions): FunctionTool<Record<string, unknown>, string> {
    return agentAsTool(this, options);
  }

  /**
   * Sends a turn to the remote agent.
   *
   * How the result is consumed picks the protocol operation: awaiting the stream sends a blocking
   * `message/send` (or `tasks/get` when resuming), iterating it subscribes to `message/stream` (or
   * `tasks/resubscribe`). Both produce the same updates, so the choice never changes the answer.
   *
   * @throws {ConfigurationError} When the run is asked for something it cannot do: input alongside
   * a continuation token, background execution without a session, or no input at all.
   */
  run(input?: AgentRunInput, options?: A2ARunOptions): AgentRunStream<unknown> {
    const inputMessages = normalizeInput(input);
    const session = options?.session;
    const signal = options?.signal;
    const background = options?.allowBackgroundResponses === true;

    if (background && session === undefined) {
      throw new ConfigurationError('A session must be provided when allowBackgroundResponses is enabled.');
    }
    const resumeTaskId =
      options?.continuationToken === undefined
        ? undefined
        : parseA2AContinuationToken(options.continuationToken).taskId;
    if (resumeTaskId !== undefined && inputMessages.length > 0) {
      throw new ConfigurationError(
        'Messages are not allowed when resuming a run with a continuationToken. The remote agent is ' +
          'still working on the task; send a new message once it has finished.',
      );
    }
    if (resumeTaskId === undefined && inputMessages.length === 0) {
      throw new ConfigurationError('At least one message is required to start an A2A run.');
    }

    const observed: ObservedTaskState = {};
    let span: AgentRunSpan | undefined;

    const start = async (ctx: { stream: boolean }): Promise<AsyncIterable<AgentResponseUpdate>> => {
      const client = await this.#resolveClient();
      const requestOptions: RequestOptions = signal === undefined ? {} : { signal };
      span = startAgentRunSpan(
        {
          id: this.id,
          ...(this.name === undefined ? {} : { name: this.name }),
          ...(this.description === undefined ? {} : { description: this.description }),
          providerName: PROVIDER_NAME,
          ...(session?.serviceSessionId === undefined ? {} : { conversationId: session.serviceSessionId }),
        },
        inputMessages,
      );

      const payloads = (): AsyncGenerator<A2APayload> =>
        resumeTaskId === undefined
          ? this.#send(client, inputMessages, {
              stream: ctx.stream,
              background,
              requestOptions,
              ...(session === undefined ? {} : { session }),
              ...(options?.metadata === undefined ? {} : { metadata: options.metadata }),
            })
          : this.#resume(client, resumeTaskId, ctx.stream, requestOptions);

      return this.#pipe(payloads, observed, span, session, signal);
    };

    return createResponseStream<AgentResponseUpdate, AgentResponse<unknown>>({
      start,
      finalize: (updates): AgentResponse<unknown> => {
        const response = mergeUpdates<unknown>(updates);
        response.agentId = this.id;
        if (this.name !== undefined) {
          for (const message of response.messages) {
            message.authorName ??= this.name;
          }
        }
        return response;
      },
      onResult: [
        (response): void => {
          span?.setResponse(response);
          span?.end();
        },
      ],
      cleanup: [
        (failure?: unknown): void => {
          // Cleanup runs before finalization, so the span stays open for the response attributes on
          // the happy path. A failure never reaches `onResult`, so it ends the span here — which
          // also covers deaths the source never sees, such as an abort between pulls.
          if (failure !== undefined) {
            span?.setError(failure);
            span?.end();
          }
        },
      ],
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** Sends this turn's message, blocking or streaming according to how the caller consumes it. */
  async *#send(
    client: Client,
    inputMessages: readonly import('@polymind-inc/agent-framework-core').Message[],
    ctx: {
      stream: boolean;
      background: boolean;
      requestOptions: RequestOptions;
      session?: AgentSession;
      metadata?: Record<string, unknown>;
    },
  ): AsyncGenerator<A2APayload> {
    const link = readA2ASessionState(ctx.session);
    const message = toA2AMessage(
      inputMessages,
      {
        ...link,
        ...(ctx.session?.serviceSessionId === undefined ? {} : { contextId: ctx.session.serviceSessionId }),
      },
      randomMessageId(),
    );
    if (message.parts.length === 0) {
      // Nothing survived the mapping — content the protocol cannot carry, or empty text. Sending a
      // message with no parts asks the remote agent a question that is not there.
      throw new ConfigurationError(
        'None of the input can be sent to an A2A agent: it holds no text, file or data content.',
      );
    }
    const params: SendMessageRequest = {
      tenant: '',
      message,
      // Only `returnImmediately` is this package's to say, and only when the caller asked to run in
      // the background: the client fills the rest of the configuration in from its own settings —
      // including the accepted output modes, which stating here would silently override. A
      // foreground turn says nothing at all, and the client's default (`false`) is what it wants.
      // Streaming has no background mode: the stream itself is how progress arrives.
      configuration:
        ctx.background && !ctx.stream
          ? // The SDK types every field as required; the client supplies the ones left out here.
            ({ returnImmediately: true } as SendMessageConfiguration)
          : undefined,
      metadata: ctx.metadata,
    };

    if (ctx.stream) {
      for await (const event of client.sendMessageStream(params, ctx.requestOptions)) {
        if (event.payload !== undefined) {
          yield event.payload;
        }
      }
      return;
    }
    const result = await client.sendMessage(params, ctx.requestOptions);
    // A blocking send answers with either a message or a task, told apart by the field only a
    // message has — the same test the SDK itself uses.
    yield 'messageId' in result ? { $case: 'message', value: result } : { $case: 'task', value: result };
  }

  /** Picks the run back up: re-subscribing when streaming, a single read when not. */
  async *#resume(
    client: Client,
    taskId: string,
    stream: boolean,
    requestOptions: RequestOptions,
  ): AsyncGenerator<A2APayload> {
    if (!stream) {
      yield { $case: 'task', value: await client.getTask({ tenant: '', id: taskId }, requestOptions) };
      return;
    }
    let delivered = false;
    try {
      for await (const event of client.resubscribeTask({ tenant: '', id: taskId }, requestOptions)) {
        if (event.payload !== undefined) {
          delivered = true;
          yield event.payload;
        }
      }
    } catch (error) {
      // A task that already finished cannot be subscribed to, and the protocol says so with this
      // error rather than with an empty stream. Its final state is still readable, and that is what
      // the caller is resuming for. Once events have arrived the stream is real, and a failure in
      // the middle of one is a failure.
      if (delivered || !hasReason(error, UNSUPPORTED_OPERATION)) {
        throw error;
      }
      yield { $case: 'task', value: await client.getTask({ tenant: '', id: taskId }, requestOptions) };
    }
  }

  /**
   * Turns protocol payloads into response updates and records what the turn learned.
   *
   * Every event is checked against the conversation this run belongs to **before** its content is
   * handed over. Committing the session at the end would be too late to be a check: a caller that
   * reads one update and stops has already been shown whatever arrived, and content from another
   * conversation is exactly what must never reach them.
   *
   * The session itself is still written only when the source runs out: a caller who stops early has
   * an unfinished turn, and moving the session onto a task whose outcome was never seen would make
   * the next message link to it.
   */
  async *#pipe(
    payloads: () => AsyncGenerator<A2APayload>,
    observed: ObservedTaskState,
    span: AgentRunSpan,
    session: AgentSession | undefined,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentResponseUpdate> {
    // A session that names no conversation yet adopts the first one this stream reports, so the
    // rest of the stream is held to it too.
    let expectedContextId = session?.serviceSessionId;
    try {
      // Iterated inside the run span so requests the SDK makes are traced under it.
      for await (const payload of span.active(payloads())) {
        const updates = updatesFromPayload(payload, observed);
        const reported = observed.contextId;
        if (reported !== undefined && reported !== '') {
          expectedContextId ??= reported;
          if (reported !== expectedContextId) {
            throw contextMismatch(expectedContextId, reported);
          }
        }
        for (const update of updates) {
          update.agentId = this.id;
          if (this.name !== undefined) {
            update.authorName ??= this.name;
          }
          yield update;
        }
      }
    } catch (error) {
      throw this.#normalizeError(error, signal);
    }
    if (session !== undefined) {
      writeA2ASessionState(session, observed);
    }
  }
}
