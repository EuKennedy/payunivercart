import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonical.js';
import { AuditError } from './errors.js';

describe('canonicalize — determinism', () => {
  it('sorts object keys lexicographically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ z: { c: 3, a: 1 }, a: 1 })).toBe('{"a":1,"z":{"a":1,"c":3}}');
  });

  it('produces byte-equal output for equivalent inputs', () => {
    const a = canonicalize({ id: 'order_1', amount: 100, currency: 'BRL' });
    const b = canonicalize({ currency: 'BRL', amount: 100, id: 'order_1' });
    expect(a).toBe(b);
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('serializes Date as ISO-8601 UTC', () => {
    const d = new Date('2026-05-15T12:34:56.789Z');
    expect(canonicalize({ when: d })).toBe('{"when":"2026-05-15T12:34:56.789Z"}');
  });

  it('strips top-level keys with undefined values (matches JSON.stringify semantics)', () => {
    expect(canonicalize({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}');
  });

  it('normalizes -0 to 0', () => {
    expect(canonicalize({ a: -0 })).toBe('{"a":0}');
    expect(canonicalize({ a: 0 })).toBe('{"a":0}');
  });
});

describe('canonicalize — rejected inputs', () => {
  it('rejects NaN', () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrowError(AuditError);
  });

  it('rejects +Infinity / -Infinity', () => {
    expect(() => canonicalize({ a: Number.POSITIVE_INFINITY })).toThrowError(AuditError);
    expect(() => canonicalize({ a: Number.NEGATIVE_INFINITY })).toThrowError(AuditError);
  });

  it('rejects bigint', () => {
    expect(() => canonicalize({ a: 1n })).toThrowError(AuditError);
  });

  it('rejects symbol', () => {
    expect(() => canonicalize({ a: Symbol('x') })).toThrowError(AuditError);
  });

  it('rejects function', () => {
    expect(() => canonicalize({ a: () => 1 })).toThrowError(AuditError);
  });

  it('rejects circular references', () => {
    const root: Record<string, unknown> = { name: 'root' };
    root.self = root;
    try {
      canonicalize(root);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditError);
      expect((err as AuditError).auditCode).toBe('CANONICAL_CYCLE');
    }
  });
});

describe('canonicalize — edge cases', () => {
  it('handles deeply nested objects', () => {
    const deep = { a: { b: { c: { d: { e: 'leaf' } } } } };
    expect(canonicalize(deep)).toBe('{"a":{"b":{"c":{"d":{"e":"leaf"}}}}}');
  });

  it('handles mixed types', () => {
    expect(canonicalize({ s: 'x', n: 1, b: true, z: null, a: [1, 'two', { k: 3 }] })).toBe(
      '{"a":[1,"two",{"k":3}],"b":true,"n":1,"s":"x","z":null}',
    );
  });

  it('handles empty containers', () => {
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([])).toBe('[]');
  });

  it('escapes special string characters per JSON', () => {
    expect(canonicalize('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });
});
