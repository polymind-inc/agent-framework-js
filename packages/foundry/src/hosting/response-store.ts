import type { TokenCredential } from '@azure/identity';
import { DefaultAzureCredential } from '@azure/identity';
import type {
  OutputItem,
  ResponseEvent,
  ResponseGeneration,
  ResponseObject,
  ResponseOwner,
  ResponseProvider,
  StoredResponse,
} from '@polymind-inc/agent-framework-agentserver';
import {
  FileResponseProvider,
  historyOf,
  ID_PREFIX,
  platformHeaders,
  projectEndpoint,
  resolveAgentReference,
  stateRoot,
} from '@polymind-inc/agent-framework-agentserver';
import { ConfigurationError } from '@polymind-inc/agent-framework-core';
import { tokenProvider } from '../credential.js';
import { FOUNDRY_API_VERSION, normalizeProjectEndpoint } from '../target.js';

/** Construction options for {@link FoundryResponseStore}. */
export interface FoundryResponseStoreConfig {
  /**
   * The Foundry **project** endpoint — not a storage URL. Defaults to `FOUNDRY_PROJECT_ENDPOINT`.
   *
   * `/storage/` is appended unconditionally, so a value that already ends in `/storage` produces
   * `.../storage/storage/`. That is deliberate parity, not an oversight: both response-store
   * references append without looking (Python `store/_foundry_settings.py:55`
   * `endpoint.rstrip("/") + "/storage/"`, .NET `ResponsesServerServiceCollectionExtensions.cs:170`
   * `uri...TrimEnd('/') + "/storage/"`), and the platform never sets `FOUNDRY_PROJECT_ENDPOINT` to
   * a storage URL. .NET's *shared* `FoundryStorageEndpoint.FromEndpoint`
   * (`AgentServer.Core/src/Storage/FoundryStorageEndpoint.cs:77-79`) does skip a `/storage` suffix,
   * but it documents its parameter as "the project endpoint **or** a full `.../storage` URL" — a
   * wider contract, for the state store, which this package does not have. Narrowing the accepted
   * form keeps a misconfigured endpoint a visible 404 rather than something silently repaired.
   */
  projectEndpoint?: string;
  /** Defaults to {@link DefaultAzureCredential}. */
  credential?: TokenCredential;
  /** Overridable for tests and proxies. */
  fetch?: typeof globalThis.fetch;
  /**
   * Whether to forward `x-agent-foundry-call-id` on storage requests. Defaults to `true`.
   *
   * Leave it on. Measured against a live project from inside a hosted container: a write
   * **without** the call id fails with the service's opaque 500, and the same write with it
   * succeeds — the service resolves the caller context from the header, exactly as the .NET
   * provider's comment says (`FoundryStorageProvider.ApplyPlatformHeaders`; Python's
   * `_apply_platform_headers` forwards the same single header). The knob exists for diagnostics,
   * not because the header is optional in practice.
   */
  forwardCallId?: boolean;
  /**
   * Where the local replay mirror lives — the store's half of the split described in the class
   * documentation ("Events live beside the sandbox"). Defaults to
   * `${stateRoot()}/foundry-responses`: beside the sandbox state, in its own directory so it can
   * never collide with a `FileResponseProvider` a host might also be running.
   */
  replayRoot?: string;
  /**
   * Bounded retry for transient storage failures: three attempts total, exponential backoff with
   * this base (default 500ms, so 500ms then 1s — pass `0` in tests to disable the wait).
   * Statuses 408, 429, 500, 502, 503 and 504 and thrown network errors are retried, matching the
   * reference pipeline's policy; everything else surfaces immediately.
   */
  retry?: { baseDelayMs?: number };
}

/**
 * The service's create body: the response plus what belongs to this turn.
 *
 * Both lists are always present, empty included — the reference serializer sends them
 * unconditionally (`serialize_create_request`).
 */
interface CreateBody {
  response: ResponseObject;
  input_items: OutputItem[];
  history_item_ids: string[];
}

