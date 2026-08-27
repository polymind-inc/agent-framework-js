/**
 * The Microsoft Foundry Memory Store data-plane client.
 *
 * A hand-written client rather than an SDK wrapper: the JavaScript Azure SDK has no memory-store
 * API, so the routes, headers and payloads here come from the service contract itself
 * (`ai-foundry/data-plane/Foundry/src/memory-stores`) rather than from a generated surface. The
 * shapes below carry the service's own snake_case, because they are the wire.
 *
 * Only the operations the provider needs are implemented — search, update, update-result polling,
 * scope deletion, and the two store routes a caller needs to provision one. Memory *items* have
 * their own CRUD routes; neither reference implementation reaches them from a context provider,
 * and neither does this.
 */

import { AgentFrameworkError } from '@polymind-inc/agent-framework-core';
import type { FoundryProject } from '../project.js';
import { FOUNDRY_API_VERSION } from '../target.js';

/**
 * The preview opt-in every memory-store route requires.
 *
 * Not optional: the service contract marks these operations with a *required* `Foundry-Features`
 * header, which is what the reference implementations send for you — Python by constructing its
 * project client with `allow_preview=True`, .NET from the generated client's defaults.
 */
const MEMORY_PREVIEW_FEATURE = 'MemoryStores=V1Preview';

/** One conversation item handed to the memory service, in the shape the service reads. */
export interface MemoryInputItem {
  type: 'message';
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** A single memory the service holds. */
export interface MemoryItem {
  memory_id?: string;
  scope?: string;
  content?: string;
  kind?: string;
  updated_at?: number;
}

/** The answer to a search: the memories, plus the id that makes the next search incremental. */
export interface MemorySearchResponse {
  search_id?: string;
  memories?: Array<{ memory_item?: MemoryItem }>;
}

/** The status of one asynchronous memory extraction. */
export interface MemoryUpdateResponse {
  update_id?: string;
  status?: 'queued' | 'in_progress' | 'completed' | 'failed' | 'superseded' | (string & {});
  superseded_by?: string;
  error?: { code?: string; message?: string };
}

/** How a memory store extracts and embeds; required when creating one. */
export interface MemoryStoreDefinition {
  kind: 'default';
  chat_model: string;
  embedding_model: string;
  options?: {
    user_profile_enabled?: boolean;
    user_profile_details?: string;
    chat_summary_enabled?: boolean;
    procedural_memory_enabled?: boolean;
    default_ttl_seconds?: number;
  };
}

/** A memory store resource. */
export interface MemoryStoreObject {
  id?: string;
  name?: string;
  description?: string;
  definition?: MemoryStoreDefinition;
}

/** The operations a {@link FoundryMemoryError} can come from. */
export type MemoryOperation =
  | 'search'
  | 'update'
  | 'updateResult'
  | 'deleteScope'
  | 'getStore'
  | 'createStore';

/** A memory-store call the service refused, or that never reached it. */
export class FoundryMemoryError extends AgentFrameworkError {
  /** Which call failed. */
  readonly operation: MemoryOperation;
  /** The HTTP status, or `undefined` when the request never got an answer. */
  readonly status?: number;

  constructor(operation: MemoryOperation, message: string, options?: ErrorOptions & { status?: number }) {
    super(message, options);
    this.name = 'FoundryMemoryError';
    this.operation = operation;
    if (options?.status !== undefined) {
      this.status = options.status;
    }
  }
}

/** Construction options for {@link MemoryStoreClient}. */
export interface MemoryStoreClientOptions {
  /** The project every call goes to and is authorized against. */
  project: FoundryProject;
  /** Overridable for tests and proxies. Defaults to the project's transport. */
  fetch?: typeof globalThis.fetch;
}

/**
 * The memory-store routes, as a typed client.
 *
 * ## No retry, deliberately
 *
 * Both references inherit a retry policy from their Azure HTTP pipeline; this client has none.
 * Memory sits on the critical path of every run — a search runs before the model call and an
 * update after it — and the provider's default is to continue without memories when the service
 * fails. Retrying would spend a run's latency budget re-attempting an augmentation the run is
 * already designed to survive losing. A caller who wants retries can supply a `fetch` that has
 * them.
 *
 * ## Security considerations
 *
 * Every call carries an Entra bearer token for the project, and `scope` — the partition key,
 * typically an end-user id — travels in the request body. Point this at a host you do not control
 * and you hand it both.
 */
export class MemoryStoreClient {
  readonly #endpoint: string;
  readonly #getToken: () => Promise<string>;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: MemoryStoreClientOptions) {
    this.#endpoint = options.project.endpoint;
    this.#getToken = () => options.project.getToken();
    this.#fetch = options.fetch ?? options.project.fetch ?? globalThis.fetch;
  }

