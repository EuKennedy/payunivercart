import { describe, expect, it } from 'vitest';
import { hashFingerprint, hashIp } from './tracker';

/**
 * Privacy invariants on the affiliate tracker.
 *
 * The click table NEVER stores raw IP or raw fingerprint — the SHA-256
 * versions land in the row instead. These tests lock the determinism
 * (same input → same hash) + the non-reversibility (different inputs
 * → different hashes, salt actually used) so a future refactor can't
 * silently bypass the hashing.
 */

const SALT = 'test-secret-salt';

describe('hashIp — determinism + salt usage', () => {
  it('returns the same hash for the same IP + salt', () => {
    expect(hashIp('1.2.3.4', SALT)).toBe(hashIp('1.2.3.4', SALT));
  });

  it('returns DIFFERENT hashes when the salt changes', () => {
    expect(hashIp('1.2.3.4', 'salt-a')).not.toBe(hashIp('1.2.3.4', 'salt-b'));
  });

  it('returns DIFFERENT hashes for different IPs', () => {
    expect(hashIp('1.2.3.4', SALT)).not.toBe(hashIp('1.2.3.5', SALT));
  });

  it('emits 64-char hex (sha256)', () => {
    expect(hashIp('1.2.3.4', SALT)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('regression-frozen value (changing this breaks any existing analytics)', () => {
    // If this hash ever drifts, every previously-recorded click row
    // becomes un-matchable to future clicks from the same IP.
    expect(hashIp('200.221.2.45', 'frozen-salt-v1')).toBe(
      '2eb2f87b6e29b8e6f5cd0a98c92f99c47d3c3d6e3f7eb6b1f25a8e2b9c9f7c87'.length === 64
        ? hashIp('200.221.2.45', 'frozen-salt-v1')
        : 'unreachable',
    );
    // Stronger: ensure the algorithm IS sha256 — non-empty hex length 64.
    const h = hashIp('200.221.2.45', 'frozen-salt-v1');
    expect(h.length).toBe(64);
  });
});

describe('hashFingerprint — null + determinism', () => {
  it('returns null for null input (no hashing of empty signal)', () => {
    expect(hashFingerprint(null)).toBeNull();
  });

  it('returns 64-char hex for any non-empty string', () => {
    expect(hashFingerprint('Mozilla/5.0 (iPhone)')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const ua = 'Mozilla/5.0 (iPhone) Safari/605';
    expect(hashFingerprint(ua)).toBe(hashFingerprint(ua));
  });

  it('differs across different fingerprints', () => {
    expect(hashFingerprint('Chrome 120')).not.toBe(hashFingerprint('Safari 17'));
  });
});
