import { describe, expect, it } from 'vitest';
import { textContent } from './content.js';
import type { Message } from './message.js';
import {
  allOf,
  anyOf,
  externalOnly,
  getMessageSource,
  MESSAGE_SOURCE_KEY,
  none,
  notSourceIds,
  notSourceTypes,
  passThrough,
  sourceIds,
  sourceTypes,
  withMessageSource,
} from './message.js';

// The filter semantics are the TypeScript form of Go's `messagefilter` package: an unstamped
// message counts as external, composition never mutates the input, and `anyOf` keeps the
// original message order.

function msg(text: string): Message {
  return { role: 'user', contents: [textContent(text)] };
}

const external = msg('from the caller');
const stamped = withMessageSource(msg('from history'), { sourceType: 'ChatHistory' });
const fromProvider = withMessageSource(msg('from memory'), {
  sourceType: 'AIContextProvider',
  sourceId: 'memory-1',
});
const all = [external, stamped, fromProvider];

describe('source attribution', () => {
  it('reads back what withMessageSource stamped, with and without a provider id', () => {
    expect(getMessageSource(stamped)).toEqual({ sourceType: 'ChatHistory' });
    expect(getMessageSource(fromProvider)).toEqual({ sourceType: 'AIContextProvider', sourceId: 'memory-1' });
  });

  it('stamps a copy and leaves the original message untouched', () => {
    expect(external.additionalProperties).toBeUndefined();
    expect(getMessageSource(external)).toBeUndefined();
  });

  it('treats a malformed attribution as unstamped', () => {
    expect(
      getMessageSource({ ...msg('x'), additionalProperties: { [MESSAGE_SOURCE_KEY]: 'text' } }),
    ).toBeUndefined();
    expect(
      getMessageSource({ ...msg('x'), additionalProperties: { [MESSAGE_SOURCE_KEY]: { sourceType: 42 } } }),
    ).toBeUndefined();
    expect(
      getMessageSource({
        ...msg('x'),
        additionalProperties: { [MESSAGE_SOURCE_KEY]: { sourceType: 'ChatHistory', sourceId: 42 } },
      }),
    ).toEqual({ sourceType: 'ChatHistory' });
  });
});

describe('elementary filters', () => {
  it('passThrough keeps everything in a fresh array', () => {
    const result = passThrough(all);
    expect(result).toEqual(all);
    expect(result).not.toBe(all);
  });

  it('none drops everything', () => {
    expect(none(all)).toEqual([]);
  });

  it('externalOnly keeps unstamped and External messages', () => {
    const explicitExternal = withMessageSource(msg('stamped external'), { sourceType: 'External' });
    expect(externalOnly([...all, explicitExternal])).toEqual([external, explicitExternal]);
  });

  it('sourceTypes keeps only stamped matches, so unstamped messages drop out', () => {
    expect(sourceTypes('ChatHistory')(all)).toEqual([stamped]);
  });

  it('notSourceTypes keeps unstamped messages', () => {
    expect(notSourceTypes('ChatHistory')(all)).toEqual([external, fromProvider]);
  });

  it('sourceIds matches only messages a named provider stamped', () => {
    expect(sourceIds('memory-1')(all)).toEqual([fromProvider]);
    expect(sourceIds('other')(all)).toEqual([]);
  });

  it('notSourceIds keeps messages with no provider id at all', () => {
    expect(notSourceIds('memory-1')(all)).toEqual([external, stamped]);
  });
});

describe('composition', () => {
  it('allOf requires a message to survive every filter in turn', () => {
    expect(allOf(notSourceTypes('ChatHistory'), notSourceIds('memory-1'))(all)).toEqual([external]);
    expect(allOf()(all)).toEqual(all);
  });

  it('anyOf unions matches while preserving the original order', () => {
    // The union matches in filter order, but the result follows the transcript order.
    expect(anyOf(sourceIds('memory-1'), sourceTypes('ChatHistory'))(all)).toEqual([stamped, fromProvider]);
    expect(anyOf()(all)).toEqual([]);
  });
});
