import { describe, expect, it } from 'vitest';
import { unknownContent } from './content.js';
import type { Message } from './message.js';
import { deserializeMessage, serializeContent, serializeMessage } from './serialization.js';

/** Narrows away undefined; a missing value fails the test with a clear error. */
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value');
  return value;
}

describe('message serialization', () => {
  it('drops rawRepresentation from the message and from every content item', () => {
    const msg: Message = {
      role: 'assistant',
      messageId: 'm1',
      rawRepresentation: { sdk: 'object' },
      contents: [
        { type: 'text', text: 'hi', rawRepresentation: { sdk: 'part' } },
        {
          type: 'text',
          text: 'cited',
          annotations: [{ type: 'citation', url: 'https://example.com', rawRepresentation: { a: 1 } }],
        },
      ],
    };

    const wire = serializeMessage(msg);
    expect(wire).not.toHaveProperty('rawRepresentation');
    expect(wire.contents[0]).not.toHaveProperty('rawRepresentation');
    expect((must(wire.contents[1]).annotations as unknown[])[0]).not.toHaveProperty('rawRepresentation');
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
  });

  it('round-trips an unknown content type without losing fields', () => {
    const wire = {
      role: 'assistant',
      contents: [
        { type: 'text', text: 'known' },
        { type: 'brand_new_content', someField: 42, nested: { deep: true } },
      ],
    };

    const message = deserializeMessage(wire);
    expect(message.contents[1]).toMatchObject({
      type: 'unknown',
      unknownType: 'brand_new_content',
      someField: 42,
    });

    expect(serializeMessage(message)).toEqual(wire);
  });

  it('round-trips unknown fields on a known content type', () => {
    const wire = { type: 'text', text: 'hi', futureField: ['a', 'b'] };
    expect(serializeContent(deserializeContentHelper(wire))).toEqual(wire);
  });

  it('keeps nested content items inside a function result', () => {
    const wire = {
      role: 'tool',
      contents: [
        {
          type: 'function_result',
          callId: 'c1',
          items: [{ type: 'unheard_of', payload: 1 }],
        },
      ],
    };
    expect(serializeMessage(deserializeMessage(wire))).toEqual(wire);
  });

  it('round-trips a plain-JSON tool result carrying type keys untouched', () => {
    // A tool result is arbitrary JSON. `[{type: 'row', id: 1}]` merely happens to carry a `type`
    // key; rewriting it to `{type: 'unknown', unknownType: 'row', ...}` on deserialization would
    // hand the model corrupted data when the session is re-sent.
    const msg: Message = {
      role: 'tool',
      contents: [{ type: 'function_result', callId: 'c1', result: [{ type: 'row', id: 1 }] }],
    };

    expect(deserializeMessage(serializeMessage(msg))).toEqual(msg);
  });

  it('round-trips a single plain-JSON object result carrying a type key untouched', () => {
    const msg: Message = {
      role: 'tool',
      contents: [{ type: 'function_result', callId: 'c1', result: { type: 'row', id: 1 } }],
    };

    expect(deserializeMessage(serializeMessage(msg))).toEqual(msg);
  });

  it('strips rawRepresentation from Content values inside a function result result', () => {
    const circular: Record<string, unknown> = { type: 'sdk_block' };
    circular.self = circular;
    const wire = serializeContent({
      type: 'function_result',
      callId: 'c1',
      result: [{ type: 'text', text: 'from a tool', rawRepresentation: circular }],
    });

    const result = wire.result as Array<Record<string, unknown>>;
    expect(result[0]).not.toHaveProperty('rawRepresentation');
    expect(() => JSON.stringify(wire)).not.toThrow();
  });

  it('drops rawRepresentation inside an mcp_server_tool_result output', () => {
    // `output` carries a Content list (Python `fields_to_capture` includes it and recurses
    // structurally), so the "dropped at every level" contract has to hold inside it too.
    const wire = serializeContent({
      type: 'mcp_server_tool_result',
      callId: 'c1',
      output: [{ type: 'text', text: 'from mcp', rawRepresentation: { sdk: 'block' } }],
      rawRepresentation: { sdk: 'outer' },
    });

    expect(wire).not.toHaveProperty('rawRepresentation');
    expect((wire.output as unknown[])[0]).not.toHaveProperty('rawRepresentation');
  });

  it('serializes an mcp_server_tool_result whose output rawRepresentation is circular', () => {
    // A provider SDK is free to hand back class instances or self-referencing objects; if the
    // nested rawRepresentation survives, persisting the session throws.
    const circular: Record<string, unknown> = { type: 'mcp_tool_result' };
    circular.self = circular;
    const msg: Message = {
      role: 'assistant',
      contents: [
        {
          type: 'mcp_server_tool_result',
          callId: 'c1',
          output: [{ type: 'text', text: 'from mcp', rawRepresentation: circular }],
          rawRepresentation: circular,
        },
      ],
    };

    expect(() => JSON.stringify(serializeMessage(msg))).not.toThrow();
  });

  it('round-trips an unknown content type inside an mcp_server_tool_result output', () => {
    // Same key set drives deserializeContent, so a nested unknown type must come back as the
    // original wire type rather than as `{ type: 'unknown', unknownType: ... }`.
    const wire = {
      role: 'assistant',
      contents: [
        {
          type: 'mcp_server_tool_result',
          callId: 'c1',
          output: [
            { type: 'text', text: 'known' },
            { type: 'brand_new_block', payload: 7 },
          ],
        },
      ],
    };

    const message = deserializeMessage(wire);
    const output = (message.contents[0] as { output: unknown[] }).output;
    expect(output[1]).toMatchObject({ type: 'unknown', unknownType: 'brand_new_block', payload: 7 });
    expect(serializeMessage(message)).toEqual(wire);
  });

  it('restores the wire type of an UnknownContent produced inside an mcp_server_tool_result output', () => {
    // The Anthropic client parses unmodelled blocks (e.g. `redacted_thinking`) into UnknownContent
    // and nests them under `output`; serializing must put the wire type back.
    const serialized = serializeContent({
      type: 'mcp_server_tool_result',
      callId: 'c1',
      output: [{ type: 'unknown', unknownType: 'redacted_thinking', data: { d: 1 } }],
    });

    expect((serialized.output as Record<string, unknown>[])[0]).toEqual({
      type: 'redacted_thinking',
      data: { d: 1 },
    });
  });

  it('drops rawRepresentation inside code_interpreter outputs (control: already recursed)', () => {
    const wire = serializeContent({
      type: 'code_interpreter_tool_result',
      callId: 'c1',
      outputs: [{ type: 'text', text: 'stdout', rawRepresentation: { sdk: 'log' } }],
    });

    expect((wire.outputs as unknown[])[0]).not.toHaveProperty('rawRepresentation');
  });

  it('leaves a non-content output untouched (backward compatibility)', () => {
    const wire = {
      role: 'assistant',
      contents: [
        { type: 'mcp_server_tool_result', callId: 'c1', output: 'plain string' },
        { type: 'mcp_server_tool_result', callId: 'c2', output: 42 },
      ],
    };
    expect(serializeMessage(deserializeMessage(wire))).toEqual(wire);
  });

  it('leaves an arbitrary JSON object in output untouched', () => {
    // `output` is typed `unknown` and real producers put plain results there, so recursing into
    // every record turned `{answer: 42}` into `{answer: 42, type: ''}` — it was read as an
    // untyped content item and given back the wire `type` it never had. Only values actually
    // shaped like content may be recursed into, or the round-trip contract breaks.
    const wire = {
      role: 'assistant',
      contents: [{ type: 'mcp_server_tool_result', callId: 'c1', output: { answer: 42 } }],
    };
    expect(serializeMessage(deserializeMessage(wire))).toEqual(wire);
  });

  it('leaves an array of arbitrary JSON objects in output untouched', () => {
    const wire = {
      role: 'assistant',
      contents: [
        {
          type: 'mcp_server_tool_result',
          callId: 'c1',
          output: [{ answer: 42 }, { nested: { deep: true } }, 'text', 7],
        },
      ],
    };
    expect(serializeMessage(deserializeMessage(wire))).toEqual(wire);
  });

  it('still recurses into an output that is a real Content list', () => {
    // The guard must not cost the nested stripping guarantees: nested rawRepresentation still
    // goes, and a nested unknown wire type still round-trips.
    const stripped = serializeContent({
      type: 'mcp_server_tool_result',
      callId: 'c1',
      output: [
        { type: 'text', text: 'hi', rawRepresentation: { sdk: 'block' } },
        { type: 'unknown', unknownType: 'redacted_thinking', data: 'x' } as never,
      ],
    });

    const items = stripped.output as Array<Record<string, unknown>>;
    expect(items[0]).not.toHaveProperty('rawRepresentation');
    expect(items[1]?.type).toBe('redacted_thinking');
  });

  it('treats an object with a string type in output as content, losslessly', () => {
    // Ambiguous by construction — `{type: 'foo'}` is indistinguishable from an unmodelled content
    // item — but it round-trips either way, so the ambiguity costs nothing on the wire.
    const wire = {
      role: 'assistant',
      contents: [{ type: 'mcp_server_tool_result', callId: 'c1', output: { type: 'foo', value: 1 } }],
    };
    expect(serializeMessage(deserializeMessage(wire))).toEqual(wire);
  });

  it('serializes the userInputRequest marker on approval and consent contents', () => {
    // Python filters `user_input_requests` on this flag after rehydration, so dropping it from
    // the wire would hide pending approvals from a cross-language consumer.
    const wire = {
      role: 'assistant',
      contents: [
        {
          type: 'function_approval_request',
          id: 'ficc_c1',
          userInputRequest: true,
          functionCall: { type: 'function_call', callId: 'c1', name: 'wipe', arguments: '{}' },
        },
        { type: 'oauth_consent_request', consentLink: 'https://consent', userInputRequest: true },
      ],
    };
    expect(serializeMessage(deserializeMessage(wire))).toEqual(wire);
  });
});

