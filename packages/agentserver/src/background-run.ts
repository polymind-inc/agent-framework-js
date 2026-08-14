import type { ResponseTracker } from './lifecycle.js';
import type { ResponseGeneration, ResponseOwner } from './store/provider.js';
import { positiveLimit } from './validation.js';
import type { OutputItem, ResponseEvent, ResponseObject } from './wire.js';

/** The event's replay cursor position. Events this server persists are always stamped. */
export function sequenceOf(event: ResponseEvent): number {
  return typeof event.sequence_number === 'number' ? event.sequence_number : -1;
}

/**
 * One detached background execution, registered while it runs.
 *
 * The counterpart of Python's `_RuntimeState` record: `GET` observes in-flight state through it,
 * `GET ?stream=true` subscribes to it, and `/cancel` signals it. It exists only while the run
 * does — once the terminal state (and, for a streamed run, the event log) is persisted, the
 * store is the single source of truth and the record is dropped.
 */
export class BackgroundRun {
  readonly owner: ResponseOwner;
  /** Whether the run was created with `stream=true` — the precondition for replay. */
  readonly streamed: boolean;
  readonly tracker: ResponseTracker;
  /** What `input_items` serves while the run is still in flight. */
  readonly inputItems: readonly OutputItem[];
  /** Cancels the handler; also fired by the server's shutdown signal. */
  readonly abort: AbortController;
  /** Persists an arbitrary snapshot under this run's identity; the cancel route's tool. */
  readonly persistSnapshot: (response: ResponseObject) => Promise<void>;
  /** Set when the retention cap was crossed: replay is off the table. Live delivery continues. */
  overflowed = false;
  finished = false;
  cancelRequested = false;
  /** Settles when the runner is done — terminal delivered, persistence attempted. */
  done: Promise<void> = Promise.resolve();

  readonly #maxEvents: number;
  #waiters: Array<() => void> = [];
  readonly #firstEventSeen: () => void;
  /** Resolves once the first event was folded (or the run ended): the non-stream 200 boundary. */
  readonly firstEvent: Promise<void>;

  /** The retained window of stamped events. Streamed runs only. */
  #buffer: ResponseEvent[] = [];
  /** Where `#buffer[0]` sits in the delivery order, so a cursor survives the window moving. */
  #base = 0;
  /** How many events have been delivered, ever. */
  #delivered = 0;
  /** The cursor of every live subscription, so retention can serve the slowest of them. */
  readonly #followers = new Set<{ index: number }>();

  constructor(options: {
    owner: ResponseOwner;
    streamed: boolean;
    tracker: ResponseTracker;
    inputItems: readonly OutputItem[];
    abort: AbortController;
    persistSnapshot: (response: ResponseObject) => Promise<void>;
    maxEvents: number;
  }) {
    this.owner = options.owner;
    this.streamed = options.streamed;
    this.tracker = options.tracker;
    this.inputItems = options.inputItems;
    this.abort = options.abort;
    this.persistSnapshot = options.persistSnapshot;
    this.#maxEvents = positiveLimit('maxEvents', options.maxEvents);
    const { promise, resolve } = Promise.withResolvers<void>();
    this.firstEvent = promise;
    this.#firstEventSeen = resolve;
  }

  /**
   * The complete replay log, valid only while `overflowed` is false.
   *
   * Once the cap has been crossed the window has been trimmed to what live subscribers still
   * need, so this is no longer the whole stream and `#runBackground` must not store it.
   */
  get events(): readonly ResponseEvent[] {
    return this.#buffer;
  }

  /** Hands one stamped event to the buffer and to everyone currently waiting on it. */
  deliver(event: ResponseEvent): void {
    if (this.streamed) {
      this.#buffer.push(event);
      this.#delivered += 1;
      if (!this.overflowed && this.#delivered > this.#maxEvents) {
        // The cap is a memory bound, not a protocol state: the run continues, its terminal is
        // still persisted, and every subscriber that is following it live is still carried to
        // that terminal. Only *replay* dies, and it dies whole — a replay missing its head would
        // start without `response.created`, which no client is written to survive. Cutting the
        // live subscribers too would close their streams with no terminal event and no way back
        // in, since reconnecting to an overflowed run is a 400.
        this.overflowed = true;
      }
      this.#trim();
    }
    this.#firstEventSeen();
    this.#wake();
  }

