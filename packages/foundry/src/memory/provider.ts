import type { TokenCredential } from '@azure/identity';
import { DefaultAzureCredential } from '@azure/identity';
import type {
  ContextProvider,
  Message,
  MessageFilter,
  ProviderAfterRunContext,
  ProviderRunContext,
} from '@polymind-inc/agent-framework-core';
import {
  ConfigurationError,
  externalOnly,
  passThrough,
  textContent,
  textOf,
} from '@polymind-inc/agent-framework-core';
import type { MemoryInputItem, MemoryOperation, MemoryStoreDefinition, MemoryStoreObject } from './client.js';
import { FoundryMemoryError, MemoryStoreClient } from './client.js';

/** The prefix the retrieved memories are handed to the model under. */
const DEFAULT_CONTEXT_PROMPT = '## Memories\nConsider the following memories when answering user questions:';

/** The default partition of {@link AgentSession.state} this provider writes to. */
const DEFAULT_SOURCE_ID = 'foundry_memory';

/** How many memories one search may return, unless configured otherwise. */
const DEFAULT_MAX_MEMORIES = 5;

/** How long the service waits for more conversation before extracting, in seconds. */
const DEFAULT_UPDATE_DELAY = 0;

/**
 * Which memories a run reads and writes.
 *
 * A scope is a partition, so it is required: there is no fallback to the session id, because
 * silently narrowing "what this user remembers" to "what this conversation remembers" turns a
 * misconfiguration into behaviour that looks like it works. Pass a function when the partition is
 * only known per run — a hosted container serves every user through one provider instance, and the
 * function is evaluated on each run rather than once at construction.
 */
export type FoundryMemoryScope = string | ((ctx: ProviderRunContext) => string);

/** What a memory-service failure did, for a host that wants to see it. */
export interface FoundryMemoryFailure {
  /** The call that failed. */
  readonly operation: MemoryOperation;
  /** The failure itself, usually a {@link FoundryMemoryError}. */
  readonly error: unknown;
}

/** Construction options for {@link FoundryMemoryProvider}. */
export interface FoundryMemoryProviderConfig {
  /** The memory store in the Foundry project. Create it with {@link FoundryMemoryProvider.ensureMemoryStoreCreated}. */
  memoryStoreName: string;
  /**
   * The namespace memories are partitioned by — an end-user id, a team id, whatever the
   * application's isolation boundary is. In a hosted container, use `hostedUserScope()` from
   * `@polymind-inc/agent-framework-foundry/hosting`.
   */
  scope: FoundryMemoryScope;
  /** The Foundry **project** endpoint. Defaults to `FOUNDRY_PROJECT_ENDPOINT`. */
  projectEndpoint?: string;
  /** Defaults to {@link DefaultAzureCredential}. */
  credential?: TokenCredential;
  /** This provider's session-state partition and the source stamped on injected messages. */
  sourceId?: string;
  /** Prefixed to the retrieved memories. Defaults to a "## Memories" heading. */
  contextPrompt?: string;
  /** The most memories one search may return. Defaults to 5. */
  maxMemories?: number;
  /**
   * Seconds the service waits for further conversation before extracting memories. Defaults to
   * `0` — extract immediately — so a fact stated in one run is available to the next. Raise it
   * (the service's own default is 300) to let the service batch a chatty conversation into one
   * extraction.
   */
  updateDelay?: number;
  /**
   * What a memory-service failure does to the run. `'continue'` (the default) runs the agent
   * without the memories it could not read, and drops the memories it could not write;
   * `'throw'` fails the run.
   *
   * Scope resolution is not covered by this: a scope that cannot be resolved, or that changed
   * under an existing session, always throws. That is an isolation boundary, not a degraded
   * augmentation.
   */
  failureMode?: 'continue' | 'throw';
  /**
   * Called for every memory-service failure, in both failure modes.
   *
   * The scope is deliberately not passed: it is normally an end-user id, and a diagnostic hook is
   * exactly where such a value leaks into logs.
   */
  onFailure?: (failure: FoundryMemoryFailure) => void;
  /** Which request messages the search is built from. Defaults to caller-supplied messages only. */
  searchFilter?: MessageFilter;
  /** Which request messages are stored. Defaults to caller-supplied messages only. */
  storeRequestFilter?: MessageFilter;
  /** Which response messages are stored. Defaults to all of them. */
  storeResponseFilter?: MessageFilter;
  /** Overridable for tests and proxies. */
  fetch?: typeof globalThis.fetch;
}

