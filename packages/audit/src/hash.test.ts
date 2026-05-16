import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuditError } from './errors';
import { computeChainHash, hashesEqual } from './hash';

const KEY_A = new Uint8Array(randomBytes(32));
const KEY_B = new Uint8Array(randomBytes(32));

describe('computeChainHash', () => {
  it('is deterministic for the same inputs', () => {
    const a = computeChainHash(KEY_A, 'abc', '{"k":1}');
    const b = computeChainHash(KEY_A, 'abc', '{"k":1}');
    expect(a).toBe(b);
  });

  it('produces a 64-char lowercase hex string (SHA-256)', () => {
    const out = computeChainHash(KEY_A, null, '{"k":1}');
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the key changes (different HMAC space)', () => {
    expect(computeChainHash(KEY_A, null, '{"k":1}')).not.toBe(
      computeChainHash(KEY_B, null, '{"k":1}'),
    );
  });

  it('changes when the payload changes', () => {
    expect(computeChainHash(KEY_A, null, '{"k":1}')).not.toBe(
      computeChainHash(KEY_A, null, '{"k":2}'),
    );
  });

  it('changes when the previous hash changes', () => {
    expect(computeChainHash(KEY_A, 'aaaa', '{"k":1}')).not.toBe(
      computeChainHash(KEY_A, 'bbbb', '{"k":1}'),
    );
  });

  it('null and empty-string previousHash produce the same HMAC (verifier blocks the gap)', () => {
    // Updating HMAC with an empty string is a no-op, so byte-equal output is
    // expected here. The chain verifier (`AuditService.verify`) blocks the
    // genesis-vs-continuation confusion at a higher layer via the explicit
    // `previousHashMatches(actual, expected)` shape check (null !== ""), so
    // this property is benign for the design.
    expect(computeChainHash(KEY_A, null, '{"k":1}')).toBe(computeChainHash(KEY_A, '', '{"k":1}'));
  });

  it('throws on wrong-length key', () => {
    expect(() => computeChainHash(new Uint8Array(16), null, '{}')).toThrowError(AuditError);
  });
});

describe('hashesEqual', () => {
  it('returns true for byte-equal hashes', () => {
    const h = computeChainHash(KEY_A, null, '{}');
    expect(hashesEqual(h, h)).toBe(true);
  });

  it('returns false for different hashes', () => {
    expect(
      hashesEqual(
        computeChainHash(KEY_A, null, '{"k":1}'),
        computeChainHash(KEY_A, null, '{"k":2}'),
      ),
    ).toBe(false);
  });

  it('returns false for different-length strings', () => {
    expect(hashesEqual('aabb', 'aabbcc')).toBe(false);
  });
});
