import { describe, expect, it } from 'vitest';
import { tiktokAdapter } from './tiktok';

/**
 * TikTok Events API adapter — credentials parse locks.
 * Network-level dispatch covered by integration smoke.
 */

describe('tiktokAdapter.parseCredentials', () => {
  it('accepts valid pixelCode + access token', () => {
    const parsed = tiktokAdapter.parseCredentials({
      pixelCode: 'C12ABC34DEF5GHIJ',
      accessToken: 't'.repeat(30),
    });
    expect(parsed.pixelCode).toBe('C12ABC34DEF5GHIJ');
  });

  it('rejects pixelCode shorter than 8 chars', () => {
    expect(() =>
      tiktokAdapter.parseCredentials({
        pixelCode: 'C12345',
        accessToken: 't'.repeat(30),
      }),
    ).toThrow();
  });

  it('rejects access token shorter than 20 chars', () => {
    expect(() =>
      tiktokAdapter.parseCredentials({
        pixelCode: 'C12ABC34DEF5GHIJ',
        accessToken: 'short',
      }),
    ).toThrow();
  });

  it('passes optional testEventCode through', () => {
    const parsed = tiktokAdapter.parseCredentials({
      pixelCode: 'C12ABC34DEF5GHIJ',
      accessToken: 't'.repeat(30),
      testEventCode: 'TEST123',
    });
    expect(parsed.testEventCode).toBe('TEST123');
  });

  it('trims whitespace', () => {
    const parsed = tiktokAdapter.parseCredentials({
      pixelCode: '  C12ABC34DEF5GHIJ  ',
      accessToken: `   ${'t'.repeat(30)}   `,
    });
    expect(parsed.pixelCode).toBe('C12ABC34DEF5GHIJ');
  });
});