describe('unknownContent', () => {
  // The shape three provider packages got wrong independently, which is why it lives here now:
  // the round trip below is the whole contract, and it is core's serializer that has to close it.
  it('round-trips an arbitrary wire object through serialization', () => {
    const wire = {
      type: 'future_tool_call',
      id: 'ftc_abc123',
      server: { name: 'search', region: 'westus' },
      queries: ['a', { nested: true }, null],
      error: null,
      count: 7,
    };

    expect(serializeContent(unknownContent(wire))).toEqual(wire);
  });

  it('keeps the payload reachable without rawRepresentation', () => {
    // `rawRepresentation` is debugging detail — it is dropped on serialization — so the
    // fields have to sit at the top level or a persisted session loses them.
    const content = unknownContent({ type: 'future_block', id: 'blk_1' });

    expect(content.id).toBe('blk_1');
    expect(content.unknownType).toBe('future_block');
    expect(content.rawRepresentation).toEqual({ type: 'future_block', id: 'blk_1' });
  });

  it("uses core's empty-string sentinel when the wire type is not a string", () => {
    // The same value `deserializeContent` produces, so a value off the wire and one restored from
    // a snapshot are indistinguishable.
    expect(unknownContent({ type: 7, a: 1 }).unknownType).toBe('');
    expect(unknownContent({ a: 1 }).unknownType).toBe('');
  });

  it('accepts a value that is not an object at all', () => {
    // Providers hand it whatever the wire produced; a null or a string must not throw.
    expect(unknownContent(null)).toMatchObject({ type: 'unknown', unknownType: '' });
    expect(unknownContent('nope')).toMatchObject({ type: 'unknown', unknownType: '' });
    expect(unknownContent([1, 2])).toMatchObject({ type: 'unknown', unknownType: '' });
  });

  it('does not let a wire field shadow the fields core owns', () => {
    const content = unknownContent({ type: 'future', unknownType: 'spoofed', rawRepresentation: 'x' });

    expect(content.unknownType).toBe('future');
    expect(content.rawRepresentation).toEqual({
      type: 'future',
      unknownType: 'spoofed',
      rawRepresentation: 'x',
    });
  });
});

// Small helper so the test reads naturally without importing deserializeContent separately.
function deserializeContentHelper(
  data: Record<string, unknown>,
): ReturnType<typeof deserializeMessage>['contents'][number] {
  return must(deserializeMessage({ role: 'assistant', contents: [data] }).contents[0]);
}
