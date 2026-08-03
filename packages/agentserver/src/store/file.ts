import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stateRoot } from '../config.js';
import { notFound } from '../errors.js';
import { resolveUnder } from '../paths.js';
import type { OutputItem, ResponseEvent } from '../wire.js';
import type { ResponseGeneration, ResponseOwner, ResponseProvider, StoredResponse } from './provider.js';
import {
  assertOwnerCanWrite,
  assertWritable,
  historyOf,
  isCurrentGeneration,
  ownedOrUndefined,
  sameOwner,
} from './provider.js';

/** The on-disk shape of a persisted event stream: the events plus who they belong to. */
interface StoredEventsFile {
  userId?: string;
  generation?: ResponseGeneration;
  events: ResponseEvent[];
}

/**
 * Persists responses as JSON files under a root directory.
 *
 * For local runs that need to survive a restart — `azd ai agent run`, a debugger, a test that
 * exercises `previous_response_id` across processes.
 *
 * ## Security considerations
 *
 * Response ids come from the request, so they are treated as untrusted path segments and rejected
 * rather than sanitized (see {@link resolveUnder}). Contents are stored in the clear: a response
 * holds the whole conversation, so the directory needs the same protection the conversation does.
 *
 * The owner is stored *inside* the file rather than used as a directory, because an id is
 * addressable on its own: a caller asks for `caresp_…`, not for `alice/caresp_…`. Reads therefore
 * load the record and then check it, and a record belonging to someone else reads as absent.
 */
export class FileResponseProvider implements ResponseProvider {
  readonly #root: string;
  /** The settled tail of each id's write queue; see {@link #serialized}. */
  readonly #pending = new Map<string, Promise<void>>();

  constructor(options: { root?: string } = {}) {
    this.#root = options.root ?? `${stateRoot()}/responses`;
  }

  #pathFor(id: string): string {
    return resolveUnder(this.#root, [`${id}.json`], 'response id');
  }

  /**
   * Event streams live in their own subdirectory rather than under a suffix, so an id that
   * happens to end in `.events` can never collide with another id's stream file.
   */
  #eventsPathFor(id: string): string {
    return resolveUnder(this.#root, ['events', `${id}.json`], 'response id');
  }

  /**
   * Serializes the writes for one id.
   *
   * `put` is read-check-write: without this, two concurrent writers both read "absent", both pass
   * {@link assertWritable}, and the loser is silently replaced — across owners, that is exactly
   * the overwrite the ownership check exists to refuse. Queueing per id makes the check and the
   * write one step; reads stay lock-free because the write itself is atomic (write-then-rename).
   */
  async #serialized<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#pending.get(id) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.#pending.set(id, settled);
    void settled.then(() => {
      if (this.#pending.get(id) === settled) {
        this.#pending.delete(id);
      }
    });
    return run;
  }

  /**
   * Reads one response record.
   *
   * The parse is an **unchecked assertion, deliberately**. What is on disk is whatever an *older*
   * build of this server wrote, so `StoredResponse` describes the current shape rather than
   * necessarily this one. The concrete case is {@link StoredResponse.generation}: an earlier
   * build persisted it as a `number`, and such a file loads as a `ResponseGeneration` (a string
   * type) holding a number.
   *
   * That is harmless, because nothing ever treats a generation *as* a string — it is only ever
   * compared with `===` ({@link isCurrentGeneration} here, and `getEvents` below), and a value of
   * the wrong type simply fails every comparison, which is the fail-closed answer the fence wants
   * for a record it cannot pair. Validating at read time would buy no safety, and would still have
   * to guess what to do about shapes a *future* build writes, so the mismatch is recorded here
   * instead of policed. `#readEvents` carries the same assertion for the same reason.
   */
  async #read(id: string): Promise<StoredResponse | undefined> {
    return this.#readJson<StoredResponse>(this.#pathFor(id));
  }

  /** Reads and parses one JSON file, reading a missing file as absent. */
  async #readJson<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async get(id: string, owner: ResponseOwner): Promise<StoredResponse | undefined> {
    return ownedOrUndefined(await this.#read(id), owner);
  }

  async put(stored: StoredResponse): Promise<void> {
    return this.#serialized(stored.response.id, async () => {
      assertWritable(await this.#read(stored.response.id), stored);
      await this.#writeAtomic(this.#pathFor(stored.response.id), stored);
    });
  }

  async assertWritable(id: string, owner: ResponseOwner): Promise<void> {
    // Same rule as `put`, read before the turn runs. Not serialized with the write queue on
    // purpose: this is an early rejection, and `put` re-checks under the lock, so a record created
    // between the two is still refused at the point that matters.
    assertOwnerCanWrite(await this.#read(id), id, owner);
  }

  async #readEvents(id: string): Promise<StoredEventsFile | undefined> {
    return this.#readJson<StoredEventsFile>(this.#eventsPathFor(id));
  }

  /**
   * Atomically writes `payload` as JSON to `path`. Write-then-rename: a reader never sees a
   * half-written file, even if the container is killed mid-write.
   */
  async #writeAtomic(path: string, payload: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(payload), 'utf8');
    await rename(temporary, path);
  }

  async putEvents(
    id: string,
    owner: ResponseOwner,
    events: readonly ResponseEvent[],
    generation: ResponseGeneration,
  ): Promise<void> {
    return this.#serialized(id, async () => {
      // The same two refusals `put` gives, under the same per-id queue: neither someone else's
      // response record nor someone else's event stream may be replaced through a reused id.
      const record = await this.#read(id);
      assertOwnerCanWrite(record, id, owner);
      if (!isCurrentGeneration(record, generation)) {
        // The id was deleted, or reused by a later turn, while this log was on its way. The queue
        // is what makes the read above and the write below one step against `put` and `delete`, so
        // this is a genuine compare-and-set rather than a check that another writer can slip past.
        return;
      }
      const existing = await this.#readEvents(id);
      if (existing !== undefined && !sameOwner(existing.userId, owner)) {
        throw notFound(id);
      }
      const payload: StoredEventsFile = {
        ...(owner === undefined || owner === '' ? {} : { userId: owner }),
        generation,
        events: [...events],
      };
      await this.#writeAtomic(this.#eventsPathFor(id), payload);
    });
  }

  async getEvents(
    id: string,
    owner: ResponseOwner,
    generation: ResponseGeneration,
  ): Promise<ResponseEvent[] | undefined> {
    const record = await this.#readEvents(id);
    return record !== undefined && record.generation === generation && sameOwner(record.userId, owner)
      ? record.events
      : undefined;
  }

  async delete(id: string, owner: ResponseOwner): Promise<boolean> {
    return this.#serialized(id, async () => {
      if ((await this.get(id, owner)) === undefined) {
        return false;
      }
      // The replay log goes with the response; `force` because most responses never had one.
      await rm(this.#eventsPathFor(id), { force: true });
      try {
        await rm(this.#pathFor(id));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return false;
        }
        throw error;
      }
    });
  }

  async history(id: string, owner: ResponseOwner): Promise<OutputItem[] | undefined> {
    const stored = await this.get(id, owner);
    return stored === undefined ? undefined : historyOf(stored);
  }
}
