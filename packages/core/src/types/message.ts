import type { Content } from './content.js';
import { textContent, textOfContents } from './content.js';
// Type-only import: erased at runtime, so no import cycle with response.ts.
import type { AgentResponse } from './response.js';

/**
 * Who authored a {@link Message}.
 *
 * The well-known values are listed for completion; any provider-specific string is accepted.
 */
export type Role = 'system' | 'user' | 'assistant' | 'tool' | (string & {});

/** A single turn in a conversation. */
export interface Message {
  role: Role;
  contents: Content[];
  messageId?: string;
  authorName?: string;
  /** ISO 8601 timestamp. */
  createdAt?: string;
  additionalProperties?: Record<string, unknown>;
  /** Provider-specific raw object. Never serialized. */
  rawRepresentation?: unknown;
}

/** Anything accepted as agent input; normalized to `Message[]` by {@link normalizeInput}. */
export type AgentRunInput = string | Content | Message | Array<string | Content | Message>;

/**
 * Builds a {@link Message}.
 *
 * @param role - The author role.
 * @param contents - A string (wrapped as {@link TextContent}) or a mixed array of strings and content items.
 */
export function message(role: Role, contents: string | Array<string | Content>): Message {
  const items = typeof contents === 'string' ? [contents] : contents;
  return {
    role,
    contents: items.map((item) => (typeof item === 'string' ? textContent(item) : item)),
  };
}

function isMessage(value: Content | Message): value is Message {
  return 'role' in value && 'contents' in value;
}

/**
 * Normalizes {@link AgentRunInput} into `Message[]`.
 *
 * Bare strings and content items become a single `user` message, preserving their relative order;
 * explicit {@link Message} values are passed through untouched.
 */
export function normalizeInput(input?: AgentRunInput): Message[] {
  if (input === undefined) {
    return [];
  }
  const items = Array.isArray(input) ? input : [input];
  const result: Message[] = [];
  let pending: Content[] = [];
  const flush = (): void => {
    if (pending.length > 0) {
      result.push({ role: 'user', contents: pending });
      pending = [];
    }
  };
  for (const item of items) {
    if (typeof item === 'string') {
      pending.push(textContent(item));
    } else if (isMessage(item)) {
      flush();
      result.push(item);
    } else {
      pending.push(item);
    }
  }
  flush();
  return result;
}

/** Concatenates the text of every message. */
export function textOfMessages(messages: readonly Message[]): string {
  let out = '';
  for (const msg of messages) {
    out += textOfContents(msg.contents);
  }
  return out;
}

/** Concatenates the text of a single message, or of every message in an agent response. */
export function textOf(value: Message | AgentResponse<unknown>): string {
  return 'messages' in value ? value.text : textOfContents(value.contents);
}

// region message source attribution

/**
 * The key under which message provenance is stored in {@link Message.additionalProperties}.
 *
 * Matches the reserved key used by the .NET (`AgentRequestMessageSourceAttribution.AdditionalPropertiesKey`)
 * and Python (`_attribution`) implementations so that transcripts stay interoperable.
 */
export const MESSAGE_SOURCE_KEY = '_attribution';

/** Where a message entered the run pipeline. Values match the .NET `AgentRequestMessageSourceType`. */
export type MessageSourceType = 'External' | 'ChatHistory' | 'AIContextProvider' | (string & {});

/** Provenance recorded on a message for a single agent run. */
export interface MessageSource {
  /** The kind of component that supplied the message. */
  sourceType: MessageSourceType;
  /** The `sourceId` of the specific provider instance, when the source is a provider. */
  sourceId?: string;
}

/** Reads the provenance stamped on `msg`, or `undefined` when the message came from the caller. */
export function getMessageSource(msg: Message): MessageSource | undefined {
  const raw = msg.additionalProperties?.[MESSAGE_SOURCE_KEY];
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const sourceType = record.sourceType;
  if (typeof sourceType !== 'string') {
    return undefined;
  }
  const sourceId = record.sourceId;
  return typeof sourceId === 'string' ? { sourceType, sourceId } : { sourceType };
}

/**
 * Returns a shallow copy of `msg` stamped with `source`.
 *
 * The caller's message object is never mutated, matching the reference implementations' rule that
 * the function-invocation and provider layers work on private copies.
 */
export function withMessageSource(msg: Message, source: MessageSource): Message {
  return {
    ...msg,
    additionalProperties: {
      ...msg.additionalProperties,
      [MESSAGE_SOURCE_KEY]: source.sourceId === undefined ? { sourceType: source.sourceType } : { ...source },
    },
  };
}

/**
 * Selects a subset of a message list by provenance.
 *
 * The TypeScript form of Go's `messagefilter.Filter`: history providers use them to decide what to
 * replay into a run and what to write back, so a provider is configured rather than subclassed.
 * Filters never mutate the input and are composed with {@link allOf} / {@link anyOf}.
 */
export type MessageFilter = (messages: readonly Message[]) => Message[];

function keep(predicate: (source: MessageSource | undefined) => boolean): MessageFilter {
  return (messages) => messages.filter((msg) => predicate(getMessageSource(msg)));
}

/** Keeps every message. Go `messagefilter.PassThrough`. */
export const passThrough: MessageFilter = (messages) => [...messages];

/** Drops every message. Go `messagefilter.None`. */
export const none: MessageFilter = () => [];

/**
 * Keeps only messages that came from outside the agent pipeline.
 *
 * An unstamped message counts as external: the caller's own input is never stamped, and only the
 * framework stamps what it injects. Go `messagefilter.ExternalOnly`.
 */
export const externalOnly: MessageFilter = keep(
  (source) => source === undefined || source.sourceType === 'External',
);

/** Keeps messages stamped with one of `types`. Go `messagefilter.Sources` at the type level. */
export function sourceTypes(...types: MessageSourceType[]): MessageFilter {
  const wanted = new Set<string>(types);
  return keep((source) => source !== undefined && wanted.has(source.sourceType));
}

/** Rejects messages stamped with any of `types`. Go `messagefilter.NotSourceTypes`. */
export function notSourceTypes(...types: MessageSourceType[]): MessageFilter {
  const excluded = new Set<string>(types);
  return keep((source) => source === undefined || !excluded.has(source.sourceType));
}

/** Keeps messages stamped by one of the named providers. Go `messagefilter.Sources`. */
export function sourceIds(...ids: string[]): MessageFilter {
  const wanted = new Set(ids);
  return keep((source) => source?.sourceId !== undefined && wanted.has(source.sourceId));
}

/** Rejects messages stamped by any of the named providers. Go `messagefilter.NotSources`. */
export function notSourceIds(...ids: string[]): MessageFilter {
  const excluded = new Set(ids);
  return keep((source) => source?.sourceId === undefined || !excluded.has(source.sourceId));
}

/** Applies every filter in turn, so a message must survive all of them. Go `messagefilter.And`. */
export function allOf(...filters: MessageFilter[]): MessageFilter {
  return (messages) => filters.reduce<Message[]>((current, filter) => filter(current), [...messages]);
}

/**
 * Keeps a message when at least one filter keeps it, in the original order.
 *
 * Go `messagefilter.Or`. Identity is by object reference, so a filter that rebuilds its messages
 * instead of selecting them does not compose here.
 */
export function anyOf(...filters: MessageFilter[]): MessageFilter {
  return (messages) => {
    const matched = new Set<Message>();
    for (const filter of filters) {
      for (const msg of filter(messages)) {
        matched.add(msg);
      }
    }
    return messages.filter((msg) => matched.has(msg));
  };
}

// endregion
