import { describe, expect, it } from 'vitest';
import { metaAdapter } from './meta';

/**
 * Meta CAPI adapter — credentials parse + event-name mapping locks.
 *
 * Network-level send/test paths are covered by the integration smoke
 * (skipped when META_TEST_TOKEN env is unset). These tests focus on
 * the pure surface: credentials Zod schema + event name mapping.
 */

describe('metaAdapter.parseCredentials', () => {
  it('accepts valid Meta credentials', () => {
    const parsed = metaAdapter.parseCredentials({
      pixelId: '1234567890123456',
      accessToken: 'A'.repeat(80),
    });
    expect(parsed.pixelId).toBe('1234567890123456');
  });

  it('rejects too-short access token', () => {
    expect(() =>
      metaAdapter.parseCredentials({
        pixelId: '1234567890123456',
        accessToken: 'short',
      }),
    ).toThrow();
  });

  it('rejects too-short pixel id', () => {
    expect(() =>
      metaAdapter.parseCredentials({
        pixelId: 'x',
        accessToken: 'A'.repeat(80),
      }),
    ).toThrow();
  });

  it('trims surrounding whitespace', () => {
    const parsed = metaAdapter.parseCredentials({
      pixelId: '  1234567890123456  ',
      accessToken: `   ${'A'.repeat(80)}   `,
      testEventCode: '  TEST123  ',
    });
    expect(parsed.pixelId).toBe('1234567890123456');
    expect(parsed.testEventCode).toBe('TEST123');
  });

  it('accepts optional testEventCode', () => {
    const parsed = metaAdapter.parseCredentials({
      pixelId: '1234567890123456',
      accessToken: 'A'.repeat(80),
      testEventCode: 'TEST12345',
    });
    expect(parsed.testEventCode).toBe('TEST12345');
  });

  it('rejects testEventCode shorter than 3 chars', () => {
    expect(() =>
      metaAdapter.parseCredentials({
        pixelId: '1234567890123456',
        accessToken: 'A'.repeat(80),
        testEventCode: 'TT',
      }),
    ).toThrow();
  });
});
