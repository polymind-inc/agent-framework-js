import type {
  InvocationContext,
  InvocationHandler,
  InvocationsServerConfig,
} from '@polymind-inc/agent-framework-agentserver';
import {
  badRequest,
  InvocationsServer,
  isHosted,
  maxBodyBytes,
  notImplemented,
  ProtocolError,
  readJsonBody,
  unavailable,
} from '@polymind-inc/agent-framework-agentserver';
import type { AgentLike, AgentSession } from '@polymind-inc/agent-framework-core';
import { ConfigurationError } from '@polymind-inc/agent-framework-core';

const DEFAULT_MAX_SESSIONS = 1024;

/** Construction options for {@link InvocationsHostServer}. */
export interface InvocationsHostServerConfig extends Pick<InvocationsServerConfig, 'prefix'> {
  /** The agent every invocation runs. */
  agent: AgentLike;
  /** Overrides `FOUNDRY_HOSTING_ENVIRONMENT` detection. */
  hosted?: boolean;
  /**
   * Largest request body read, in bytes. Defaults to `AGENTSERVER_MAX_BODY_BYTES`, or 10 MiB —
   * the same default the Responses endpoint reads, so one container answers every endpoint under
   * one bound.
   */
  maxBodyBytes?: number;
  /** Maximum number of idle/in-use conversations retained in memory. Defaults to 1024. */
  maxSessions?: number;
}

function positiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConfigurationError(`${name} must be a positive safe integer.`);
  }
  return value;
}

/**
 * The session partition key for one invocation — the map key *and* the session's own id.
 *
 * Hosted, the partition is per session *and* user: one container session serves several end
 * users under container protocol 2.0.0, so the session id alone would hand one user another's
 * conversation. Locally there is no platform to inject a user, and the session id is the whole
 * partition.
 *
 * One value serves both roles on purpose. `AgentSession.sessionId` is the conversation's stable
 * identifier — an external store keyed by it partitions exactly as well as the id distinguishes,
 * so a colliding spelling there would reopen the cross-user mix-up even with a distinct session
 * object per pair.
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
  // The reference spells this `sessionId:userId`, but a bare join is not injective: the session
  // id is caller-supplied and may itself contain `:`, so `S:v` × user `u` and `S` × user `v:u`
  // would collapse into one identity (the same delimiter-collision defect the Responses session
  // store fixed). URI-escaping the components keeps the join injective — the separator can never
  // appear inside either side — and leaves ids without reserved characters spelled exactly as
  // the reference spells them.
  return `${encodeURIComponent(context.sessionId)}:${encodeURIComponent(userId)}`;
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

function invocationHandler(
  agent: AgentLike,
  hosted: boolean,
  maxBodyBytes: number,
  maxSessions: number,
): InvocationHandler {
  // In memory on purpose: the platform stores no conversation history for the Invocations
  // protocol — the `agent_session_id` the caller pins routes it back to the same sandbox, and
  // the sandbox's own memory is where the conversation lives (the Python adapter keeps the same
  // dict). A recycled sandbox starts the conversation over.
  const sessions = new Map<string, AgentSession>();
  // Each promise is the tail of one session's queue. Holding the lock through streamed response
  // consumption prevents two turns from reading and then overwriting the same transcript.
  const sessionLocks = new Map<string, Promise<void>>();

  async function acquireSession(key: string): Promise<() => void> {
    const previous = sessionLocks.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    sessionLocks.set(key, current);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      unlock();
      if (sessionLocks.get(key) === current) sessionLocks.delete(key);
    };
  }

  function sessionFor(key: string): AgentSession {
    const existing = sessions.get(key);
    if (existing !== undefined) {
      // Touch the entry so Map insertion order is an LRU order.
      sessions.delete(key);
      sessions.set(key, existing);
      return existing;
    }

    if (sessions.size >= maxSessions) {
      let evictable: string | undefined;
      for (const candidate of sessions.keys()) {
        if (!sessionLocks.has(candidate)) {
          evictable = candidate;
          break;
        }
      }
      if (evictable === undefined) {
        throw unavailable('The in-memory invocation session capacity is currently exhausted.');
      }
      sessions.delete(evictable);
    }
    const created = agent.createSession({ sessionId: key });
    sessions.set(key, created);
    return created;
  }

  return async (request: Request, context: InvocationContext): Promise<Response> => {
    const key = partitionKey(context, hosted);

    let payload: unknown;
    try {
      payload = await readJsonBody(request, maxBodyBytes);
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw badRequest('The request body must be a JSON object.', { cause: error });
    }
    const { message, stream } = parseInvocation(payload);

    const releaseSession = await acquireSession(key);
    let handedToStream = false;
    try {
      // Under the partition key on purpose (the reference constructs
      // `AgentSession(session_id=partition_key)`): tools, middleware and custom agents observe
      // the conversation's real identity through the session, not a throwaway UUID.
      const session = sessionFor(key);

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
      const response = new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller): Promise<void> {
            try {
              // Until something is enqueued or the run ends: a tool round surfaces as updates with
              // no text, and returning empty-handed would just make the stream machinery re-enter
              // immediately — the loop is the same consumption, without the churn.
              for (;;) {
                const { done, value } = await iterator.next();
                if (done === true) {
                  releaseSession();
                  controller.close();
                  return;
                }
                if (value.text !== '') {
                  controller.enqueue(encoder.encode(value.text));
                  return;
                }
              }
            } catch (error) {
              releaseSession();
              controller.error(error);
            }
          },
          async cancel(): Promise<void> {
            try {
              await iterator.return?.();
            } finally {
              releaseSession();
            }
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
      handedToStream = true;
      return response;
    } finally {
      if (!handedToStream) releaseSession();
    }
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
 *   client: new FoundryChatClient({
 *     project: new FoundryProject(process.env.FOUNDRY_PROJECT_ENDPOINT!, new DefaultAzureCredential()),
 *     target: { model },
 *   }),
 *   instructions: 'You are a helpful assistant.',
 * });
 *
 * await serve(new InvocationsHostServer({ agent }));
 * ```
 */
export class InvocationsHostServer extends InvocationsServer {
  constructor(options: InvocationsHostServerConfig) {
    super({
      handler: invocationHandler(
        options.agent,
        options.hosted ?? isHosted(),
        // The environment default flows through unvalidated on purpose: it is the very value the
        // Responses endpoint serves under, and refusing here what that endpoint accepts would
        // split the container's behaviour over one variable. Only an explicit option is checked.
        options.maxBodyBytes === undefined
          ? maxBodyBytes()
          : positiveLimit('maxBodyBytes', options.maxBodyBytes),
        positiveLimit('maxSessions', options.maxSessions ?? DEFAULT_MAX_SESSIONS),
      ),
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    });
  }
}
