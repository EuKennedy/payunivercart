import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signVisitToken, verifyVisitToken } from './index';

/**
 * Visit-token contract tests.
 *
 * This token is the ONLY thing standing between "the buyer genuinely
 * waited out the countdown" and "the buyer opened devtools". It is
 * price-affecting: a hole here lets anyone claim the producer's
 * last-chance discount instantly. Cover every rejection path, and
 * assert that none of them throws — the caller lives inside
 * `createOrder` and must degrade to full price, not fail the payment.
 */

const secret = 'a'.repeat(64); // shaped like AUTH_SECRET (validated .min(64))
const productId = '3f2b1c4d-5e6a-4b7c-8d9e-0a1b2c3d4e5f';
const otherProductId = '9c8b7a6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d';
const NOW = 1_700_000_000;
const ONE_DAY = 86_400;

function b64url(input: string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=+$/u, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** Mint a correctly-signed token with arbitrary claims, to reach the
 *  post-signature validation branches an honest signer can't produce. */
function forgeSigned(claims: Record<string, unknown>): string {
  const payload = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', secret)
    .update(payload)
    .digest('base64')
    .replace(/=+$/u, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${payload}.${sig}`;
}

describe('signVisitToken / verifyVisitToken', () => {
  it('roundtrip — a freshly minted token verifies', () => {
    const token = signVisitToken({ secret, productId, ttlSec: ONE_DAY, nowSec: NOW });
    const verified = verifyVisitToken({ secret, token, productId, nowSec: NOW });
    expect(verified.ok).toBe(true);
  });

  it('roundtrips `iat` exactly — the discount math depends on it', () => {
    const token = signVisitToken({ secret, productId, ttlSec: ONE_DAY, nowSec: NOW });
    const verified = verifyVisitToken({ secret, token, productId, nowSec: NOW + 900 });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.iat).toBe(NOW);
  });

  it('defaults `nowSec` to the real clock on both sides', () => {
    const token = signVisitToken({ secret, productId, ttlSec: ONE_DAY });
    const verified = verifyVisitToken({ secret, token, productId });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(Math.abs(verified.iat - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
    }
  });

  it('token shape is `payload.sig`, both b64url', () => {
    const token = signVisitToken({ secret, productId, ttlSec: ONE_DAY, nowSec: NOW });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('rejects a tampered payload', () => {
    const token = signVisitToken({ secret, productId, ttlSec: ONE_DAY, nowSec: NOW });
    const [payload, sig] = token.split('.');
    const forgedClaims = b64url(
      JSON.stringify({ v: 1, p: productId, iat: NOW - 999_999, exp: NOW + ONE_DAY }),
    );
    const verified = verifyVisitToken({
      secret,
      token: `${forgedClaims}.${sig}`,
      productId,
      nowSec: NOW,
    });
    expect(payload).not.toBe(forgedClaims);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('bad_signature');
  });

  it('rejects a tampered signature', () => {
    const token = signVisitToken({ secret, productId, ttlSec: ONE_DAY, nowSec: NOW });
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const verified = verifyVisitToken({ secret, token: flipped, productId, nowSec: NOW });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('bad_signature');
  });

  it('rejects a token signed with a different secret', () => {
    const token = signVisitToken({
      secret: 'b'.repeat(64),
      productId,
      ttlSec: ONE_DAY,
      nowSec: NOW,
    });
    const verified = verifyVisitToken({ secret, token, productId, nowSec: NOW });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('bad_signature');
  });

  it('rejects a token minted for another product', () => {
    const token = signVisitToken({ secret, productId, ttlSec: ONE_DAY, nowSec: NOW });
    const verified = verifyVisitToken({
      secret,
      token,
      productId: otherProductId,
      nowSec: NOW,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('product_mismatch');
  });

  it('rejects an expired token', () => {
    const token = signVisitToken({ secret, productId, ttlSec: 3_600, nowSec: NOW });
    const verified = verifyVisitToken({ secret, token, productId, nowSec: NOW + 3_601 });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('expired');
  });

  it('accepts a token exactly at `exp`', () => {
    const token = signVisitToken({ secret, productId, ttlSec: 3_600, nowSec: NOW });
    const verified = verifyVisitToken({ secret, token, productId, nowSec: NOW + 3_600 });
    expect(verified.ok).toBe(true);
  });

  it('prefers `expired` over `product_mismatch` — a stale token is stale for everyone', () => {
    const token = signVisitToken({ secret, productId, ttlSec: 3_600, nowSec: NOW });
    const verified = verifyVisitToken({
      secret,
      token,
      productId: otherProductId,
      nowSec: NOW + 99_999,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('expired');
  });

  it.each([
    ['empty string', ''],
    ['no separator', 'notatoken'],
    ['three segments', 'aaa.bbb.ccc'],
    ['empty payload segment', '.bbb'],
    ['empty signature segment', 'aaa.'],
    ['raw JSON', '{"v":1,"p":"x","iat":0,"exp":9999999999}'],
    ['whitespace', '   '],
  ])('rejects garbage without throwing — %s', (_label, token) => {
    let verified: ReturnType<typeof verifyVisitToken> | undefined;
    expect(() => {
      verified = verifyVisitToken({ secret, token, productId, nowSec: NOW });
    }).not.toThrow();
    expect(verified?.ok).toBe(false);
  });

  it('reports a bare garbage string as malformed, not bad_signature', () => {
    const verified = verifyVisitToken({ secret, token: 'notatoken', productId, nowSec: NOW });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('malformed');
  });

  it('rejects a correctly-signed payload that is not JSON', () => {
    const payload = b64url('this is not json');
    const sig = createHmac('sha256', secret)
      .update(payload)
      .digest('base64')
      .replace(/=+$/u, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const verified = verifyVisitToken({
      secret,
      token: `${payload}.${sig}`,
      productId,
      nowSec: NOW,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('malformed');
  });

  it('rejects an unrecognised payload version', () => {
    const token = forgeSigned({ v: 2, p: productId, iat: NOW, exp: NOW + ONE_DAY });
    const verified = verifyVisitToken({ secret, token, productId, nowSec: NOW });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('malformed');
  });

  it('rejects a correctly-signed payload with a missing product id', () => {
    const token = forgeSigned({ v: 1, iat: NOW, exp: NOW + ONE_DAY });
    const verified = verifyVisitToken({ secret, token, productId, nowSec: NOW });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('malformed');
  });

  it('rejects a correctly-signed payload with a non-numeric `iat`', () => {
    const token = forgeSigned({ v: 1, p: productId, iat: 'soon', exp: NOW + ONE_DAY });
    const verified = verifyVisitToken({ secret, token, productId, nowSec: NOW });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('malformed');
  });

  it('two tokens minted a second apart differ', () => {
    const a = signVisitToken({ secret, productId, ttlSec: ONE_DAY, nowSec: NOW });
    const b = signVisitToken({ secret, productId, ttlSec: ONE_DAY, nowSec: NOW + 1 });
    expect(a).not.toBe(b);
  });

  it('refuses to sign with a too-short secret', () => {
    expect(() => signVisitToken({ secret: 'short', productId, ttlSec: ONE_DAY })).toThrow(
      /too short/,
    );
  });

  it('refuses to sign with an empty secret', () => {
    expect(() => signVisitToken({ secret: '', productId, ttlSec: ONE_DAY })).toThrow(/too short/);
  });
});
