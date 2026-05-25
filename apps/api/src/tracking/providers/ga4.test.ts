import { describe, expect, it } from 'vitest';
import { ga4Adapter } from './ga4';

/**
 * GA4 Measurement Protocol adapter — credentials parse locks.
 * Network-level dispatch is covered by integration smoke.
 */

describe('ga4Adapter.parseCredentials', () => {
  it('accepts a valid G-XXXXXXXX measurement id + secret', () => {
    const parsed = ga4Adapter.parseCredentials({
      measurementId: 'G-ABC1234567',
      apiSecret: 'a'.repeat(20),
    });
    expect(parsed.measurementId).toBe('G-ABC1234567');
  });

  it('accepts lowercase letters in the measurement id (regex is case-insensitive)', () => {
    const parsed = ga4Adapter.parseCredentials({
      measurementId: 'g-abc1234567',
      apiSecret: 'a'.repeat(20),
    });
    expect(parsed.measurementId).toBe('g-abc1234567');
  });

  it('rejects measurement id missing the G- prefix', () => {
    expect(() =>
      ga4Adapter.parseCredentials({
        measurementId: 'ABC1234567',
        apiSecret: 'a'.repeat(20),
      }),
    ).toThrow();
  });

  it('rejects measurement id with too-short payload', () => {
    expect(() =>
      ga4Adapter.parseCredentials({
        measurementId: 'G-12345',
        apiSecret: 'a'.repeat(20),
      }),
    ).toThrow();
  });

  it('rejects too-short api secret', () => {
    expect(() =>
      ga4Adapter.parseCredentials({
        measurementId: 'G-ABC1234567',
        apiSecret: 'short',
      }),
    ).toThrow();
  });

  it('trims whitespace on both fields', () => {
    const parsed = ga4Adapter.parseCredentials({
      measurementId: '  G-ABC1234567  ',
      apiSecret: `   ${'a'.repeat(20)}   `,
    });
    expect(parsed.measurementId).toBe('G-ABC1234567');
    expect(parsed.apiSecret.length).toBe(20);
  });
});
