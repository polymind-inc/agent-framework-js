import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../errors.js';
import { AgentSession } from './session.js';

describe('AgentSession.fromJSON', () => {
  it('round-trips a session through JSON', () => {
    const session = new AgentSession({ sessionId: 's-1', serviceSessionId: 'conv-1' });
    session.partition('history').messages = [{ role: 'user' }];

    const restored = AgentSession.fromJSON(JSON.parse(JSON.stringify(session)) as unknown);

    expect(restored.sessionId).toBe('s-1');
    expect(restored.serviceSessionId).toBe('conv-1');
    expect(restored.state).toEqual({ history: { messages: [{ role: 'user' }] } });
    expect(JSON.parse(JSON.stringify(restored))).toEqual(JSON.parse(JSON.stringify(session)));
  });

  it('round-trips a session without a serviceSessionId', () => {
    const session = new AgentSession({ sessionId: 's-2' });
    const restored = AgentSession.fromJSON(JSON.parse(JSON.stringify(session)) as unknown);
    expect(restored.serviceSessionId).toBeUndefined();
    expect(restored.state).toEqual({});
  });

  it('rejects a payload whose discriminator is not "session"', () => {
    // Without this check any object carrying a `sessionId` string is accepted as a session —
    // including a checkpoint, a provider payload, or an attacker-chosen document.
    expect(() => AgentSession.fromJSON({ sessionId: 's-1', state: {} })).toThrow(ConfigurationError);
    expect(() => AgentSession.fromJSON({ type: 'checkpoint', sessionId: 's-1', state: {} })).toThrow(
      ConfigurationError,
    );
    expect(() => AgentSession.fromJSON({ type: 'Session', sessionId: 's-1', state: {} })).toThrow(
      ConfigurationError,
    );
  });

  it('requires the discriminator to be an own property', () => {
    const inherited = Object.create({ type: 'session' }) as Record<string, unknown>;
    inherited.sessionId = 's-1';
    inherited.state = {};
    expect(() => AgentSession.fromJSON(inherited)).toThrow(ConfigurationError);
  });

  it('rejects an array state instead of adopting it', () => {
    // `typeof [] === 'object'`, so an array used to pass as `state`. Named properties written onto
    // an array (every `partition()` call does exactly that) are dropped by `JSON.stringify`, so the
    // next save silently loses the whole transcript and the approval bookkeeping with it.
    expect(() => AgentSession.fromJSON({ type: 'session', sessionId: 's-1', state: [] })).toThrow(
      ConfigurationError,
    );
    expect(() => AgentSession.fromJSON({ type: 'session', sessionId: 's-1', state: [{ a: 1 }] })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects a null or primitive state instead of defaulting to an empty one', () => {
    for (const state of [null, 'state', 42, true]) {
      expect(() => AgentSession.fromJSON({ type: 'session', sessionId: 's-1', state })).toThrow(
        ConfigurationError,
      );
    }
  });

  it('rejects built-in and class instances that do not serialize as records', () => {
    class CustomState {
      value = 1;
    }

    for (const state of [new Date(), new Map([['key', 'value']]), new Set(['value']), new CustomState()]) {
      expect(() => AgentSession.fromJSON({ type: 'session', sessionId: 's-1', state })).toThrow(
        ConfigurationError,
      );
    }
  });

  it('accepts a null-prototype state record', () => {
    const state = Object.assign(Object.create(null) as Record<string, unknown>, { value: 1 });
    const restored = AgentSession.fromJSON({ type: 'session', sessionId: 's-1', state });
    expect(restored.state).toBe(state);
  });

  it('rejects a missing state', () => {
    expect(() => AgentSession.fromJSON({ type: 'session', sessionId: 's-1' })).toThrow(ConfigurationError);
  });

  it('rejects a non-string sessionId', () => {
    for (const sessionId of [undefined, null, 42, {}, ['s-1']]) {
      expect(() => AgentSession.fromJSON({ type: 'session', sessionId, state: {} })).toThrow(
        ConfigurationError,
      );
    }
  });

  it('rejects a serviceSessionId that is present but not a string', () => {
    // Silently dropping it turns a service-managed session into a framework-managed one: the next
    // run replays a transcript the service also holds, or starts a second conversation.
    for (const serviceSessionId of [null, 42, {}, ['conv-1']]) {
      expect(() =>
        AgentSession.fromJSON({ type: 'session', sessionId: 's-1', state: {}, serviceSessionId }),
      ).toThrow(ConfigurationError);
    }
  });

  it('accepts an explicitly undefined serviceSessionId', () => {
    const restored = AgentSession.fromJSON({
      type: 'session',
      sessionId: 's-1',
      state: {},
      serviceSessionId: undefined,
    });
    expect(restored.serviceSessionId).toBeUndefined();
  });

  it('rejects a non-object payload', () => {
    for (const data of [null, undefined, 'session', 42, []]) {
      expect(() => AgentSession.fromJSON(data)).toThrow(ConfigurationError);
    }
  });

  it('keeps unknown state keys, including ones named like prototype members', () => {
    // Unknown data round-trips. A `__proto__` key parsed out of JSON is an own data
    // property and must stay one.
    const wire = JSON.parse('{"type":"session","sessionId":"s-1","state":{"__proto__":{"a":1}}}') as unknown;
    const restored = AgentSession.fromJSON(wire);
    expect(Object.getPrototypeOf(restored.state)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(restored))).toEqual({
      type: 'session',
      sessionId: 's-1',
      state: { ['__proto__']: { a: 1 } },
    });
  });
});

describe('AgentSession.partition', () => {
  it('never hands back an inherited object as a partition', () => {
    // `state.__proto__` resolves to `Object.prototype` on any ordinary object, so reading the
    // partition without an own-property check would return the global prototype and let a provider
    // write into it.
    const session = new AgentSession();
    const partition = session.partition('__proto__');

    expect(partition).not.toBe(Object.prototype);
    expect(Object.hasOwn(session.state, '__proto__')).toBe(true);
    partition.marker = 1;
    expect((Object.prototype as Record<string, unknown>).marker).toBeUndefined();
    expect(Object.getPrototypeOf(session.state)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(session)).state).toEqual({ ['__proto__']: { marker: 1 } });
  });

  it('returns the same partition on repeated calls', () => {
    const session = new AgentSession();
    const first = session.partition('history');
    first.value = 1;
    expect(session.partition('history')).toBe(first);
  });
});
