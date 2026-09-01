import type {
  AgentSession,
  ChatClient,
  ChatResponse,
  ChatResponseStream,
  ChatResponseUpdate,
  Message,
} from '@polymind-inc/agent-framework-core';
import { ConfigurationError, createResponseStream } from '@polymind-inc/agent-framework-core';
import { isRecord, updatesOf } from '@polymind-inc/agent-framework-core/internal';
import type { OpenAIChatOptions } from '@polymind-inc/agent-framework-openai';

/**
 * Where the hosted-agent session id lives on an {@link AgentSession}.
 *
 * A `state` key rather than a field on the session: this is one provider's platform identifier,
 * not a concept the framework has. Session state is serialized, so the pin survives persistence
 * and restoration the same way the rest of a session does.
 */
export const FOUNDRY_HOSTED_SESSION_STATE_KEY = 'foundry_hosted_agent_session_id';

/** The request and response field Foundry spells the hosted session id with. */
const WIRE_KEY = 'agent_session_id';

/** A non-empty string, or `undefined` for anything else. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The hosted session id a Foundry response reports, from either transport's raw payload. */
function reportedHostedSessionId(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  // An awaited call carries the Responses object itself; a streamed event carries it under
  // `response`, which is where Foundry stamps the id it minted for the run.
  const direct = nonEmpty(raw[WIRE_KEY]);
  if (direct !== undefined) {
    return direct;
  }
  return isRecord(raw.response) ? nonEmpty(raw.response[WIRE_KEY]) : undefined;
}

/** The id already pinned to this session, if any. */
export function pinnedHostedSessionId(session: AgentSession): string | undefined {
  return nonEmpty(session.state[FOUNDRY_HOSTED_SESSION_STATE_KEY]);
}

/**
 * Wraps a Foundry client so one run's hosted-agent session id is sent, captured and kept.
 *
 * The **hosted-agent session** is a Foundry sandbox — compute plus a persistent `$HOME` — and it
 * is a different thing from the conversation the transcript lives in, which the framework tracks
 * as `AgentSession.serviceSessionId`. A run may have either, both, or neither. Foundry owns the
 * sandbox's lifecycle (provisioning, idle suspend, TTL); this layer only carries its id, and
 * nothing here creates or releases one.
 *
 * The service mints the id on the first request that does not carry one, and reports it back. Every
 * later request has to send it or Foundry may hand out a different sandbox — including the *next
 * round of the same run*, which is why this is bound per run and sits inside the function-calling
 * loop rather than around it.
 *
 * @param client - The Foundry client to wrap.
 * @param session - The run's session. The id is read from and written to its `state`, never held
 * on the client, so two sessions cannot see each other's sandbox.
 */
export function withHostedSessionId<TOptions extends OpenAIChatOptions>(
  client: ChatClient<TOptions>,
  session: AgentSession,
): ChatClient<TOptions> {
  /** Records an id the service reported, the first time one is seen. */
  const capture = (raw: unknown): void => {
    const reported = reportedHostedSessionId(raw);
    if (reported !== undefined) {
      session.state[FOUNDRY_HOSTED_SESSION_STATE_KEY] = reported;
    }
  };

  return {
    metadata: client.metadata,
    getResponse(
      messages: Message[],
      options?: TOptions & { signal?: AbortSignal },
    ): ChatResponseStream<unknown> {
      const pinned = pinnedHostedSessionId(session);
      const perCall = nonEmpty(options?.additionalProperties?.[WIRE_KEY]);
      if (pinned !== undefined && perCall !== undefined && pinned !== perCall) {
        // Sending either one would be a guess about which sandbox the caller meant, and the wrong
        // guess reaches a different `$HOME`. Fail here rather than on the wire.
        throw new ConfigurationError(
          `This session is pinned to Foundry hosted agent session '${pinned}', but the request asks for ` +
            `'${perCall}'. Use one or the other.`,
        );
      }
      // An explicit per-call id wins over nothing at all and matches the pin otherwise, so either
      // way it is what goes out; the pin is what fills the gap when the caller named none.
      const send = perCall ?? pinned;
      let next = options;
      if (send !== undefined) {
        // A copy: the caller's options object is theirs, and the agent hands the same one to every
        // round of the run.
        const copy = { ...options } as TOptions & { signal?: AbortSignal };
        copy.additionalProperties = { ...options?.additionalProperties, [WIRE_KEY]: send };
        next = copy;
      }

      const inner = client.getResponse(messages, next);
      return createResponseStream<ChatResponseUpdate, ChatResponse<unknown>>({
        start: async function* (ctx) {
          for await (const update of updatesOf(inner, ctx.stream)) {
            // Captured as it arrives, so an id the service already minted is kept even if the run
            // fails afterwards or the caller stops reading.
            capture(update.rawRepresentation);
            yield update;
          }
        },
        finalize: async () => {
          const final = await inner.finalResponse();
          // The awaited transport reports the id on the response rather than on any one update.
          capture(final.rawRepresentation);
          return final;
        },
      });
    },
  };
}
