import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentSession } from '../agent/session.js';
import type {
  HistoryProvider,
  HistoryStoreOptions,
  ProviderAfterRunContext,
  ProviderRunContext,
} from '../context/context-provider.js';
import type { ResolvedHistoryStoreOptions } from '../context/history-store.js';
import { messagesToStore, resolveHistoryStoreOptions } from '../context/history-store.js';
import { ConfigurationError } from '../errors.js';
import type { Message } from '../types/message.js';
import type { SerializedMessage } from '../types/serialization.js';
import { deserializeMessage, serializeMessage } from '../types/serialization.js';
import { isWithin } from './paths.js';

/** Options for {@link FileHistoryProvider}. */
export interface FileHistoryProviderConfig extends HistoryStoreOptions {
  /**
   * Directory holding one file per session. Created when it does not exist.
   *
   * Treat it as application storage, not as a secret store: transcripts are written as plain text
   * and are readable by anything that can read the directory.
   */
  storagePath: string;
  /**
   * Defaults to `'file_history'` (Python `FileHistoryProvider.DEFAULT_SOURCE_ID`, which also names
   * the session-state partition). Override when running several history providers side by side.
   */
  sourceId?: string;
}

/** Filenames Windows refuses whatever the extension is. */
const WINDOWS_RESERVED_STEMS = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

/** Beyond this a stem risks the platform's own filename limits, so the id is hashed instead. */
const MAX_LITERAL_STEM_LENGTH = 180;
const HASHED_STEM_PREFIX = '~session-sha256-';

/**
 * Whether a session id can be used as a filename as it stands.
 *
 * Session ids are opaque: a caller may use a UUID, but also a path, an email address or a
 * Windows-reserved word. Anything that is not plainly portable is hashed rather than rejected, so
 * a working session never becomes unusable because of how it was named.
 *
 * The mapping has to be injective on every platform, including volumes that fold case (Windows,
 * macOS) — `abc.jsonl` and `ABC.jsonl` are one file there, and two sessions sharing a file means
 * each replays the other's transcript. So a literal stem must be entirely lowercase; distinct
 * all-lowercase names stay distinct under case folding, and everything else maps to a lowercase
 * hex digest, where the same holds.
 */
function isLiteralStemSafe(sessionId: string): boolean {
  if (
    sessionId === '' ||
    sessionId.length > MAX_LITERAL_STEM_LENGTH ||
    sessionId.startsWith('.') ||
    /[ .]$/.test(sessionId)
  ) {
    return false;
  }
  if (WINDOWS_RESERVED_STEMS.has((sessionId.split('.')[0] ?? '').toUpperCase())) {
    return false;
  }
  return /^[a-z0-9._-]+$/.test(sessionId);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * One promise chain per file, shared by every provider in the process.
 *
 * Appends to one session must not interleave their lines, and a read must not observe an append
 * that is partway through being flushed — it would see a line that ends mid-JSON and report a
 * healthy transcript as corrupted. Both orderings have to hold across provider instances too,
 * since nothing stops two of them from pointing at the same directory, so the chains are keyed by
 * resolved file path at module level rather than held per instance. Processes are another matter:
 * nothing here coordinates two of them writing the same file.
 */
const fileChains = new Map<string, Promise<unknown>>();

/**
 * Runs `operation` after everything already queued for `path`.
 *
 * The queued link swallows failures so one failed operation does not wedge every later one, and
 * the entry is dropped when nothing is queued behind it, so the map does not grow with every
 * session the process ever sees.
 */
async function enqueueFileOperation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileChains.get(path) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const link = run.then(
    () => undefined,
    () => undefined,
  );
  fileChains.set(path, link);
  try {
    return await run;
  } finally {
    if (fileChains.get(path) === link) {
      fileChains.delete(path);
    }
  }
}

/**
 * Persists one session per file, appending as the conversation grows.
 *
 * Each line is one message in the same wire form the rest of the framework serializes, so a
 * transcript written here can be read by anything that understands JSON Lines — including
 * implementations of this interface backed by other storage, which is why the layout is part of
 * the contract rather than an internal detail.
 *
 * ```ts
 * const agent = new Agent({
 *   client,
 *   historyProvider: new FileHistoryProvider({ storagePath: './sessions' }),
 * });
 * ```
 *
 * ## Security considerations
 *
 * - **Transcripts are stored in the clear.** They routinely contain whatever a user typed and
 *   whatever a tool returned. Put `storagePath` somewhere with access controls that match the
 *   conversation's, and consider encryption at rest.
 * - **A session id never escapes `storagePath`.** An id that is not a portable all-lowercase
 *   filename is replaced by its SHA-256 digest, and the resolved path is checked against the
 *   directory, so an id carrying `../` or an absolute path cannot address a file elsewhere — and
 *   two ids differing only by case cannot share a file on a volume that folds case.
 * - **History is replayed verbatim into every later model call.** A transcript an attacker can
 *   write to is a prompt-injection channel; treat the directory as trusted input.
 *
 * ## Concurrency
 *
 * Reads and appends to one session's file are ordered within the process, across provider
 * instances included, so overlapping runs of a session cannot interleave lines or observe a
 * half-flushed one. Nothing coordinates two *processes* sharing a directory — give each its own,
 * or put external locking around the shared one.
 */