/** The provider's own slice of the session, as it is serialized. */
interface MemoryState {
  /** The partition this session is pinned to. */
  scope?: string;
  /** Whether the one-off profile search has run. */
  initialized?: boolean;
  /** The profile memories, retrieved once and replayed on every later run. */
  staticMemories?: string[];
  /** Makes the next search incremental. */
  previousSearchId?: string;
  /** Makes the next update incremental. */
  previousUpdateId?: string;
}

/**
 * Gives an agent persistent, semantic memory backed by a Microsoft Foundry Memory Store.
 *
 * Before each run it searches the store for memories relevant to the conversation and injects them
 * as a single user message; after each run it sends the turn to the service, which extracts
 * memories from it asynchronously.
 *
 * ```ts
 * const memory = new FoundryMemoryProvider({
 *   projectEndpoint: process.env.FOUNDRY_PROJECT_ENDPOINT!,
 *   memoryStoreName: 'assistant-memories',
 *   scope: userId,
 * });
 * const agent = new Agent({ client, instructions: '…', contextProviders: [memory] });
 * ```
 *
 * ## Security considerations
 *
 * - **Memories are untrusted text.** They are extracted from conversations, so a memory can carry
 *   an instruction aimed at the model, and everything injected here is indistinguishable from user
 *   input once it reaches the model. Never let a memory drive an authorization decision.
 * - **The scope is the isolation boundary.** One provider instance serves every user of a hosted
 *   container, so the scope is resolved per run and then pinned to the session: a session that
 *   resolves a different scope later fails the run instead of reading another user's memories.
 * - **What goes in is what comes out.** Whatever the store is allowed to extract will be replayed
 *   into later runs, including into a later conversation. Configure the store's extraction
 *   (`userProfileDetails`) to exclude sensitive categories rather than relying on the model.
 */
export class FoundryMemoryProvider implements ContextProvider {
  readonly sourceId: string;

  readonly #client: MemoryStoreClient;
  readonly #storeName: string;
  readonly #scope: FoundryMemoryScope;
  readonly #contextPrompt: string;
  readonly #maxMemories: number;
  readonly #updateDelay: number;
  readonly #failureMode: 'continue' | 'throw';
  readonly #onFailure: ((failure: FoundryMemoryFailure) => void) | undefined;
  readonly #searchFilter: MessageFilter;
  readonly #storeRequestFilter: MessageFilter;
  readonly #storeResponseFilter: MessageFilter;

  /** The most recent queued extraction, for {@link whenUpdatesCompleted}. */
  #pendingUpdateId: string | undefined;

