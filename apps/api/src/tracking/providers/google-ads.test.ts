import { describe, expect, it } from 'vitest';
import { googleAdsAdapter } from './google-ads';

/**
 * Google Ads Enhanced Conversions — credentials parse locks. OAuth
 * exchange + uploadClickConversions are network-bound and covered by
 * integration smoke when GADS_TEST_REFRESH_TOKEN is set.
 */

const VALID = {
  customerId: '1234567890',
  conversionActionId: '987654321',
  oauthRefreshToken: 'r'.repeat(80),
  oauthClientId: 'c'.repeat(30),
  oauthClientSecret: 's'.repeat(30),
  developerToken: 'd'.repeat(20),
};

describe('googleAdsAdapter.parseCredentials', () => {
  it('accepts a complete valid payload', () => {
    const parsed = googleAdsAdapter.parseCredentials(VALID);
    expect(parsed.customerId).toBe('1234567890');
    expect(parsed.developerToken.length).toBe(20);
  });

  it('rejects customerId with dashes (10-digit-no-dash spec)', () => {
    expect(() =>
      googleAdsAdapter.parseCredentials({ ...VALID, customerId: '123-456-7890' }),
    ).toThrow();
  });

  it('rejects customerId shorter than 10 digits', () => {
    expect(() =>
      googleAdsAdapter.parseCredentials({ ...VALID, customerId: '123456789' }),
    ).toThrow();
  });

  it('rejects conversionActionId with letters', () => {
    expect(() =>
      googleAdsAdapter.parseCredentials({ ...VALID, conversionActionId: '12345abc' }),
    ).toThrow();
  });

  it('rejects refresh token shorter than 40 chars', () => {
    expect(() =>
      googleAdsAdapter.parseCredentials({ ...VALID, oauthRefreshToken: 'short' }),
    ).toThrow();
  });

  it('accepts optional loginCustomerId when valid', () => {
    const parsed = googleAdsAdapter.parseCredentials({
      ...VALID,
      loginCustomerId: '9876543210',
    });
    expect(parsed.loginCustomerId).toBe('9876543210');
  });

  it('rejects malformed loginCustomerId', () => {
    expect(() =>
      googleAdsAdapter.parseCredentials({ ...VALID, loginCustomerId: '12345' }),
    ).toThrow();
  });
});
