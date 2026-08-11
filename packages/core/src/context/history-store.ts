import type { Message, MessageFilter } from '../types/message.js';
import { notSourceTypes, passThrough } from '../types/message.js';
import type { HistoryStoreOptions, ProviderAfterRunContext } from './context-provider.js';
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
export function messagesToStore(
  ctx: ProviderAfterRunContext,
  options: ResolvedHistoryStoreOptions,
): Message[] {
  if (ctx.response === undefined) {
    return [];
  }
  return options.storeFilter([
    ...selectContextMessages(ctx.contextMessages, options.storeContextMessages),
    ...ctx.inputMessages,
    ...ctx.response.messages,
  ]);
}
