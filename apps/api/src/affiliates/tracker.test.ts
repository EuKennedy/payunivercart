import { describe, expect, it } from 'vitest';
import { computeCommissionCents } from './tracker';

/**
 * Unit tests for the commission-math kernel. The DB-bound surface of
 * the affiliate tracker is exercised in the integration smoke run
 * (separate suite gated on TEST_DATABASE_URL); these tests focus on
 * the pure arithmetic that decides "how much money does the affiliate
 * actually get" — the layer where rounding bugs translate directly
 * into payout disputes.
 */

describe('computeCommissionCents — flat', () => {
  it('returns the flat amount when positive', () => {
    expect(computeCommissionCents(100_00n, 'flat', null, 15_00n)).toBe(15_00n);
  });

  it('returns 0 when flatCents is null', () => {
    expect(computeCommissionCents(100_00n, 'flat', null, null)).toBe(0n);
  });

  it('returns 0 when flatCents is zero or negative', () => {
    expect(computeCommissionCents(100_00n, 'flat', null, 0n)).toBe(0n);
    expect(computeCommissionCents(100_00n, 'flat', null, -50n)).toBe(0n);
  });

  it('ignores the percent value when type=flat', () => {
    // percent=99 should have zero effect on the flat result
    expect(computeCommissionCents(100_00n, 'flat', 99, 7_00n)).toBe(7_00n);
  });
});

describe('computeCommissionCents — percent', () => {
  it('applies an integer percent to gross', () => {
    // R$ 100,00 * 30% = R$ 30,00
    expect(computeCommissionCents(100_00n, 'percent', 30, null)).toBe(30_00n);
  });

  it('truncates fractional cents (no rounding-up surprise on payouts)', () => {
    // R$ 1,99 * 33% = 0,6567 → truncate to 65 cents (no half-cent bump)
    expect(computeCommissionCents(199n, 'percent', 33, null)).toBe(65n);
  });

  it('returns 0 when percent is null or non-positive', () => {
    expect(computeCommissionCents(100_00n, 'percent', null, null)).toBe(0n);
    expect(computeCommissionCents(100_00n, 'percent', 0, null)).toBe(0n);
    expect(computeCommissionCents(100_00n, 'percent', -10, null)).toBe(0n);
  });

  it('handles large gross amounts without precision loss (BigInt)', () => {
    // R$ 10.000.000,00 * 50% = R$ 5.000.000,00 — would overflow Number
    expect(computeCommissionCents(1_000_000_000n, 'percent', 50, null)).toBe(500_000_000n);
  });

  it('ignores the flatCents value when type=percent', () => {
    expect(computeCommissionCents(100_00n, 'percent', 25, 9_99n)).toBe(25_00n);
  });
});

describe('computeCommissionCents — guards', () => {
  it('returns 0 for a zero gross', () => {
    expect(computeCommissionCents(0n, 'percent', 30, null)).toBe(0n);
    expect(computeCommissionCents(0n, 'flat', null, 10_00n)).toBe(0n);
  });

  it('returns 0 for a negative gross (defensive — DB constraint blocks this)', () => {
    expect(computeCommissionCents(-1n, 'percent', 30, null)).toBe(0n);
    expect(computeCommissionCents(-1n, 'flat', null, 10_00n)).toBe(0n);
  });
});
