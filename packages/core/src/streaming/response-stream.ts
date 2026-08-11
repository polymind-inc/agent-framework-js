import { StreamConsumedError, throwIfAborted } from '../errors.js';
import { abortErrorFrom } from './abort.js';

/** Context handed to a stream's `start` callback on first consumption. */
export interface StreamStartContext {
  /**
   * `true` when the caller is iterating (`for await`), `false` when the caller awaited the
   * stream as a promise.
   *
   * Providers use this to decide between a streaming and a non-streaming transport.
   */
  stream: boolean;
  signal?: AbortSignal;
}

/**
 * Tells an `onResult` hook how the stream ended.
 *
 * A hook that only reads the folded result can ignore it; a hook that *validates* the result has to
 * know whether it is looking at a complete run or at the part of one the caller chose to keep.
 */
export interface StreamResultContext {
  /**
   * `true` when the consumer stopped iterating early — a `break` out of `for await`, or an explicit
   * `iterator.return()` — rather than letting the source run out.
   *
   * The folded result is then a *partial* one: the run was not finished, it was abandoned. Hooks
   * that would otherwise reject an incomplete response (structured-output parsing) must skip it,
   * because `break` is a legitimate thing for a caller to do and must not turn into an error.
   */
  abandoned: boolean;
}

/** Configuration for {@link createResponseStream}. */
export interface ResponseStreamInit<TUpdate, TFinal> {
  /**
   * Produces the underlying update source. Called at most once, on first consumption.
   *
   * Nothing runs before this point: constructing a stream has no side effects.
   */
  start: (ctx: StreamStartContext) => AsyncIterable<TUpdate> | Promise<AsyncIterable<TUpdate>>;
  /** Folds every observed update into the final result. */
  finalize: (updates: TUpdate[]) => TFinal | Promise<TFinal>;
  /**
   * Run exactly once after the source is exhausted, abandoned (`break`) or fails — before
   * `finalize`. This is where history persistence and telemetry teardown belong.
   *
   * `failure` carries the error that killed the stream when there is one — including failures the
   * source generator never sees (an abort between pulls, a consumer `iterator.throw()`), which is
   * the only way a teardown hook can observe those paths (`onResult` never runs for them). Every
   * hook is handed the *source* failure; a failure raised by an earlier hook is never passed on.
   *
   * A hook that throws **fails the stream permanently**: the error is latched, so iteration,
   * `await` and {@link ResponseStream.finalResponse} all report it. A later hook still runs — the
   * hooks are teardown, and skipping the rest would leak whatever they hold. See
   * {@link ResponseStream} for how a cleanup failure combines with a source failure.
   */
  cleanup?: Array<(failure?: unknown) => void | Promise<void>>;
  /**
   * Applied to the final result, in order, after `finalize`. Returning `undefined` keeps the result.
   *
   * The second argument reports whether the stream ran out or was abandoned; see
   * {@link StreamResultContext}.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: void in the union lets hooks return nothing to keep the result unchanged
  onResult?: Array<(final: TFinal, ctx: StreamResultContext) => TFinal | Promise<TFinal | void> | void>;
  /** Cancels iteration; checked before every pull from the source. */
  signal?: AbortSignal;
}

/**
 * A response stream: awaitable as a promise **and** iterable as an async iterable.
 *
 * ```ts
 * const response = await agent.run('hi');            // non-streaming
 * for await (const update of agent.run('hi')) { }    // streaming
 * ```
 *
 * Consumption is single-shot: whichever form is used first claims the stream, and a second
 * `await` or `for await` throws {@link StreamConsumedError} synchronously. After iterating,
 * {@link ResponseStream.finalResponse} returns the folded result.
 *
 * ## Stopping early is supported
 *
 * A consumer may abandon the stream — `break` out of the `for await`, or call `return()` on the
 * iterator — without leaking anything and without needing a `close()` of its own. The abandoned
 * source is closed first, which propagates inward through every layer to the provider SDK stream,
 * and the `cleanup` and `onResult` hooks then run exactly once, so whatever they hold is released
 * at the point the caller stopped rather than whenever the object is collected.
 *
 * The folded result stays available from {@link ResponseStream.finalResponse}; it describes the
 * part of the run that was actually produced, and `onResult` hooks are told so through
 * {@link StreamResultContext.abandoned}. An aborted signal is a failure rather than an
 * abandonment: the hooks still run, but the stream reports the abort.
 *
 * ## Failure is permanent
 *
 * A stream that failed stays failed. Whatever killed it — the source, an abort, a consumer
 * `iterator.throw()`, or a `cleanup` hook — is latched, and every later consumption path reports
 * that same value. One stream is never both a failure and a success.
 *
 * When a `cleanup` hook throws, the latched failure is:
 *
 * - the cleanup error itself, when it is the only failure and the only hook that raised one;
 * - an `AggregateError` over the cleanup errors, when several hooks raised;
 * - an `AggregateError` whose `cause` and first entry are the **source** error, when the stream
 *   was already failing. The source error explains why the run died; the cleanup error explains
 *   why teardown could not finish, and neither is dropped.
 */
