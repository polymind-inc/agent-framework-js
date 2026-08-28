import type { ResponseTracker } from './lifecycle.js';
import type { ApiError, ResponseEvent, ResponseLifecycleEvent, ResponseObject } from './wire.js';

/**
 * What the caller is told when a finished response could not be stored (.NET
 * `ResponseOrchestrator`): the turn is reported as `failed` — with the output cleared, because
 * items that were never persisted cannot be retrieved later and returning them would create a
 * false expectation — rather than pretending a `completed` happened that no follow-up turn will
 * be able to resolve.
 */
const STORAGE_ERROR: ApiError = {
  code: 'storage_error',
  message:
    'An internal error occurred while storing the response. Subsequent retrieval is not guaranteed. Please retry the request.',
  type: 'server_error',
};

export function storageFailed(response: ResponseObject): ResponseObject {
  return { ...response, status: 'failed', output: [], error: STORAGE_ERROR };
}

/**
 * The persist-before-terminal contract, shared by the foreground SSE stream and the background
 * driver: the turn is offered to the store *before* its terminal event reaches any consumer, so a
 * caller that reads `response.completed` can come back with `previous_response_id`. When the store
 * refuses, the terminal the consumer reads is a `response.failed` carrying `storage_error`
 * instead. Persisting is attempted at most once — .NET does not retry a failed persist, and
 * neither does this.
 */
export class TerminalPersister {
  readonly #persist: () => Promise<void>;
  readonly #tracker: ResponseTracker;
  #attempted = false;

  constructor(persist: () => Promise<void>, tracker: ResponseTracker) {
    this.#persist = persist;
    this.#tracker = tracker;
  }

  /** Persists ahead of the terminal `event`; on a store refusal returns the storage failure instead. */
  async onTerminal(event: ResponseEvent): Promise<ResponseEvent> {
    this.#attempted = true;
    try {
      await this.#persist();
      return event;
    } catch {
      const failed: ResponseLifecycleEvent = {
        type: 'response.failed',
        response: storageFailed(this.#tracker.response),
      };
      return failed;
    }
  }

  /**
   * The teardown fallback for a stream torn down before any terminal event came through: records
   * the partial turn — it is resumable with `previous_response_id`. A store failure here has no
   * caller left to tell, so it is deliberately swallowed.
   */
  async ensureAttempted(): Promise<void> {
    if (this.#attempted) {
      return;
    }
    try {
      await this.#persist();
    } catch {
      // Nothing to answer: the caller is gone.
    }
  }
}
