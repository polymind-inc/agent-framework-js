import type { TokenCredential } from '@azure/identity';
import { DefaultAzureCredential } from '@azure/identity';
import type {
  OutputItem,
  ResponseObject,
  ResponseOwner,
  ResponseProvider,
  StoredResponse,
} from '@polymind-inc/agent-framework-agentserver';
import { platformHeaders, projectEndpoint } from '@polymind-inc/agent-framework-agentserver';
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
   * The two reference implementations disagree, which is why this is a knob rather than a
   * constant: .NET forwards it (`FoundryStorageProvider.ApplyPlatformHeaders`, whose comment says
   * the service resolves the caller context from it), Python does not — its storage pipeline
   * carries a bearer token and nothing else. Measured against a live project, the header makes no
   * difference to whether a write succeeds, so the default stays with .NET rather than moving on
   * a hypothesis that did not hold.
   */
  forwardCallId?: boolean;
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
 * ## No retry, timeout or abort — and why
 *
 * Every call here is a bare `fetch`: one attempt, no backoff, no deadline, no `signal`. Both
 * references get retry from their platform HTTP stack — Python builds an `AsyncPipelineClient`
 * with `policies.AsyncRetryPolicy()` (`store/_foundry_provider.py:181-204`), .NET a
 * `ClientOptions`-derived `HttpPipeline` (`Internal/FoundryStorageClientOptions.cs`) — so a
 * faithful port is not a flag but a policy: attempt count, exponential backoff, `Retry-After`,
 * the retryable-status set, and a decision about retrying a **non-idempotent** `POST responses`.
 * A retry policy is deliberately not implemented yet. It would also be the wrong first move here:
 * this write path was measured answering `500` against a live project, and `500` is *in* the
 * retryable set, so a retry policy would multiply the one failure that has actually been observed.
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
 * @remarks
 * The routes, verbs, `api-version` and request envelope all match
 * `azure-ai-agentserver-responses`' `FoundryStorageProvider` and .NET's, field for field
 * (`POST responses` to create, `POST responses/{id}` to update, `GET`/`DELETE responses/{id}`,
 * `GET responses/{id}/input_items`).
 *
 * **The read path is verified against a live project; the write path fails there.**
 * `POST /storage/responses` answers an opaque `500` — from a workstation *and* from inside a
 * deployed container, with and without the call id. The same route answers `400 Invalid payload`
 * for a malformed body, so the service accepts this envelope as well-formed and then fails behind
 * its own validation; there is no remaining client-side variable to change. That is why
 * `ResponsesHostServer` defaults to the sandbox filesystem and this store is opt-in.
 */
export class FoundryResponseStore implements ResponseProvider {
  readonly #endpoint: string;
  readonly #getToken: () => Promise<string>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #forwardCallId: boolean;

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
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.#getToken()}`,
      accept: 'application/json',
      // Attached per call, never captured at construction: one container serves many users, so
      // anything request-scoped has to come from the request in flight.
      ...(this.#forwardCallId ? platformHeaders() : {}),
    };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    return this.#fetch(this.#url(path, options.query ?? {}), {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
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

  async get(id: string, _owner: ResponseOwner): Promise<StoredResponse | undefined> {
    const response = await this.#request('GET', `responses/${encodeURIComponent(id)}`);
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw await FoundryResponseStore.#failure(response, `GET responses/${id}`);
    }
    // The service stores the response resource itself; input items are a separate route.
    const stored = (await response.json()) as ResponseObject;
    return { response: stored, inputItems: await this.#inputItems(id) };
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
    const body: CreateBody = {
      response: stored.response,
      input_items: stored.inputItems ?? [],
      history_item_ids: [],
    };

    const created = await this.#request('POST', 'responses', { body });
    if (created.ok) {
      return;
    }
    const createdBody = await FoundryResponseStore.#body(created);
    const conflict = created.status === 409 || (created.status === 400 && isDuplicateCreate(createdBody));
    if (!conflict) {
      throw FoundryResponseStore.#failureFrom(created.status, createdBody, 'POST responses');
    }

    const updated = await this.#request('POST', `responses/${encodeURIComponent(stored.response.id)}`, {
      body: stored.response,
    });
    if (!updated.ok) {
      throw await FoundryResponseStore.#failure(updated, `POST responses/${stored.response.id}`);
    }
  }

  async delete(id: string, _owner: ResponseOwner): Promise<boolean> {
    const response = await this.#request('DELETE', `responses/${encodeURIComponent(id)}`);
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw await FoundryResponseStore.#failure(response, `DELETE responses/${id}`);
    }
    return true;
  }

  async history(id: string, owner: ResponseOwner): Promise<OutputItem[] | undefined> {
    const stored = await this.get(id, owner);
    // The service also exposes `history/item_ids` and `items/batch/retrieve` for this, which would
    // avoid re-reading the response. Their payload shapes are not verified here, so the transcript
    // is assembled from the two routes that are.
    return stored === undefined ? undefined : [...(stored.inputItems ?? []), ...stored.response.output];
  }
}