export interface ResponseStream<TUpdate, TFinal>
  extends PromiseLike<TFinal>,
    AsyncIterable<TUpdate, void, void> {
  /**
   * The folded final result.
   *
   * Consumes the stream first when it has not been consumed yet, and resumes draining when
   * iteration stopped early. Safe to call repeatedly; the result is computed once.
   */
  finalResponse(): Promise<TFinal>;
}

class HybridResponseStream<TUpdate, TFinal> implements ResponseStream<TUpdate, TFinal> {
  readonly #init: ResponseStreamInit<TUpdate, TFinal>;
  readonly #updates: TUpdate[] = [];

  #claimed = false;
  #iterator: AsyncIterator<TUpdate> | undefined;
  #sourceDone = false;
  /** The consumer stopped early (`break`), so the folded result describes an unfinished run. */
  #abandoned = false;
  #cleanupRan = false;
  #finalized = false;
  #finalResult: TFinal | undefined;
  #failure: { error: unknown } | undefined;
  #finalizing: Promise<TFinal> | undefined;

  constructor(init: ResponseStreamInit<TUpdate, TFinal>) {
    this.#init = init;
  }

  /**
   * Claims the stream and returns its raw iterator.
   *
   * @internal Used by {@link pipeStream} so an outer stream can drive an inner one while
   * propagating the caller's consumption mode.
   */
  beginInternal(stream: boolean): AsyncIterator<TUpdate, void, void> {
    this.#claim();
    return this.#createIterator(stream);
  }

