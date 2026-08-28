import { platformHeaders } from '@polymind-inc/agent-framework-agentserver';
import { bodyText, drainBody, foundryFailureMessage, foundryRequestInit, foundryUrl } from '../http.js';
import type { FoundryProject } from '../project.js';
import { sleep } from '../sleep.js';

/** The statuses worth another attempt, matching the reference retry policy's set. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/** The total request budget per call, including the first attempt. */
const RETRY_ATTEMPTS = 3;

/**
 * The backoff before the next attempt. A configured base delay of `0` means no waiting at all —
 * not even a zero-millisecond timer task — which is a different zero than {@link sleep}'s (whose
 * zero still hops through the timer so aborts land and poll loops yield).
 */
function retryDelay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : sleep(ms);
}

interface FoundryStorageClientConfig {
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
  readonly #project: FoundryProject;
  readonly #fetch: typeof globalThis.fetch;
  readonly #forwardCallId: boolean;
  readonly #retryBaseDelayMs: number;

  constructor(project: FoundryProject, options: FoundryStorageClientConfig = {}) {
    this.#project = project;
    this.#fetch = options.fetch ?? project.fetch ?? globalThis.fetch;
    this.#forwardCallId = options.forwardCallId ?? true;
    this.#retryBaseDelayMs = options.retry?.baseDelayMs ?? 500;
  }

  /** The storage base URL, for diagnostics. */
  get baseUrl(): string {
    return `${this.#project.endpoint}/storage/`;
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
      let token: string;
      try {
        token = await this.#project.getToken();
      } catch (error) {
        // Credential refresh is transient too, but no request reached the service, so it cannot
        // make a later conflict ambiguous.
        if (last) throw error;
        await retryDelay(this.#retryBaseDelayMs * 2 ** attempt);
        continue;
      }
      try {
        const response = await this.#fetch(
          foundryUrl(this.baseUrl, path, options.query ?? {}),
          foundryRequestInit(method, token, {
            ...(this.#forwardCallId ? { headers: platformHeaders() } : {}),
            body: options.body,
          }),
        );
        if (last || !RETRYABLE_STATUSES.has(response.status)) {
          return { response, ambiguous };
        }
        ambiguous = true;
        await drainBody(response);
      } catch (error) {
        // A network-level failure is transient by definition; the last one surfaces as-is.
        if (last) {
          throw error;
        }
        ambiguous = true;
      }
      await retryDelay(this.#retryBaseDelayMs * 2 ** attempt);
    }
  }

  /** The failure to raise for a storage response that did not succeed (see `foundryFailureMessage`). */
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
    return bodyText(response);
  }

  failureFrom(status: number, body: string, what: string): Error {
    return new Error(foundryFailureMessage('storage', status, body, what));
  }
}
