import { describe, expect, it } from 'vitest';
import { computeBackoffSeconds, truncatePayloadForLedger } from './dispatcher';

/**
 * Pure-logic tests for the tracking dispatcher. DB-bound code paths
 * are exercised in the worker integration smoke; these lock the
 * arithmetic + serialization that decide retry cadence and ledger
 * row size.
 */

describe('computeBackoffSeconds — base curve', () => {
  it('attempt 1 with no jitter sits at the base (30s)', () => {
    // jitterSample=0 → multiplier 0.8 → 30 * 0.8 = 24s
    expect(computeBackoffSeconds(1, 0)).toBeCloseTo(24);
  });

  it('attempt 1 mid jitter lands on the base value (30s)', () => {
    // jitterSample=0.5 → multiplier 1.0 → 30s exact
    expect(computeBackoffSeconds(1, 0.5)).toBeCloseTo(30);
  });

  it('attempt 2 doubles the base', () => {
    expect(computeBackoffSeconds(2, 0.5)).toBeCloseTo(60);
  });

  it('attempt 6 caps at 1 hour (3600s) before jitter', () => {
    // 30 * 2^5 = 960 — still below the cap
    expect(computeBackoffSeconds(6, 0.5)).toBeCloseTo(960);
  });

  it('attempt 10 hits the 3600s cap', () => {
    // 30 * 2^9 = 15360 → capped at 3600 → with mid jitter = 3600s
    expect(computeBackoffSeconds(10, 0.5)).toBeCloseTo(3600);
  });

  it('honors the ±20% jitter band', () => {
    expect(computeBackoffSeconds(3, 0)).toBeCloseTo(120 * 0.8);
    expect(computeBackoffSeconds(3, 0.999)).toBeLessThan(120 * 1.2);
    expect(computeBackoffSeconds(3, 0.999)).toBeGreaterThan(120 * 1.19);
  });
});

describe('truncatePayloadForLedger — size guard', () => {
  it('returns null when input is null/undefined', () => {
    expect(truncatePayloadForLedger(null)).toBeNull();
    expect(truncatePayloadForLedger(undefined)).toBeNull();
  });

  it('passes small payloads through unchanged', () => {
    const payload = { ok: true, n: 42 };
    expect(truncatePayloadForLedger(payload)).toEqual(payload);
  });

  it('truncates payloads larger than 8 KB', () => {
    const huge = { blob: 'x'.repeat(10_000) };
    const out = truncatePayloadForLedger(huge) as { truncated: boolean; head: string };
    expect(out.truncated).toBe(true);
    expect(out.head.length).toBeLessThanOrEqual(8000);
  });

  it('returns null for circular / unserializable inputs', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(truncatePayloadForLedger(circular)).toBeNull();
  });
});
