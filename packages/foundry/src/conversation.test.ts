/**
 * Creating a server-side Foundry conversation up front.
 *
 * The point of creating one rather than letting the first response mint it is that it exists — and
 * shows up in the project — before the first turn. What these tests pin is the id that comes back,
 * and the two ways this can fail without the request being at fault.
 */
import { ChatClientError, ConfigurationError } from '@polymind-inc/agent-framework-core';
import { describe, expect, it, vi } from 'vitest';
import { createFoundryConversation } from './conversation.js';

/** An SDK client whose `conversations.create` answers with `result`. */
function clientAnswering(result: unknown): {
  conversations: { create: ReturnType<typeof vi.fn> };
} {
  return { conversations: { create: vi.fn().mockResolvedValue(result) } };
}

describe('createFoundryConversation', () => {
  it('returns the id the service assigned', async () => {
    const client = clientAnswering({ id: 'conv_abc', created_at: 1 });

    await expect(createFoundryConversation(client)).resolves.toBe('conv_abc');
    expect(client.conversations.create).toHaveBeenCalledTimes(1);
  });

  it('creates exactly one conversation per call', async () => {
    const client = clientAnswering({ id: 'conv_abc' });

    await createFoundryConversation(client);
    await createFoundryConversation(client);

    expect(client.conversations.create).toHaveBeenCalledTimes(2);
  });

  it('passes the caller signal through to the SDK', async () => {
    const client = clientAnswering({ id: 'conv_abc' });
    const controller = new AbortController();

    await createFoundryConversation(client, { signal: controller.signal });

    expect(client.conversations.create).toHaveBeenCalledWith(undefined, { signal: controller.signal });
  });

  it('omits request options entirely when there is no signal', async () => {
    const client = clientAnswering({ id: 'conv_abc' });

    await createFoundryConversation(client);

    expect(client.conversations.create).toHaveBeenCalledWith(undefined, undefined);
  });

  it('fails as a configuration fault when the client has no conversations API', async () => {
    // An older SDK or a hand-built client: nothing about the request is wrong.
    await expect(createFoundryConversation({})).rejects.toThrow(ConfigurationError);
    await expect(createFoundryConversation({ conversations: {} })).rejects.toThrow(ConfigurationError);
  });

  it('fails as a configuration fault when the service reports no usable id', async () => {
    await expect(createFoundryConversation(clientAnswering({}))).rejects.toThrow(ConfigurationError);
    await expect(createFoundryConversation(clientAnswering({ id: '' }))).rejects.toThrow(ConfigurationError);
    await expect(createFoundryConversation(clientAnswering({ id: 42 }))).rejects.toThrow(ConfigurationError);
  });

  it('wraps a service failure in the package error type, keeping the cause', async () => {
    const failure = new Error('service said no');
    const client = { conversations: { create: vi.fn().mockRejectedValue(failure) } };

    const error = await createFoundryConversation(client).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChatClientError);
    expect((error as Error).cause).toBe(failure);
  });

  it('lets a cancellation through as itself rather than as a provider failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const client = { conversations: { create: vi.fn().mockRejectedValue(abort) } };

    const error = await createFoundryConversation(client, { signal: controller.signal }).catch(
      (e: unknown) => e,
    );

    expect(error).toBe(abort);
    expect(error).not.toBeInstanceOf(ChatClientError);
  });
});
