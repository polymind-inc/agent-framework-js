import type {
  InvocationContext,
  InvocationHandler,
  InvocationsServerConfig,
} from '@polymind-inc/agent-framework-agentserver';
import {
  badRequest,
  InvocationsServer,
  isHosted,
  notImplemented,
  ProtocolError,
} from '@polymind-inc/agent-framework-agentserver';
import type { AgentLike, AgentSession } from '@polymind-inc/agent-framework-core';

/** Construction options for {@link InvocationsHostServer}. */
export interface InvocationsHostServerConfig extends Pick<InvocationsServerConfig, 'prefix'> {
  /** The agent every invocation runs. */
  agent: AgentLike;
  /** Overrides `FOUNDRY_HOSTING_ENVIRONMENT` detection. */
  hosted?: boolean;
}

/**
 * The session partition key for one invocation.
 *
 * Hosted, the key is `sessionId:userId`: one container session serves several end users under
 * container protocol 2.0.0, so the session id alone would hand one user another's conversation.
 * Locally there is no platform to inject a user, and the session id is the whole key.
 */
function partitionKey(context: InvocationContext, hosted: boolean): string {
  if (!hosted) {
    return context.sessionId;
  }
  // The only runtime signal of the protocol version is whether the call id header is present.
  // Serving a v1.0.0 caller would run without the per-user partition this handler depends on,
  // so it refuses, exactly as the Responses handler does.
  if (context.request.foundryCallId === undefined) {
    throw notImplemented(
      'This container implements Invocations container protocol 2.0.0, which requires the ' +
        'x-agent-foundry-call-id header. The request did not carry one.',
      'unsupported_container_protocol_version',
    );
  }
  const userId = context.request.userId;
  // An *empty* header is rejected the same as a missing one: it would silently fall through to
  // an anonymous partition every caller of a misconfigured gateway would share.
  if (userId === undefined || userId === '') {
    throw new ProtocolError(
      400,
      'The hosted environment is missing the platform user id. The request did not come from a ' +
        'Foundry platform service.',
      { code: 'missing_user_id', source: 'platform' },
    );
  }
  return `${context.sessionId}:${userId}`;
}

/** What a well-formed invocation body carries. */
function parseInvocation(payload: unknown): { message: string; stream: boolean } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw badRequest('The request body must be a JSON object.');
  }
  const { message, stream } = payload as { message?: unknown; stream?: unknown };
  if (typeof message !== 'string' || message === '') {
    throw badRequest("The request body must carry a non-empty 'message' string.", {
      param: 'message',
    });
  }
  return { message, stream: stream === true };
}

function invocationHandler(agent: AgentLike, hosted: boolean): InvocationHandler {
  // In memory on purpose: the platform stores no conversation history for the Invocations
  // protocol — the `agent_session_id` the caller pins routes it back to the same sandbox, and
  // the sandbox's own memory is where the conversation lives (the Python adapter keeps the same
  // dict). A recycled sandbox starts the conversation over.
  const sessions = new Map<string, AgentSession>();

  return async (request: Request, context: InvocationContext): Promise<Response> => {
    const key = partitionKey(context, hosted);

    let payload: unknown;
    try {
      payload = await request.json();
    } catch (error) {
      throw badRequest('The request body must be a JSON object.', { cause: error });
    }
    const { message, stream } = parseInvocation(payload);

    let session = sessions.get(key);
    if (session === undefined) {
      // Under the partition key on purpose (the reference constructs
      // `AgentSession(session_id=partition_key)`): tools, middleware and custom agents observe
      // the conversation's real identity through the session, not a throwaway UUID.
      session = agent.createSession({ sessionId: key });
      sessions.set(key, session);
    }

    if (!stream) {
      const response = await agent.run(message, { session, signal: context.signal });
      return new Response(response.text, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    // The chunks are the updates' text, verbatim — the shape the Python adapter streams. The
    // content type asks the protocol layer for SSE keep-alives; the framing of the payload
    // itself is this adapter's wire contract, not the SSE spec's.
    const updates = agent.run(message, { session, signal: context.signal });
    const iterator = updates[Symbol.asyncIterator]();
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller): Promise<void> {
          const { done, value } = await iterator.next();
          if (done === true) {
            controller.close();
            return;
          }
          if (value.text !== '') {
            controller.enqueue(encoder.encode(value.text));
          }
        },
        async cancel(): Promise<void> {
          await iterator.return?.();
        },
      }),
      {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      },
    );
  };
}

/**
 * Publishes an agent as a Foundry Hosted Agent over the Invocations protocol.
 *
 * The counterpart of {@link ResponsesHostServer} for callers that cannot speak the Responses
 * request shape. The wire contract is the adapter's own, matching the Python
 * `InvocationsHostServer`: the request body is `{ "message": string, "stream"?: boolean }`;
 * a non-streaming turn answers the agent's text as `text/plain`, a streaming one answers the
 * update text chunks under `text/event-stream`.
 *
 * Conversation state lives in this process, partitioned per session — and per user when hosted.
 * The platform stores no history for this protocol: for a multi-turn conversation the caller
 * pins the `agent_session_id` query parameter to the value the previous response's
 * `x-agent-session-id` header reported, which routes the turn back to the same sandbox.
 *
 * ```ts
 * const agent = new Agent({
 *   client: new FoundryChatClient({ projectEndpoint, target: { modelDeployment } }),
 *   instructions: 'You are a helpful assistant.',
 * });
 *
 * await serve(new InvocationsHostServer({ agent }));
 * ```
 */
export class InvocationsHostServer extends InvocationsServer {
  constructor(options: InvocationsHostServerConfig) {
    super({
      handler: invocationHandler(options.agent, options.hosted ?? isHosted()),
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    });
  }
}
