import { describe, expect, it, vi } from 'vitest';
import { mapStripeStatus } from './stripe.js';

describe('mapStripeStatus', () => {
  it.each([
    ['requires_payment_method', 'pending'],
    ['requires_confirmation', 'pending'],
    ['requires_action', 'pending'],
    ['processing', 'processing'],
    ['requires_capture', 'authorized'],
    ['succeeded', 'paid'],
    ['canceled', 'cancelled'],
  ] as const)('maps Stripe status %s -> %s', (input, expected) => {
    expect(mapStripeStatus(input)).toBe(expected);
  });

  it('falls back to "pending" and warns on unknown future status', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Cast through unknown to simulate Stripe introducing a new literal at
    // runtime that TS does not know about yet.
    const result = mapStripeStatus(
      'future_unmapped_status' as unknown as Parameters<typeof mapStripeStatus>[0],
    );

    expect(result).toBe('pending');
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = warn.mock.calls[0]?.[0];
    expect(typeof payload).toBe('string');
    expect(payload).toContain('stripe.unknown_payment_intent_status');
    expect(payload).toContain('future_unmapped_status');
    warn.mockRestore();
  });
});