export class FileHistoryProvider implements HistoryProvider {
  readonly sourceId: string;
  readonly #storagePath: string;
  readonly #options: ResolvedHistoryStoreOptions;
  #directoryReady: Promise<unknown> | undefined;

  constructor(config: FileHistoryProviderConfig) {
    if (config.storagePath === '') {
      throw new ConfigurationError('FileHistoryProvider needs a storagePath.');
    }
    this.sourceId = config.sourceId ?? 'file_history';
    this.#storagePath = resolve(config.storagePath);
    this.#options = resolveHistoryStoreOptions(config);
  }

  /** The directory this provider writes to, resolved to an absolute path. */
  get storagePath(): string {
    return this.#storagePath;
  }

  async getMessages(session: AgentSession, _state: Record<string, unknown>): Promise<Message[]> {
    const path = await this.#sessionFile(session);
    // Queued behind any append in flight for the same file: a read overlapping an append could
    // otherwise observe a partially flushed line and report a healthy transcript as corrupted.
    return await enqueueFileOperation(path, async () => {
      let contents: string;
      try {
        contents = await readFile(path, 'utf8');
      } catch (error) {
        // A session that has never been written has no file, which is not an error: it is an empty
        // transcript. Anything else — a permission problem, a directory in the way — is real and
        // is surfaced rather than reported as "no history".
        if ((error as { code?: string }).code === 'ENOENT') {
          return [];
        }
        throw error;
      }

      const messages: Message[] = [];
      const lines = contents.split('\n');
      for (const [index, line] of lines.entries()) {
        // Trailing newline, and any blank line a partially written file left behind.
        if (line.trim() === '') {
          continue;
        }
        try {
          messages.push(deserializeMessage(JSON.parse(line) as SerializedMessage));
        } catch (error) {
          throw new Error(`Failed to read history line ${index + 1} of '${path}'.`, { cause: error });
        }
      }
      return messages;
    });
  }

  async saveMessages(
    session: AgentSession,
    messages: Message[],
    _state: Record<string, unknown>,
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const lines = messages.map((message) => {
      const line = JSON.stringify(serializeMessage(message));
      if (line.includes('\n')) {
        // `JSON.stringify` escapes newlines, so reaching this means a custom serializer produced
        // something that would split one message across two lines and corrupt every later read.
        throw new Error('A serialized message contains a raw newline, which would break the JSONL file.');
      }
      return line;
    });
    const path = await this.#sessionFile(session);
    await this.#ensureDirectory();
    await enqueueFileOperation(path, async () => {
      await appendFile(path, `${lines.join('\n')}\n`, 'utf8');
    });
  }

  async beforeRun(ctx: ProviderRunContext): Promise<void> {
    const history = this.#options.provideFilter(await this.getMessages(ctx.session, ctx.state));
    if (history.length > 0) {
      ctx.extendMessages(history);
    }
  }

  async afterRun(ctx: ProviderAfterRunContext): Promise<void> {
    const toSave = messagesToStore(ctx, this.#options);
    if (toSave.length > 0) {
      await this.saveMessages(ctx.session, toSave, ctx.state);
    }
  }

  async #sessionFile(session: AgentSession): Promise<string> {
    // A literal id cannot begin with `~`, so an id that spells out a hashed stem cannot collide
    // with the file the hash chose for another id.
    const stem = isLiteralStemSafe(session.sessionId)
      ? session.sessionId
      : `${HASHED_STEM_PREFIX}${await sha256Hex(session.sessionId)}`;
    const path = resolve(this.#storagePath, `${stem}.jsonl`);
    // The stem is derived, never taken verbatim from an untrusted id, so this cannot fail today.
    // It is checked anyway: the encoding is the only thing standing between an opaque session id
    // and the filesystem, and a future change to it must not silently become a path traversal.
    if (!isWithin(this.#storagePath, path)) {
      throw new ConfigurationError(
        `Session '${session.sessionId}' does not map to a file inside storagePath.`,
      );
    }
    return path;
  }

  async #ensureDirectory(): Promise<void> {
    // Created once per provider rather than per write, and retried on the next call if it failed.
    this.#directoryReady ??= mkdir(this.#storagePath, { recursive: true }).catch((error: unknown) => {
      this.#directoryReady = undefined;
      throw error;
    });
    await this.#directoryReady;
  }
}