  /** Memories relevant to `items`, or the scope's profile memories when `items` is absent. */
  async searchMemories(
    request: {
      name: string;
      scope: string;
      items?: readonly MemoryInputItem[];
      previousSearchId?: string;
      maxMemories?: number;
    },
    signal?: AbortSignal,
  ): Promise<MemorySearchResponse> {
    const body: Record<string, unknown> = { scope: request.scope };
    if (request.items !== undefined) {
      body.items = request.items;
    }
    if (request.previousSearchId !== undefined) {
      body.previous_search_id = request.previousSearchId;
    }
    if (request.maxMemories !== undefined) {
      body.options = { max_memories: request.maxMemories };
    }
    const response = await this.#send('POST', `${this.#store(request.name)}:search_memories`, {
      operation: 'search',
      body,
      signal,
    });
    return await MemoryStoreClient.#json<MemorySearchResponse>(response, 'search');
  }

  /**
   * Queues an extraction over `items`.
   *
   * The service answers `202` with the update's id; extraction itself happens afterwards, which is
   * what {@link whenUpdatesCompleted} on the provider waits for.
   */
  async updateMemories(
    request: {
      name: string;
      scope: string;
      items: readonly MemoryInputItem[];
      previousUpdateId?: string;
      updateDelay?: number;
    },
    signal?: AbortSignal,
  ): Promise<MemoryUpdateResponse> {
    const body: Record<string, unknown> = { scope: request.scope, items: request.items };
    if (request.previousUpdateId !== undefined) {
      body.previous_update_id = request.previousUpdateId;
    }
    if (request.updateDelay !== undefined) {
      body.update_delay = request.updateDelay;
    }
    const response = await this.#send('POST', `${this.#store(request.name)}:update_memories`, {
      operation: 'update',
      body,
      signal,
    });
    return await MemoryStoreClient.#json<MemoryUpdateResponse>(response, 'update');
  }

  /** The status of one queued extraction. */
  async getUpdateResult(name: string, updateId: string, signal?: AbortSignal): Promise<MemoryUpdateResponse> {
    const path = `${this.#store(name)}/updates/${encodeURIComponent(updateId)}`;
    const response = await this.#send('GET', path, { operation: 'updateResult', signal });
    return await MemoryStoreClient.#json<MemoryUpdateResponse>(response, 'updateResult');
  }

  /**
   * Deletes every memory in `scope`.
   *
   * Answers `false` when the scope holds nothing — a scope that was never written has no resource
   * to delete, and the reference treats that 404 as success rather than as a failure to clean up.
   */
  async deleteScope(name: string, scope: string, signal?: AbortSignal): Promise<boolean> {
    const response = await this.#send('POST', `${this.#store(name)}:delete_scope`, {
      operation: 'deleteScope',
      body: { scope },
      signal,
      allowNotFound: true,
    });
    // Nothing here reads the body; draining it keeps the connection from being held open until
    // the discarded response is collected.
    await response.body?.cancel().catch(() => {});
    return response.status !== 404;
  }

  /** The store, or `undefined` when it does not exist. */
  async getMemoryStore(name: string, signal?: AbortSignal): Promise<MemoryStoreObject | undefined> {
    const response = await this.#send('GET', this.#store(name), {
      operation: 'getStore',
      signal,
      allowNotFound: true,
    });
    if (response.status === 404) {
      // The body is an error envelope, not a store; draining it keeps the connection from being
      // held open until the response is collected.
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    return await MemoryStoreClient.#json<MemoryStoreObject>(response, 'getStore');
  }

  /** Creates a store. Fails when one of the same name already exists. */
  async createMemoryStore(
    request: { name: string; definition: MemoryStoreDefinition; description?: string },
    signal?: AbortSignal,
  ): Promise<MemoryStoreObject> {
    const body: Record<string, unknown> = { name: request.name, definition: request.definition };
    if (request.description !== undefined) {
      body.description = request.description;
    }
    const response = await this.#send('POST', 'memory_stores', {
      operation: 'createStore',
      body,
      signal,
    });
    return await MemoryStoreClient.#json<MemoryStoreObject>(response, 'createStore');
  }

  /** The path of one store, with the name encoded and the action separator left intact. */
  #store(name: string): string {
    return `memory_stores/${encodeURIComponent(name)}`;
  }

  async #send(
    method: string,
    path: string,
    options: {
      operation: MemoryOperation;
      body?: unknown;
      signal?: AbortSignal | undefined;
      allowNotFound?: boolean;
    },
  ): Promise<Response> {
    const url = `${this.#endpoint}/${path}?${new URLSearchParams({ 'api-version': FOUNDRY_API_VERSION })}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.#getToken()}`,
      accept: 'application/json',
      'Foundry-Features': MEMORY_PREVIEW_FEATURE,
    };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const response = await this.#fetch(url, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok && !(options.allowNotFound === true && response.status === 404)) {
      throw await MemoryStoreClient.#failure(response, options.operation, `${method} ${path}`);
    }
    return response;
  }

  /**
   * The body as `T`.
   *
   * A `202` from `:update_memories` carries the update resource, but a service that answers a
   * successful call with no body at all must not become a parse error: memory is best-effort by
   * default, and an empty object reads downstream as "nothing to carry forward".
   */
  static async #json<T>(response: Response, operation: MemoryOperation): Promise<T> {
    const text = await response.text().catch(() => '');
    if (text.trim() === '') {
      return {} as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new FoundryMemoryError(
        operation,
        `Foundry memory returned a body that is not JSON (${response.status}).`,
        { cause: error, status: response.status },
      );
    }
  }

  /**
   * The failure to raise for a refused call.
   *
   * The service's own message is included: this runs inside a container where the error text is
   * the entire diagnostic.
   */
  static async #failure(
    response: Response,
    operation: MemoryOperation,
    what: string,
  ): Promise<FoundryMemoryError> {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    return new FoundryMemoryError(
      operation,
      `Foundry memory returned ${response.status} for ${what}.${detail === '' ? '' : ` ${detail}`}`,
      { status: response.status },
    );
  }
}