  /**
   * Releases everything no live subscription still needs.
   *
   * Nothing is dropped before the cap is crossed: until then the whole log is the replay log.
   * After it, the window is what the slowest subscriber has yet to read — bounded in turn by the
   * cap itself, so a subscription that has stopped draining (a client that stopped reading its
   * socket) cannot defeat the memory bound. Such a subscriber stays subscribed and resumes from
   * whatever is still retained, terminal included.
   */
  #trim(): void {
    if (!this.overflowed) {
      return;
    }
    let keep = this.#delivered;
    for (const follower of this.#followers) {
      keep = Math.min(keep, follower.index);
    }
    keep = Math.max(keep, this.#base, this.#delivered - this.#maxEvents);
    if (keep > this.#base) {
      this.#buffer.splice(0, keep - this.#base);
      this.#base = keep;
    }
  }

  /** Marks the run over and releases every follower. */
  finish(): void {
    this.finished = true;
    this.#firstEventSeen();
    this.#wake();
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  /**
   * The live subscription: replays the retained buffer past `startingAfter`, then follows until
   * the run finishes. Purely observational — a follower that goes away (a client disconnect
   * closing its SSE stream) leaves the run untouched, which is what decouples a background run
   * from any one connection.
   */
  async *follow(startingAfter: number): AsyncGenerator<ResponseEvent> {
    const follower = { index: this.#base };
    this.#followers.add(follower);
    try {
      for (;;) {
        while (follower.index < this.#delivered) {
          // The window can only have moved past this cursor after the cap was crossed *and* this
          // subscriber stopped draining; picking it up at the new front is what keeps the terminal
          // reachable for it. Checked on every step rather than once per wake, because `yield`
          // below suspends *inside* this loop for as long as the consumer takes to pull: a
          // `#trim()` during that suspension would otherwise leave the cursor behind `#base` and
          // the next read would index the buffer at a negative offset.
          if (follower.index < this.#base) {
            follower.index = this.#base;
          }
          const event = this.#buffer[follower.index - this.#base];
          if (event === undefined) {
            throw new Error('subscriber cursor left the retained window');
          }
          follower.index += 1;
          if (sequenceOf(event) > startingAfter) {
            yield event;
          }
        }
        if (this.finished) {
          return;
        }
        await new Promise<void>((resolve) => this.#waiters.push(resolve));
      }
    } finally {
      this.#followers.delete(follower);
      // A departing subscriber may have been the only reason the window was still held open.
      this.#trim();
    }
  }
}

/**
 * One response id's exclusive hold on the background registry.
 *
 * The claim is taken *synchronously*, the moment a background create has settled on its id, and is
 * what makes "is this id busy?" a decision rather than a guess: the create then spends several
 * awaits — the writability check, the session lookup, the handler's own setup — before there is a
 * {@link BackgroundRun} to register, and two simultaneous creates would otherwise both read an
 * empty registry and both install themselves under the same key.
 *
 * It doubles as the *generation* of the id, in two ways. Locally, every store write a detached run
 * still owes is made conditional on the claim it started under still being the current one, so a
 * run whose id was freed underneath it — `DELETE` frees a terminal run's id while it is winding
 * down — cannot land its writes in a turn that now belongs to somebody else. And
 * {@link IdClaim.generation} carries that identity *into the store*, for the one write whose
 * arrival the server cannot order — the replay log, made long after the turn became deletable.
 *
 * Finally it is what `drain()` waits on. The wait exists from the instant the id is reserved —
 * before there is a run, before the handler has been asked for anything — so a shutdown cannot
 * return while a turn it never saw is still coming.
 */
export interface IdClaim {
  /** Who reserved it, so a claim can answer 409-vs-404 before any run exists. */
  readonly owner: ResponseOwner;
  /** This turn's generation of the id, for the fenced store writes. */
  readonly generation: ResponseGeneration;
  /** The run once it has been started; `undefined` for the length of the create's own setup. */
  run: BackgroundRun | undefined;
  /**
   * Settles when everything this claim owes is over: the create's own setup, the detached run, and
   * the terminal persistence and replay log that follow it.
   */
  readonly done: Promise<void>;
  /**
   * Ends the wait, optionally by adopting the work that replaces it — with the run's completion,
   * or bare when the turn ended without a run taking over. First call wins: a settled claim stays
   * settled, so the teardown paths that share a claim may each settle it without coordinating.
   */
  readonly settle: (work?: Promise<void>) => void;
}

/** A claim and its wait, in the one place both are created. */
export function newClaim(owner: ResponseOwner, generation: ResponseGeneration): IdClaim {
  const { promise: done, resolve } = Promise.withResolvers<void>();
  // A failure is still a completion as far as a shutdown is concerned: `drain()` waits for the
  // turn to be *over*, not to have succeeded.
  const settle = (work?: Promise<void>): void => resolve(work?.then(undefined, () => undefined));
  return { owner, generation, run: undefined, done, settle };
}