  #claim(): void {
    if (this.#claimed) {
      throw new StreamConsumedError();
    }
    this.#claimed = true;
  }

  #createIterator(stream: boolean): AsyncIterator<TUpdate, void, void> {
    return {
      next: () => this.#next(stream),
      return: async () => {
        await this.#stop();
        return { done: true, value: undefined };
      },
      throw: async (error?: unknown) => {
        // The consumer aborted the stream by throwing into it. The source is finished for good, so
        // record the failure like a source error (#next) — otherwise a later `finalResponse()`
        // would resume pulling a source whose cleanup already ran.
        if (!this.#sourceDone) {
          this.#sourceDone = true;
          this.#failure = { error };
          await this.#closeSource();
          try {
            await this.#runCleanup();
          } catch {
            // `#runCleanup` latches its failure. Throw the final combined value below so this call
            // and every later `finalResponse()` observe exactly the same error object.
          }
        } else {
          await this.#runCleanup();
        }
        throw this.#failure?.error ?? error;
      },
    };
  }

  async #source(stream: boolean): Promise<AsyncIterator<TUpdate>> {
    if (this.#iterator === undefined) {
      const ctx: StreamStartContext = { stream };
      if (this.#init.signal !== undefined) {
        ctx.signal = this.#init.signal;
      }
      const iterable = await this.#init.start(ctx);
      this.#iterator = iterable[Symbol.asyncIterator]();
    }
    return this.#iterator;
  }

  async #next(stream: boolean): Promise<IteratorResult<TUpdate, void>> {
    if (this.#sourceDone) {
      return { done: true, value: undefined };
    }
    let result: IteratorResult<TUpdate>;
    try {
      throwIfAborted(this.#init.signal);
      const iterator = await this.#source(stream);
      result = await iterator.next();
    } catch (error) {
      // A stream that fails yields no partial result, but cleanup still runs.
      this.#sourceDone = true;
      this.#failure = { error };
      // An abort detected *between* pulls never reaches the source generator; close it so its
      // `finally` blocks (active-span scopes, provider teardown) run. On an error thrown by the
      // source itself the iterator is already finished and this is usually a no-op. A broken
      // `return()` is itself a permanent source-teardown failure and is combined below.
      await this.#closeSource();
      try {
        await this.#runCleanup();
      } catch {
        // Cleanup has already latched its error together with the source failure.
      }
      throw this.#failure.error;
    }

    if (result.done === true) {
      this.#sourceDone = true;
      // A source can end *because* it was aborted rather than because it finished: both provider
      // SDKs check the signal between chunks and `return` instead of throwing (openai and
      // @anthropic-ai/sdk `core/streaming.mjs`). Checking only before each pull would fold that
      // truncated turn into a normal final result — and a hosted turn would be persisted as
      // `completed` carrying output the model never finished, with no error anywhere to show for
      // it. This is the same value `throwIfAborted` would have thrown one pull earlier, so the
      // abort reports identically whichever side of the pull it lands on.
      if (this.#init.signal?.aborted === true) {
        const error = abortErrorFrom(this.#init.signal);
        this.#failure = { error };
        try {
          await this.#runCleanup();
        } catch {
          // Cleanup has already latched its error together with the abort.
        }
        throw this.#failure.error;
      }
      await this.#runCleanup();
      await this.#finalizeForHooks();
      return { done: true, value: undefined };
    }

    const update = result.value;
    this.#updates.push(update);
    return { done: false, value: update };
  }

  /** Abandons the source (early `break`), then runs cleanup and finalization exactly once. */
  async #stop(): Promise<void> {
    if (!this.#sourceDone) {
      this.#sourceDone = true;
      this.#abandoned = true;
      await this.#closeSource();
      try {
        await this.#runCleanup();
      } catch {
        // Cleanup has already latched its error. The common check below reports it.
      }
      if (this.#failure !== undefined) {
        throw this.#failure.error;
      }
      await this.#finalizeForHooks();
    }
  }

  /**
   * Finalizes at end of iteration only when a result hook is waiting on it.
   *
   * The hooks' timing is load-bearing — history persistence and telemetry teardown must observe
   * the folded result when the source ends, not when the caller happens to ask for it. Without
   * hooks the fold is pure and memoized, so it is deferred to {@link finalResponse}: an inner
   * stream in a layered pipeline is drained by the layer above and its own fold is never read,
   * which would otherwise cost a full pass over the run's updates per layer.
   */
  async #finalizeForHooks(): Promise<void> {
    if (this.#init.onResult !== undefined && this.#init.onResult.length > 0) {
      await this.#finalize();
    }
  }

  /**
   * Closes an abandoned or failed source and permanently records a broken `return()`.
   *
   * The close is part of source teardown, not a cleanup hook: it runs first so cleanup hooks see
   * the complete reason the source died. When pulling already failed, neither error is allowed to
   * mask the other; the pull error remains the primary cause and the close error follows it.
   */
  async #closeSource(): Promise<void> {
    try {
      await this.#iterator?.return?.();
    } catch (error) {
      const primary = this.#failure;
      if (primary === undefined) {
        this.#failure = { error };
        return;
      }
      this.#failure = {
        error: new AggregateError(
          [primary.error, error],
          'The response stream failed, and closing its source failed as well.',
          { cause: primary.error },
        ),
      };
    }
  }

  /**
   * Runs the teardown hooks once, and turns any failure they raise into the stream's failure.
   *
   * Every hook runs even after an earlier one throws: the hooks are teardown, `#cleanupRan` means
   * a skipped hook never gets a second chance, and the errors are reported together rather than
   * one at a time.
   *
   * @throws The latched failure, when at least one hook raised.
   */
  async #runCleanup(): Promise<void> {
    if (this.#cleanupRan) {
      return;
    }
    this.#cleanupRan = true;
    // Captured before the loop: a hook is told what killed the *stream*, never what a sibling
    // hook raised.
    const sourceFailure = this.#failure;
    const errors: unknown[] = [];
    for (const hook of this.#init.cleanup ?? []) {
      try {
        await hook(sourceFailure?.error);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 0) {
      return;
    }
    throw this.#latchCleanupFailure(sourceFailure, errors);
  }

  /**
   * Records the stream's permanent failure after cleanup raised, and returns it.
   *
   * Without this the failure lived only in the rejection of whichever call happened to run
   * cleanup: `#failure` stayed unset, so the next `finalResponse()` folded the updates and handed
   * back a successful result for a stream that had just thrown.
   *
   * A source failure stays the primary error — it is the `cause` and the first entry — because it
   * is what explains the run; the cleanup errors ride along so a broken teardown is still visible.
   */
  #latchCleanupFailure(sourceFailure: { error: unknown } | undefined, errors: unknown[]): unknown {
    let latched: unknown;
    if (sourceFailure === undefined) {
      latched =
        errors.length === 1
          ? errors[0]
          : new AggregateError(errors, 'The response stream cleanup hooks failed.');
    } else {
      latched = new AggregateError(
        [sourceFailure.error, ...errors],
        'The response stream failed, and its cleanup hooks failed as well.',
        { cause: sourceFailure.error },
      );
    }
    this.#failure = { error: latched };
    return latched;
  }

  async #finalize(): Promise<TFinal> {
    if (this.#failure !== undefined) {
      throw this.#failure.error;
    }
    if (this.#finalized) {
      return this.#finalResult as TFinal;
    }
    const resultCtx: StreamResultContext = { abandoned: this.#abandoned };
    this.#finalizing ??= (async (): Promise<TFinal> => {
      let final = await this.#init.finalize(this.#updates);
      for (const hook of this.#init.onResult ?? []) {
        const hooked = await hook(final, resultCtx);
        if (hooked !== undefined && hooked !== null) {
          final = hooked;
        }
      }
      this.#finalResult = final;
      this.#finalized = true;
      return final;
    })();
    return this.#finalizing;
  }

  async #drain(stream: boolean): Promise<TFinal> {
    for (;;) {
      const result = await this.#next(stream);
      if (result.done === true) {
        break;
      }
    }
    return this.#finalize();
  }

  [Symbol.asyncIterator](): AsyncIterator<TUpdate, void, void> {
    this.#claim();
    return this.#createIterator(true);
  }

  // biome-ignore lint/suspicious/noThenProperty: the stream is deliberately awaitable (thenable + async iterable hybrid)
  then<TResult1 = TFinal, TResult2 = never>(
    onfulfilled?: ((value: TFinal) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    this.#claim();
    return this.#drain(false).then(onfulfilled, onrejected);
  }

  async finalResponse(): Promise<TFinal> {
    // The latch is checked first: a stream that failed has no result to hand back, whatever else
    // has already been computed.
    if (this.#failure !== undefined) {
      throw this.#failure.error;
    }
    if (this.#finalized) {
      return this.#finalResult as TFinal;
    }
    if (!this.#claimed) {
      this.#claimed = true;
      return this.#drain(false);
    }
    // Already claimed: finish whatever the caller left behind (or return the folded result when
    // iteration completed normally).
    return this.#drain(true);
  }
}

