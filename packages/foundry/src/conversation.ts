import type { ClientErrorNormalizer } from '@polymind-inc/agent-framework-core';
import {
  ChatClientError,
  ConfigurationError,
  createClientErrorNormalizer,
} from '@polymind-inc/agent-framework-core';
import OpenAI from 'openai';

/** The shape this module needs from an SDK client, so a stub in a test does not have to be a whole `OpenAI`. */
interface HasConversations {
  conversations?: {
    create?: (
      body?: Record<string, never> | null,
      options?: { signal?: AbortSignal },
    ) => PromiseLike<{ id?: unknown }>;
  };
}

/**
 * Turns anything the SDK throws into what this package throws.
 *
 * Same contract as the Responses client's own boundary: a cancellation passes through as the
 * standards-shaped abort value rather than being laundered into a provider failure.
 */
const toClientError: ClientErrorNormalizer = createClientErrorNormalizer({
  abortErrorClass: OpenAI.APIUserAbortError,
  wrap: (error, detail) =>
    new ChatClientError(`Foundry conversation creation failed: ${detail}`, { cause: error }),
});

/**
 * Creates a server-side Foundry conversation and returns its id.
 *
 * A conversation is where the service keeps a transcript, and it appears in the Foundry Project UI
 * from the moment it exists — which is the reason to create one up front rather than let the first
 * response mint it. Hand the id to `agent.createSession({ serviceSessionId })` and the run
 * continues that conversation:
 *
 * ```ts
 * const session = agent.createSession({ serviceSessionId: await client.createConversation() });
 * ```
 *
 * This is not the same identifier as a hosted-agent session: that one names a sandbox, and the two
 * are independent. See `withHostedSessionId`.
 *
 * **Creating is all this does.** The conversation outlives the session object, nothing here
 * deletes it, and dropping the session does not release it — its lifecycle belongs to the service
 * and to whoever is paying for the project.
 *
 * @throws {ConfigurationError} When the SDK client has no conversations resource, or the service
 * answers without an id — both are configuration faults rather than request failures.
 * @throws {ChatClientError} When the service rejects the request.
 */
export async function createFoundryConversation(
  client: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const create = (client as HasConversations).conversations?.create;
  if (typeof create !== 'function') {
    // An older SDK, or a hand-built client that does not carry the resource: nothing about the
    // request is wrong, so failing here says so more usefully than a `TypeError` would.
    throw new ConfigurationError(
      'This client has no conversations API, so a Foundry conversation cannot be created. Pass an ' +
        'OpenAI SDK client that exposes `conversations.create`.',
    );
  }
  let conversation: { id?: unknown };
  try {
    conversation = await create.call(
      (client as HasConversations).conversations,
      undefined,
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch (error) {
    throw toClientError(error, options.signal);
  }
  const id = conversation.id;
  if (typeof id !== 'string' || id === '') {
    throw new ConfigurationError(
      'Foundry created a conversation but reported no id, so there is nothing to continue from.',
    );
  }
  return id;
}
