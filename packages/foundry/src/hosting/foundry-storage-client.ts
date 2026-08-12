import type { TokenCredential } from '@azure/identity';
import { DefaultAzureCredential } from '@azure/identity';
import { platformHeaders } from '@polymind-inc/agent-framework-agentserver';
import { tokenProvider } from '../credential.js';
import { FOUNDRY_API_VERSION, normalizeProjectEndpoint } from '../target.js';

/** The statuses worth another attempt, matching the reference retry policy's set. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/** The total request budget per call, including the first attempt. */
const RETRY_ATTEMPTS = 3;

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

interface FoundryStorageClientConfig {
  credential?: TokenCredential;
  fetch?: typeof globalThis.fetch;
  forwardCallId?: boolean;
  retry?: { baseDelayMs?: number };
}

interface FoundryStorageRequestOptions {
  body?: unknown;
  query?: Record<string, string>;
}

export interface FoundryStorageAttempt {
  response: Response;
  /** Whether an earlier attempt may have reached the service despite its failed answer. */
  ambiguous: boolean;
}

/**
 * The authenticated HTTP transport for the Foundry response storage service.
 *
 * This layer owns endpoint construction, per-attempt credentials and platform headers, bounded
 * transient retry, and diagnostic error bodies. The response provider owns the storage semantics
 * built on top: create-versus-update, history pagination, write reconciliation and replay fencing.
 */
export class FoundryStorageClient {
  readonly #endpoint: string;
  readonly #getToken: () => Promise<string>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #forwardCallId: boolean;
  readonly #retryBaseDelayMs: number;

  constructor(projectEndpoint: string, options: FoundryStorageClientConfig = {}) {
    this.#endpoint = normalizeProjectEndpoint(projectEndpoint);
    this.#getToken = tokenProvider(options.credential ?? new DefaultAzureCredential());
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#forwardCallId = options.forwardCallId ?? true;
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

  async request(method: string, path: string, options: FoundryStorageRequestOptions = {}): Promise<Response> {
    return (await this.attempt(method, path, options)).response;
  }

  /**
   * One request through the bounded retry.
   *
   * `ambiguous` is `true` when an earlier attempt failed in a way that says nothing about whether
   * the service applied it — a dropped connection, or a retryable status — which is the only
   * situation in which a later "already exists" may describe *this* write rather than a
   * collision.
   */
  async attempt(
    method: string,
    path: string,
    options: FoundryStorageRequestOptions = {},
  ): Promise<FoundryStorageAttempt> {
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
        // A discarded response's body would otherwise hold its connection until GC; cancelling
        // is best-effort resource hygiene, never a failure.
        await response.body?.cancel().catch(() => {});
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
  async failure(response: Response, what: string): Promise<Error> {
    return this.failureFrom(response.status, await this.body(response), what);
  }

  /**
   * The response body as text, or `''` when it cannot be read.
   *
   * A body is consumable once, so a caller that has to *inspect* it (the create-conflict branch)
   * reads it here and hands the same string to {@link failureFrom} rather than re-reading.
   */
  async body(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      // A body that cannot be read must not replace the status with a read error.
      return '';
    }
  }

  failureFrom(status: number, body: string, what: string): Error {
    const detail = body.slice(0, 500);
    return new Error(`Foundry storage returned ${status} for ${what}.${detail === '' ? '' : ` ${detail}`}`);
  }
}