  constructor(config: FoundryMemoryProviderConfig) {
    if (config.memoryStoreName.trim() === '') {
      throw new ConfigurationError('FoundryMemoryProvider needs a memory store name.');
    }
    if (typeof config.scope === 'string' && config.scope.trim() === '') {
      throw new ConfigurationError('FoundryMemoryProvider needs a non-empty scope.');
    }
    const endpoint = config.projectEndpoint ?? process.env.FOUNDRY_PROJECT_ENDPOINT;
    if (endpoint === undefined || endpoint.trim() === '') {
      throw new ConfigurationError(
        'FoundryMemoryProvider needs a project endpoint. Set FOUNDRY_PROJECT_ENDPOINT or pass ' +
          '`projectEndpoint`.',
      );
    }

    this.sourceId = config.sourceId ?? DEFAULT_SOURCE_ID;
    this.#client = new MemoryStoreClient({
      projectEndpoint: endpoint,
      credential: config.credential ?? new DefaultAzureCredential(),
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    });
    this.#storeName = config.memoryStoreName;
    this.#scope = config.scope;
    this.#contextPrompt = config.contextPrompt ?? DEFAULT_CONTEXT_PROMPT;
    this.#maxMemories = config.maxMemories ?? DEFAULT_MAX_MEMORIES;
    this.#updateDelay = config.updateDelay ?? DEFAULT_UPDATE_DELAY;
    this.#failureMode = config.failureMode ?? 'continue';
    this.#onFailure = config.onFailure;
    this.#searchFilter = config.searchFilter ?? externalOnly;
    this.#storeRequestFilter = config.storeRequestFilter ?? externalOnly;
    this.#storeResponseFilter = config.storeResponseFilter ?? passThrough;
  }

  /**
   * Searches the store and injects what it finds.
   *
   * Two searches, not one: the first run of a session also asks for the scope's profile memories —
   * the durable facts that are relevant regardless of what was just said — and those are replayed
   * on every later run of the session without asking again. Each run then searches for memories
   * relevant to this turn's input.
   */
  async beforeRun(ctx: ProviderRunContext): Promise<void> {
    const state = ctx.state as MemoryState;
    const scope = this.#resolveScope(ctx, state);

    if (state.initialized !== true) {
      try {
        const result = await this.#client.searchMemories(
          { name: this.#storeName, scope, maxMemories: this.#maxMemories },
          ctx.signal,
        );
        state.staticMemories = contentsOf(result);
      } catch (error) {
        state.staticMemories = [];
        this.#failed('search', error);
      } finally {
        // Marked either way: a store that refused the profile search once will refuse it on every
        // run of this session, and retrying it per run only adds latency to each of them.
        state.initialized = true;
      }
    }

    const items = searchItems(this.#searchFilter(ctx.inputMessages));
    if (items.length === 0) {
      return;
    }

    try {
      const result = await this.#client.searchMemories(
        {
          name: this.#storeName,
          scope,
          items,
          maxMemories: this.#maxMemories,
          ...(state.previousSearchId === undefined ? {} : { previousSearchId: state.previousSearchId }),
        },
        ctx.signal,
      );
      const contextual = contentsOf(result);
      // Only a search that found something moves the incremental anchor: carrying forward the id
      // of an empty search would make the next one resume from nothing.
      if (contextual.length > 0 && typeof result.search_id === 'string') {
        state.previousSearchId = result.search_id;
      }
      const memories = [...(state.staticMemories ?? []), ...contextual];
      if (memories.length === 0) {
        return;
      }
      ctx.extendMessages([
        { role: 'user', contents: [textContent(`${this.#contextPrompt}\n${memories.join('\n')}`)] },
      ]);
    } catch (error) {
      this.#failed('search', error);
    }
  }

  /**
   * Sends the completed turn to the store.
   *
   * A failed run is not stored: its transcript is a partial exchange, and remembering a
   * conversation that did not happen is worse than remembering nothing.
   */
  async afterRun(ctx: ProviderAfterRunContext): Promise<void> {
    if (ctx.error !== undefined) {
      return;
    }
    const state = ctx.state as MemoryState;
    const scope = this.#resolveScope(ctx, state);

    const items = storageItems([
      ...this.#storeRequestFilter(ctx.inputMessages),
      ...this.#storeResponseFilter(ctx.response?.messages ?? []),
    ]);
    if (items.length === 0) {
      return;
    }

    try {
      const result = await this.#client.updateMemories(
        {
          name: this.#storeName,
          scope,
          items,
          updateDelay: this.#updateDelay,
          ...(state.previousUpdateId === undefined ? {} : { previousUpdateId: state.previousUpdateId }),
        },
        ctx.signal,
      );
      if (typeof result.update_id === 'string') {
        state.previousUpdateId = result.update_id;
        this.#pendingUpdateId = result.update_id;
      }
    } catch (error) {
      this.#failed('update', error);
    }
  }

  /**
   * Creates the memory store when it does not already exist, and reports whether it did.
   *
   * Provisioning, not a runtime path: call it from a setup script, or once at startup.
   */
  async ensureMemoryStoreCreated(
    definition: MemoryStoreDefinition,
    options: { description?: string; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const existing = await this.#client.getMemoryStore(this.#storeName, options.signal);
    if (existing !== undefined) {
      return false;
    }
    await this.#client.createMemoryStore(
      {
        name: this.#storeName,
        definition,
        ...(options.description === undefined ? {} : { description: options.description }),
      },
      options.signal,
    );
    return true;
  }

  /** The store, or `undefined` when it does not exist. */
  async getMemoryStore(signal?: AbortSignal): Promise<MemoryStoreObject | undefined> {
    return await this.#client.getMemoryStore(this.#storeName, signal);
  }

  /**
   * Deletes everything stored under `scope`, and reports whether there was anything to delete.
   *
   * The scope is explicit rather than read from a session, because deletion is not part of a run:
   * a caller erasing a user's memories has the user id, and taking it here keeps the operation
   * from depending on which session happens to be at hand.
   */
  async deleteStoredMemories(scope: string, signal?: AbortSignal): Promise<boolean> {
    return await this.#client.deleteScope(this.#storeName, scope, signal);
  }

  /**
   * Waits for the most recent extraction to finish.
   *
   * Extraction is asynchronous: `afterRun` queues it and returns, so a memory stated in one run is
   * not necessarily searchable at the start of the next one. Tests and samples that demonstrate
   * cross-run recall need this; production code generally does not, and paying for it on every
   * turn would put the service's extraction latency on the user's critical path.
   *
   * Updates are processed in order, so the newest one completing means the older ones have too.
   *
   * @throws {FoundryMemoryError} When the extraction failed.
   */
  async whenUpdatesCompleted(options: { pollIntervalMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const updateId = this.#pendingUpdateId;
    if (updateId === undefined) {
      return;
    }
    const interval = options.pollIntervalMs ?? 5000;
    for (;;) {
      options.signal?.throwIfAborted();
      const result = await this.#client.getUpdateResult(this.#storeName, updateId, options.signal);
      if (result.status === 'completed' || result.status === 'superseded') {
        // Cleared only after it completed, and only when nothing newer has been queued since.
        if (this.#pendingUpdateId === updateId) {
          this.#pendingUpdateId = undefined;
        }
        return;
      }
      if (result.status === 'failed') {
        throw new FoundryMemoryError(
          'updateResult',
          `Foundry memory update '${updateId}' failed.${result.error?.message === undefined ? '' : ` ${result.error.message}`}`,
        );
      }
      if (result.status !== 'queued' && result.status !== 'in_progress') {
        throw new FoundryMemoryError(
          'updateResult',
          `Foundry memory update '${updateId}' reported an unknown status '${String(result.status)}'.`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }
  }

  /**
   * The partition this run reads and writes, pinned to the session on first use.
   *
   * @throws {ConfigurationError} When no scope can be resolved, or when the session already
   * belongs to a different one.
   */
  #resolveScope(ctx: ProviderRunContext, state: MemoryState): string {
    const resolved = typeof this.#scope === 'string' ? this.#scope : this.#scope(ctx);
    if (typeof resolved !== 'string' || resolved.trim() === '') {
      throw new ConfigurationError(
        `FoundryMemoryProvider ('${this.sourceId}') resolved an empty memory scope. A scope is the ` +
          'isolation boundary between users; it cannot be omitted.',
      );
    }
    const pinned = state.scope;
    if (typeof pinned === 'string' && pinned !== resolved) {
      throw new ConfigurationError(
        `FoundryMemoryProvider ('${this.sourceId}') resolved a different memory scope for a session ` +
          'that is already pinned to one. A session belongs to exactly one scope; continuing would ' +
          "read and write another partition's memories.",
      );
    }
    state.scope = resolved;
    return resolved;
  }

  /** Reports a failure, and re-raises it when the provider is configured to fail closed. */
  #failed(operation: MemoryOperation, error: unknown): void {
    this.#onFailure?.({ operation, error });
    if (this.#failureMode === 'throw') {
      throw error;
    }
  }
}