/**
 * The `error.code` values the service uses for a duplicate create.
 *
 * Verbatim from the reference's `_is_conflict`
 * (`azure-ai-agentserver-responses/.../store/_foundry_provider.py:41-61`).
 */
const CONFLICT_CODES = new Set(['conflict', 'already_exists', 'duplicate']);

/**
 * Whether a failed create is the service saying *this id already exists*.
 *
 * **The status line alone is not the signal.** The reference maps HTTP 400 *and* 409 to the same
 * `FoundryBadRequestError` (`store/_foundry_errors.py:59-62`) and then separates a duplicate create
 * from a genuine bad request by the body — `error.code` in {@link CONFLICT_CODES}, or the phrase
 * `already exists` in `error.message` (`store/_foundry_provider.py:280`). Reading only the status
 * would turn a 400-flavoured conflict into a lost turn.
 *
 * A body that is not the Foundry error envelope is *not* a conflict: the reference's message in
 * that case is its own generated fallback (`_foundry_errors.py:96`), which matches neither test.
 */
function isDuplicateCreate(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return false;
  }
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && CONFLICT_CODES.has(code.toLowerCase())) {
    return true;
  }
  return typeof message === 'string' && message.toLowerCase().includes('already exists');
}

/** The statuses worth another attempt, matching the reference retry policy's set. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/** The total request budget per call, including the first attempt. */
const RETRY_ATTEMPTS = 3;

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/** The ids of a response's output items, in order. */
function outputIds(response: ResponseObject): string[] {
  return (Array.isArray(response.output) ? response.output : [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === 'string');
}

/**
 * Whether the local mirror record and the service's answer describe the same turn.
 *
 * `created_at` alone is whole-second, so a delete-and-recreate of one id can land on the same
 * value. The first output item id breaks the tie: the service rejects a duplicate item id
 * outright (measured), so two turns can never share one. Two *outputless* turns of one id in one
 * second remain indistinguishable — the residual window is a turn with no output, replaced
 * within the same second, replayed from another sandbox.
 */
function sameTurn(local: ResponseObject, remote: ResponseObject): boolean {
  return (
    typeof local.created_at === 'number' &&
    local.created_at === remote.created_at &&
    local.status === remote.status &&
    outputIds(local)[0] === outputIds(remote)[0]
  );
}

/**
 * Keeps responses in the Foundry platform's storage service.
 *
 * The hosted implementation of `ResponseProvider`. It lives here rather than in
 * `@polymind-inc/agent-framework-agentserver` because it is an authenticated client for a specific Azure
 * service, not part of the protocol: the protocol package defines `ResponseProvider` and ships the
 * memory and file implementations, and stays dependency-free.
 *
 * ## Security considerations
 *
 * - Every call carries the managed-identity bearer token, and by default
 *   `x-agent-foundry-call-id` — see {@link FoundryResponseStoreConfig.forwardCallId}. Both come
 *   from the request in flight, never from construction time, because one long-lived store serves
 *   every user the container handles.
 * - `x-agent-user-id` is deliberately not sent — see `platformHeaders`. It is a global cross-agent
 *   identifier, and the service does not accept it. This is also why the `owner` argument every
 *   `ResponseProvider` method takes is accepted but not applied here: the partition is enforced
 *   service-side, before this client sees anything. The parameter stays in the signature because
 *   the abstraction — not the implementation — is what has to carry the guarantee for the stores
 *   that *can* be reached across users.
 * - A stored response holds the whole conversation. It is protected by the project's access
 *   control, not by anything this client does.
 *
 * ## Retry, but no timeout or abort
 *
 * Transient failures get a bounded retry (see {@link FoundryResponseStoreConfig.retry}), the way
 * both references get one from their platform HTTP stack — Python an `AsyncPipelineClient` with
 * `policies.AsyncRetryPolicy()` (`store/_foundry_provider.py:181-204`), .NET a
 * `ClientOptions`-derived `HttpPipeline`. Retrying the **non-idempotent** `POST responses` is
 * safe here for the same reason it is in Python: a create that landed before its response was
 * lost answers the retry as a duplicate, which `put` already treats as the update branch.
 *
 * **Abort propagation is a separate claim, and it does not hold.** Neither reference cancels a
 * storage call from the request. Python's provider takes no cancellation argument at all; .NET's
 * takes `CancellationToken cancellationToken = default` on every method and its hosting layer
 * passes one at **zero** call sites — every `_provider.CreateResponseAsync` /
 * `UpdateResponseAsync` / `GetResponseAsync` / `DeleteResponseAsync` in
 * `Internal/ResponseOrchestrator.cs` (:377, :569, :574, :898, :904) supplies only the platform
 * context, leaving `CancellationToken.None`. That is the safe reading: aborting a *terminal*
 * persist when a client hangs up is how a finished turn becomes an unrecoverable one, which is
 * also why background runs are independent of the request signal to begin with. Threading a
 * `signal` through `ResponseProvider` would therefore be a deviation, not parity.
 *
 * ## The write path needs the agent reference, and the credential decides everything
 *
 * Two facts, both measured against a live project (2026-08-08):
 *
 * - The service validates that every `POST responses` / `POST responses/{id}` body carries an
 *   `agent_reference` with a non-empty `name` — and rejects one without it as an **opaque
 *   `500`**, not a diagnosable 400. The name is not checked for existence. Python documents the
 *   same service behaviour (`_build_server_error_payload`: the crash marker "MUST stamp it or the
 *   failed terminal never persists"). `put` therefore stamps {@link resolveAgentReference}'s
 *   fallback onto a response that arrives without one, instead of letting the turn die opaquely.
 * - Writes are gated on the **hosted-agent credential**. From a workstation login, every storage
 *   write answers the same opaque `500` regardless of payload (the tasks API states the rule
 *   honestly: `403 hosted_agent_required`); from inside a deployed container with the managed
 *   identity, the same writes succeed. This store is therefore only expected to work in a hosted
 *   container — which is where it runs.
 *
 * One more measured rule: an update on a response already in a terminal state answers
 * `400 "…terminal state"`. The protocol writes each turn's terminal exactly once, so the branch
 * is not special-cased here; it surfaces as the storage failure it is.
 *
 * ## Events live beside the sandbox, not in the service
 *
 * The storage service has **no events API**. The current reference (Python
 * `azure-ai-agentserver` 2.0.0) persists a background response's stream events on the sandbox
 * filesystem and only the response resource in the service; this store makes the same split with
 * a local {@link FileResponseProvider} mirror. `put`/`get`/`delete` keep the mirror in step so
 * the {@link ResponseProvider.putEvents} generation fence works exactly as it does for the file
 * store, and a sandbox that never saw the turn fails closed: the replay log is discarded rather
 * than fabricated, the same durability the reference offers. Every mirror access is
 * **best-effort**: a missing, unreadable or unwritable mirror only makes stream replay
 * unavailable — it never fails the response operation the service already answered.
 *
 * @remarks
 * The routes, verbs, `api-version` and request envelope all match
 * `azure-ai-agentserver-responses`' `FoundryStorageProvider` and .NET's, field for field
 * (`POST responses` to create, `POST responses/{id}` to update, `GET`/`DELETE responses/{id}`,
 * `GET responses/{id}/input_items`, `GET history/item_ids` and `POST items/batch/retrieve` for
 * conversation resolution).
 */
export class FoundryResponseStore implements ResponseProvider {
  /**
   * `true`: the service links a response to its conversation from the resource's `conversation`
   * field, and {@link history} resolves a conversation id through the service's own routes. The
   * alias record local stores use would re-send stored item ids, which the service rejects.
   */
  readonly linksConversationsServiceSide = true;

  readonly #endpoint: string;
  readonly #getToken: () => Promise<string>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #forwardCallId: boolean;
  /** The local half of the split: the replay log and the generation fence. */
  readonly #replay: FileResponseProvider;
  readonly #retryBaseDelayMs: number;

  constructor(options: FoundryResponseStoreConfig = {}) {
    const endpoint = options.projectEndpoint ?? projectEndpoint();
    if (endpoint === undefined) {
      throw new ConfigurationError(
        'FoundryResponseStore needs a project endpoint. Set FOUNDRY_PROJECT_ENDPOINT or pass ' +
          '`projectEndpoint`.',
      );
    }
    this.#endpoint = normalizeProjectEndpoint(endpoint);
    this.#getToken = tokenProvider(options.credential ?? new DefaultAzureCredential());
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#forwardCallId = options.forwardCallId ?? true;
    this.#replay = new FileResponseProvider({
      root: options.replayRoot ?? `${stateRoot()}/foundry-responses`,
    });
    this.#retryBaseDelayMs = options.retry?.baseDelayMs ?? 500;
  }

  /** The storage base URL, for diagnostics. */
  get baseUrl(): string {
    return `${this.#endpoint}/storage/`;
  }

  #url(path: string, extra: Record<string, string> = {}): string {
    const query = new URLSearchParams({ 'api-version': FOUNDRY_API_VERSION, ...extra });
    return `${this.baseUrl}${path}?${query.toString()}`;
  }

  async #request(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string> } = {},
  ): Promise<Response> {
    return (await this.#attempt(method, path, options)).response;
  }

  /**
   * One request through the bounded retry.
   *
   * `ambiguous` is `true` when an earlier attempt failed in a way that says nothing about whether
   * the service applied it — a dropped connection, or a retryable status — which is the only
   * situation in which a later "already exists" may describe *this* write rather than a
   * collision.
   */
  async #attempt(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string> } = {},
  ): Promise<{ response: Response; ambiguous: boolean }> {
    let ambiguous = false;
    for (let attempt = 0; ; attempt++) {
      const last = attempt === RETRY_ATTEMPTS - 1;
      // Rebuilt per attempt: the token may have refreshed, and the platform headers belong to the
      // request in flight, never to construction time — one container serves many users.
      const headers: Record<string, string> = {
        authorization: `Bearer ${await this.#getToken()}`,
        accept: 'application/json',
        ...(this.#forwardCallId ? platformHeaders() : {}),
      };
      if (options.body !== undefined) {
        headers['content-type'] = 'application/json';
      }
      try {
        const response = await this.#fetch(this.#url(path, options.query ?? {}), {
          method,
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });
        if (last || !RETRYABLE_STATUSES.has(response.status)) {
          return { response, ambiguous };
        }
        ambiguous = true;
      } catch (error) {
        // A network-level failure is transient by definition; the last one surfaces as-is.
        if (last) {
          throw error;
        }
        ambiguous = true;
      }
      await delay(this.#retryBaseDelayMs * 2 ** attempt);
    }
  }

  /**
   * The failure to raise for a storage response that did not succeed.
   *
   * The service's own message is included. Without it a failure reads only as
   * `Foundry storage returned 500`, which says nothing about whether the payload was wrong, the
   * caller unresolvable, or the service down — and this runs inside a container where attaching a
   * debugger is not an option, so the error text is the entire diagnostic.
   */
  static async #failure(response: Response, what: string): Promise<Error> {
    return FoundryResponseStore.#failureFrom(
      response.status,
      await FoundryResponseStore.#body(response),
      what,
    );
  }

  /**
   * The response body as text, or `''` when it cannot be read.
   *
   * A body is consumable once, so a caller that has to *inspect* it (the create-conflict branch)
   * reads it here and hands the same string to {@link #failureFrom} rather than re-reading.
   */
  static async #body(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      // A body that cannot be read must not replace the status with a read error.
      return '';
    }
  }

  static #failureFrom(status: number, body: string, what: string): Error {
    const detail = body.slice(0, 500);
    return new Error(`Foundry storage returned ${status} for ${what}.${detail === '' ? '' : ` ${detail}`}`);
  }

  async get(id: string, owner: ResponseOwner): Promise<StoredResponse | undefined> {
    const response = await this.#request('GET', `responses/${encodeURIComponent(id)}`);
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw await FoundryResponseStore.#failure(response, `GET responses/${id}`);
    }
    // The service stores the response resource itself; input items are a separate route, and the
    // local mirror read is independent of both.
    const stored = (await response.json()) as ResponseObject;
    const [inputItems, local] = await Promise.all([this.#inputItems(id), this.#mirrorRecord(id, owner)]);
    const result: StoredResponse = { response: stored, inputItems };
    // The events contract requires the generation to round-trip through `put` and `get` — but
    // only when the mirror still describes the turn the service answered with (see {@link
    // sameTurn}); a stale record's generation would replay the *old* turn's events as the new
    // stream. No mirror record, or a mismatched one, simply means no generation.
    if (local !== undefined && sameTurn(local.response, stored)) {
      if (local.generation !== undefined) {
        result.generation = local.generation;
      }
      if (local.userId !== undefined) {
        result.userId = local.userId;
      }
    }
    return result;
  }

  /** The mirror record, or `undefined` when it is missing or unreadable (replay then fails closed). */
  async #mirrorRecord(id: string, owner: ResponseOwner): Promise<StoredResponse | undefined> {
    try {
      return await this.#replay.get(id, owner);
    } catch {
      return undefined;
    }
  }

  /**
   * Reads *all* input items, following the pagination cursor.
   *
   * One page holds at most 100 items while a long conversation's transcript can exceed that;
   * stopping after the first page would silently hand the model a truncated history. A failed
   * page is an error, not an empty list — the caller must not mistake a flaky read for a short
   * conversation.
   */
  async #inputItems(id: string): Promise<OutputItem[]> {
    const items: OutputItem[] = [];
    let after: string | undefined;
    for (;;) {
      const response = await this.#request('GET', `responses/${encodeURIComponent(id)}/input_items`, {
        query: { limit: '100', order: 'asc', ...(after === undefined ? {} : { after }) },
      });
      if (!response.ok) {
        throw await FoundryResponseStore.#failure(response, `GET responses/${id}/input_items`);
      }
      const body = (await response.json()) as {
        data?: OutputItem[];
        has_more?: boolean;
        last_id?: string | null;
      };
      const page = body.data ?? [];
      items.push(...page);
      const lastId = body.last_id ?? page[page.length - 1]?.id;
      if (body.has_more !== true || page.length === 0 || typeof lastId !== 'string') {
        return items;
      }
      after = lastId;
    }
  }

  /**
   * Creates the response, falling back to an update when it already exists.
   *
   * The service separates the two (`POST responses` vs `POST responses/{id}`) while
   * `ResponseProvider` has one `put`, so the duplicate-create signal is the branch point rather
   * than an error.
   *
   * **That signal is not one status code.** The reference recognises it on 409 *and* on 400 with a
   * conflict body — see {@link isDuplicateCreate}. A bare 409 stays unconditional here, which is
   * the one place this is deliberately broader than the reference: Python's `create_response`
   * *swallows* the conflict, so a false positive there hides a real failure, whereas this `put`
   * *answers* it with an update whose own failure is reported. A false negative, by contrast,
   * loses the turn. When the branch is wrong the update call reports its own status; when the
   * throw is wrong the conversation is gone.
   */
  async put(stored: StoredResponse): Promise<void> {
    // The service rejects a write whose response names no agent — as an opaque 500 — so the
    // reference is always resolved here: the protocol layer stamps every resource it builds, and
    // this re-resolution is the net for direct callers (a well-formed reference rebuilds as-is).
    const response = {
      ...stored.response,
      agent_reference: resolveAgentReference(stored.response.agent_reference),
    };
    // Items the service already holds travel as references. Re-sending one under its own id
    // makes the create fail — with an "already exists" body that reads like a duplicate-create,
    // which is why the split is done here and not diagnosed later.
    const historyIds = new Set(stored.historyItemIds ?? []);
    const body: CreateBody = {
      response,
      input_items: (stored.inputItems ?? []).filter(
        (item) => typeof item.id !== 'string' || !historyIds.has(item.id),
      ),
      history_item_ids: [...historyIds],
    };

    await this.#writeRemote(response, body);
    // Every successful remote write funnels through this one call: the mirror is what the
    // generation fence compares against, so a success path that skipped it would break replay.
    await this.#mirror(stored);
  }

  /** Writes the response to the service — create, else update — resolving on success. */
  async #writeRemote(response: ResponseObject, body: CreateBody): Promise<void> {
    const created = await this.#attempt('POST', 'responses', { body });
    if (created.response.ok) {
      return;
    }
    const createdBody = await FoundryResponseStore.#body(created.response);
    const conflict =
      created.response.status === 409 || (created.response.status === 400 && isDuplicateCreate(createdBody));
    if (!conflict) {
      throw FoundryResponseStore.#failureFrom(created.response.status, createdBody, 'POST responses');
    }

    const updated = await this.#request('POST', `responses/${encodeURIComponent(response.id)}`, {
      body: response,
    });
    if (updated.status === 404) {
      // The conflict reading was wrong: nothing exists under this id, so the create failed for a
      // reason its "already exists"-flavoured body obscured (a duplicate *item*, most likely).
      // The create's own answer is the true diagnostic, not this 404.
      throw FoundryResponseStore.#failureFrom(created.response.status, createdBody, 'POST responses');
    }
    if (updated.ok) {
      return;
    }
    // A refused update after a conflicted create is a failure — unless an earlier attempt of
    // *this* create failed ambiguously (its answer was lost on the wire) and what the service
    // holds is exactly the outcome this write described. A clean conflict is an id collision:
    // reconciliation is not even attempted, or another turn's outcome could be claimed as ours.
    if (!(created.ambiguous && (await this.#alreadyApplied(response)))) {
      throw await FoundryResponseStore.#failure(updated, `POST responses/${response.id}`);
    }
  }

  /** Whether the stored record under this id is the very outcome this write described. */
  async #alreadyApplied(response: ResponseObject): Promise<boolean> {
    try {
      const existing = await this.#request('GET', `responses/${encodeURIComponent(response.id)}`);
      if (!existing.ok) {
        return false;
      }
      const parsed = (await existing.json()) as ResponseObject;
      // Identity, not plausibility: the fields that describe the turn's outcome all have to
      // match. Output is compared by item ids — the service enforces their uniqueness, so a
      // different turn can never share them, while echoed items may gain normalized fields.
      return (
        parsed.created_at === response.created_at &&
        parsed.status === response.status &&
        JSON.stringify(outputIds(parsed)) === JSON.stringify(outputIds(response)) &&
        JSON.stringify(parsed.error ?? null) === JSON.stringify(response.error ?? null) &&
        JSON.stringify(parsed.incomplete_details ?? null) ===
          JSON.stringify(response.incomplete_details ?? null)
      );
    } catch {
      // The reconciliation read is an extra chance to recognize success, never a new failure
      // mode: when it cannot answer, the update's own error stands.
      return false;
    }
  }

  /**
   * Records the turn locally after the service accepted it, so the generation fence has something
   * to compare against. Written *after* the service write on purpose: a mirror of a write the
   * service refused would let a replay log attach to a turn that never existed.
   *
   * Best-effort, like every mirror access: a mirror the sandbox cannot write must not turn a
   * durably persisted response into a reported storage failure. On a failed write the stale
   * record is dropped instead, so replay fails closed while the turn does not.
   *
   * Only the fence fields are kept — `created_at`, `status`, the first output item stub,
   * `generation`, `userId`. The transcript itself lives in the service; mirroring it too would
   * rewrite the whole conversation to local disk on every turn, growing by a turn each turn.
   */
  async #mirror(stored: StoredResponse): Promise<void> {
    const marker = (Array.isArray(stored.response.output) ? stored.response.output : [])
      .slice(0, 1)
      .map((item) => ({ type: item.type, id: item.id }));
    try {
      await this.#replay.put({
        ...stored,
        inputItems: [],
        historyItemIds: [],
        response: { ...stored.response, output: marker as OutputItem[] },
      });
    } catch {
      try {
        await this.#replay.delete(stored.response.id, stored.userId);
      } catch {
        // The directory itself is unwritable; there is no record to drop.
      }
    }
  }

  async delete(id: string, owner: ResponseOwner): Promise<boolean> {
    const response = await this.#request('DELETE', `responses/${encodeURIComponent(id)}`);
    if (!response.ok && response.status !== 404) {
      throw await FoundryResponseStore.#failure(response, `DELETE responses/${id}`);
    }
    // The replay log and its fence go with the response either way — even on a 404, because the
    // service and the sandbox can disagree after a recycle, and a stale local log must not
    // survive the id it belonged to. Best-effort: an uncleanable mirror does not undo the
    // service-side delete.
    try {
      await this.#replay.delete(id, owner);
    } catch {
      // Replay for this id already fails closed without the mirror.
    }
    return response.status !== 404;
  }

  async putEvents(
    id: string,
    owner: ResponseOwner,
    events: readonly ResponseEvent[],
    generation: ResponseGeneration,
  ): Promise<void> {
    // The mirror record written by `put` is the fence: the delegate compares generations under
    // its per-id queue, exactly as the file store does.
    await this.#replay.putEvents(id, owner, events, generation);
  }

  async getEvents(
    id: string,
    owner: ResponseOwner,
    generation: ResponseGeneration,
  ): Promise<ResponseEvent[] | undefined> {
    // Best-effort read: an unreadable log answers as no log, never as a failed route.
    try {
      return await this.#replay.getEvents(id, owner, generation);
    } catch {
      return undefined;
    }
  }

  async history(id: string, owner: ResponseOwner): Promise<OutputItem[] | undefined> {
    // A response id resolves from its own record; a conversation id through the service's own
    // linkage (no alias record exists — see `linksConversationsServiceSide`). The prefix decides
    // which to try first, so the common case pays one lookup instead of a guaranteed miss; the
    // other path stays as the fallback for an id shape this guess got wrong.
    if (id.startsWith(`${ID_PREFIX.response}_`)) {
      return (await this.#recordHistory(id, owner)) ?? (await this.#conversationHistory(id));
    }
    return (await this.#conversationHistory(id)) ?? (await this.#recordHistory(id, owner));
  }

  /** The transcript of one stored response, or `undefined` when the id is not a response. */
  async #recordHistory(id: string, owner: ResponseOwner): Promise<OutputItem[] | undefined> {
    const stored = await this.get(id, owner);
    return stored === undefined ? undefined : historyOf(stored);
  }

  /** The transcript of a conversation, or `undefined` when the conversation is unknown. */
  async #conversationHistory(id: string): Promise<OutputItem[] | undefined> {
    const ids = await this.#historyItemIds(id);
    if (ids === undefined) {
      return undefined;
    }
    if (ids.length === 0) {
      return [];
    }
    const retrieved = await this.#request('POST', 'items/batch/retrieve', {
      body: { item_ids: ids },
    });
    if (!retrieved.ok) {
      throw await FoundryResponseStore.#failure(retrieved, 'POST items/batch/retrieve');
    }
    // The service preserves order and answers a missing id with a null gap.
    const items = (await retrieved.json()) as Array<OutputItem | null>;
    return items.filter((item): item is OutputItem => item !== null && typeof item === 'object');
  }

  /** The conversation's transcript item ids, or `undefined` when the conversation is unknown. */
  async #historyItemIds(conversationId: string): Promise<string[] | undefined> {
    const response = await this.#request('GET', 'history/item_ids', {
      // The page size mirrors the input_items read; the route answers a bare array.
      query: { limit: '100', conversation_id: conversationId },
    });
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw await FoundryResponseStore.#failure(response, 'GET history/item_ids');
    }
    const ids = (await response.json()) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  }
}
