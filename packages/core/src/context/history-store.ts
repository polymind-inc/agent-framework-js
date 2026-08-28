import type { Message, MessageFilter } from '../types/message.js';
import { notSourceTypes, passThrough } from '../types/message.js';
import type {
  HistoryProvider,
  HistoryStoreOptions,
  ProviderAfterRunContext,
  ProviderRunContext,
} from './context-provider.js';
import { selectContextMessages } from './context-provider.js';

/** {@link HistoryStoreOptions} with the defaults filled in. */
export interface ResolvedHistoryStoreOptions {
  provideFilter: MessageFilter;
  storeFilter: MessageFilter;
  storeContextMessages: boolean | readonly string[];
}

/**
 * Applies the defaults every bundled history provider shares.
 *
 * Kept in one place so that swapping storage — session state, a file, something remote — never
 * changes which messages the transcript ends up holding.
 */
export function resolveHistoryStoreOptions(options?: HistoryStoreOptions): ResolvedHistoryStoreOptions {
  return {
    provideFilter: options?.provideFilter ?? passThrough,
    storeFilter: options?.storeFilter ?? notSourceTypes('ChatHistory'),
    storeContextMessages: options?.storeContextMessages ?? false,
  };
}

/**
 * What a finished run appends to the transcript, in the order it is stored.
 *
 * Empty for a run that failed: it produced no exchange, and storing the input on its own would
 * leave an unanswered question for the next run to replay.
 */
function messagesToStore(ctx: ProviderAfterRunContext, options: ResolvedHistoryStoreOptions): Message[] {
  if (ctx.response === undefined) {
    return [];
  }
  return options.storeFilter([
    ...selectContextMessages(ctx.contextMessages, options.storeContextMessages),
    ...ctx.inputMessages,
    ...ctx.response.messages,
  ]);
}

/**
 * The `beforeRun` every bundled history provider performs: replay the stored transcript.
 *
 * A provider differs from its siblings only in where the messages live, which is
 * {@link HistoryProvider.getMessages}. What happens around that call — which messages the filter
 * lets through, and that an empty transcript contributes nothing rather than an empty message —
 * is the same for all of them, so it is written here instead of being copied into each one.
 */
export async function replayStoredHistory(
  provider: HistoryProvider,
  ctx: ProviderRunContext,
  options: ResolvedHistoryStoreOptions,
): Promise<void> {
  const history = options.provideFilter(await provider.getMessages(ctx.session, ctx.state));
  if (history.length > 0) {
    ctx.extendMessages(history);
  }
}

/**
 * The `afterRun` every bundled history provider performs: append what the run produced.
 *
 * The counterpart of {@link replayStoredHistory}, over {@link HistoryProvider.saveMessages}. A run
 * with nothing to append does not reach the store at all, so a provider never has to treat an
 * empty write as a special case.
 */
export async function persistRunHistory(
  provider: HistoryProvider,
  ctx: ProviderAfterRunContext,
  options: ResolvedHistoryStoreOptions,
): Promise<void> {
  const toSave = messagesToStore(ctx, options);
  if (toSave.length > 0) {
    await provider.saveMessages(ctx.session, toSave, ctx.state);
  }
}