/** The memory texts a search answered with, in order, dropping the blank ones. */
function contentsOf(result: { memories?: Array<{ memory_item?: { content?: string } }> }): string[] {
  return (result.memories ?? [])
    .map((memory) => memory.memory_item?.content)
    .filter((content): content is string => typeof content === 'string' && content.trim() !== '');
}

/**
 * The items a search is built from.
 *
 * Every non-empty message counts, whatever its role: a search is a similarity query, and a role
 * the memory service does not model is still text worth matching on. Roles it does model are
 * preserved; anything else is asked about as if the user had said it.
 */
function searchItems(messages: readonly Message[]): MemoryInputItem[] {
  const items: MemoryInputItem[] = [];
  for (const message of messages) {
    const content = textOf(message);
    if (content.trim() === '') {
      continue;
    }
    items.push({ type: 'message', role: storableRole(message.role) ?? 'user', content });
  }
  return items;
}

/**
 * The items a turn is stored as.
 *
 * Unlike a search, storage is selective: only the three conversational roles are remembered. A
 * tool call's arguments and results are machinery, not something the user said, and extracting
 * durable facts from them is how a store fills up with transient ids.
 */
function storageItems(messages: readonly Message[]): MemoryInputItem[] {
  const items: MemoryInputItem[] = [];
  for (const message of messages) {
    const role = storableRole(message.role);
    if (role === undefined) {
      continue;
    }
    const content = textOf(message);
    if (content.trim() === '') {
      continue;
    }
    items.push({ type: 'message', role, content });
  }
  return items;
}

/** The message role as the memory service names it, or `undefined` when it models no such role. */
function storableRole(role: string): MemoryInputItem['role'] | undefined {
  return role === 'user' || role === 'assistant' || role === 'system' ? role : undefined;
}