/**
 * Creates a {@link ResponseStream}.
 *
 * The returned object is inert until it is awaited or iterated: `start` is invoked on first
 * consumption and receives the consumption mode, so providers can pick a streaming or
 * non-streaming transport from how the caller used the result.
 *
 * @typeParam TUpdate - The streamed chunk type.
 * @typeParam TFinal - The folded result type.
 */
export function createResponseStream<TUpdate, TFinal>(
  init: ResponseStreamInit<TUpdate, TFinal>,
): ResponseStream<TUpdate, TFinal> {
  return new HybridResponseStream(init);
}

/** Configuration for {@link pipeStream}. */
export interface PipeStreamInit<TIn, TOut, TFinal> {
  /** Maps each inner update to an outer update. Defaults to the identity when omitted. */
  map?: (update: TIn) => TOut | Promise<TOut>;
  /** Folds the mapped updates into the outer final result. */
  finalize: (updates: TOut[]) => TFinal | Promise<TFinal>;
  /** Outer cleanup hooks; run after the inner stream's own cleanup and finalization. */
  cleanup?: Array<(failure?: unknown) => void | Promise<void>>;
  /** Outer result hooks; run last. See {@link StreamResultContext} for the second argument. */
  // biome-ignore lint/suspicious/noConfusingVoidType: void in the union lets hooks return nothing to keep the result unchanged
  onResult?: Array<(final: TFinal, ctx: StreamResultContext) => TFinal | Promise<TFinal | void> | void>;
  signal?: AbortSignal;
}

/**
 * Wraps a stream in an outer stream that transforms each update and produces its own final result.
 *
 * Used to build the chat-layer → agent-layer pipeline. Finalization order matches Python's
 * `ResponseStream.map`:
 *
 * 1. inner cleanup hooks
 * 2. inner finalizer
 * 3. inner result hooks
 * 4. outer cleanup hooks
 * 5. outer finalizer
 * 6. outer result hooks
 *
 * The inner stream is claimed by this call, so it can no longer be consumed directly. Early
 * `break` on the outer stream propagates `return()` inward, so both layers' cleanup hooks still
 * run exactly once.
 *
 * @internal Not part of the public v1 API; exported for use inside the framework.
 */
export function pipeStream<TIn, TOut, TFinal>(
  inner: ResponseStream<TIn, unknown>,
  init: PipeStreamInit<TIn, TOut, TFinal>,
): ResponseStream<TOut, TFinal> {
  const map = init.map;
  const streamInit: ResponseStreamInit<TOut, TFinal> = {
    start: (ctx) => {
      const source = (inner as HybridResponseStream<TIn, unknown>).beginInternal(ctx.stream);
      return {
        [Symbol.asyncIterator]: (): AsyncIterator<TOut> => ({
          next: async (): Promise<IteratorResult<TOut>> => {
            const result = await source.next();
            if (result.done === true) {
              return { done: true, value: undefined };
            }
            const value = map === undefined ? (result.value as unknown as TOut) : await map(result.value);
            return { done: false, value };
          },
          return: async (): Promise<IteratorResult<TOut>> => {
            await source.return?.();
            return { done: true, value: undefined };
          },
        }),
      };
    },
    finalize: init.finalize,
  };
  if (init.cleanup !== undefined) streamInit.cleanup = init.cleanup;
  if (init.onResult !== undefined) streamInit.onResult = init.onResult;
  if (init.signal !== undefined) streamInit.signal = init.signal;
  return createResponseStream(streamInit);
}
