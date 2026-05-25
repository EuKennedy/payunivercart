import { describe, expect, it } from 'vitest';
import { computeCommissionCents } from './tracker';

/**
 * Edge cases beyond the original `tracker.test.ts` happy paths.
 * These lock down behaviour producers will hit in real payout
 * disputes — fractional cents, BigInt overflow boundaries,
 * percentage at the limit, mixed shapes.
 */

describe('computeCommissionCents — fractional truncation', () => {
  it('1 cent gross at 50% rounds down to 0', () => {
    // 1 * 50 / 100 = 0.5 → truncates to 0n
    expect(computeCommissionCents(1n, 'percent', 50, null)).toBe(0n);
  });

  it('3 cent gross at 33% rounds down (no half-cent gift)', () => {
    // 3 * 33 / 100 = 0.99 → truncates to 0n
    expect(computeCommissionCents(3n, 'percent', 33, null)).toBe(0n);
  });

  it('100 cent gross at 33% returns 33 (exact)', () => {
    expect(computeCommissionCents(100n, 'percent', 33, null)).toBe(33n);
  });

  it('101 cent gross at 33% returns 33 (truncate, not round)', () => {
    // 101 * 33 = 3333; / 100 = 33.33 → 33n
    expect(computeCommissionCents(101n, 'percent', 33, null)).toBe(33n);
  });
});

describe('computeCommissionCents — boundary values', () => {
  it('100% commission gives back the full gross', () => {
    expect(computeCommissionCents(99_90n, 'percent', 100, null)).toBe(99_90n);
  });

  it('percent > 100 still applies (producer choice, no clamp)', () => {
    // We do NOT clamp at 100% — producers running referral overrides
    // sometimes legitimately give 110% as a launch incentive.
    expect(computeCommissionCents(100_00n, 'percent', 110, null)).toBe(110_00n);
  });

  it('huge gross + 1% works without precision loss', () => {
    // R$ 1,000,000,000.00 → 1e11 cents → 1% → R$ 10,000,000.00
    expect(computeCommissionCents(100_000_000_000n, 'percent', 1, null)).toBe(1_000_000_000n);
  });
});

describe('computeCommissionCents — recurring + lifetime semantics', () => {
  // The kernel doesn't track cycle limits (caller's job) — it just
  // computes per-cycle amount. These tests pin the percentage math
  // behaves identically across the four type values.
  it('recurring uses percent math', () => {
    expect(computeCommissionCents(99_90n, 'recurring', 30, null)).toBe(
      computeCommissionCents(99_90n, 'percent', 30, null),
    );
  });

  it('lifetime uses percent math', () => {
    expect(computeCommissionCents(99_90n, 'lifetime', 30, null)).toBe(
      computeCommissionCents(99_90n, 'percent', 30, null),
    );
  });

  it('recurring with null percent → 0', () => {
    expect(computeCommissionCents(99_90n, 'recurring', null, null)).toBe(0n);
  });
});

describe('computeCommissionCents — type ambiguity guards', () => {
  it('flat with positive flatCents wins even when percent ALSO supplied', () => {
    // Producer might leave percent populated by accident when
    // switching commission types. Type must be the discriminator.
    expect(computeCommissionCents(100_00n, 'flat', 99, 5_00n)).toBe(5_00n);
  });

  it('percent ignores stale flatCents value', () => {
    expect(computeCommissionCents(100_00n, 'percent', 10, 99_00n)).toBe(10_00n);
  });
});
