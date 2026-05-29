import { describe, expect, it } from 'vitest';
import { generateWebhookSecret, signWebhook, verifyWebhook } from './signature';

/**
 * Webhook signature contract tests.
 *
 * The producer-facing webhook system is one of two things partners
 * pin to (the other being the event envelope). A regression here
 * invalidates every receiver in the wild, so cover the critical
 * paths thoroughly.
 */
describe('signWebhook / verifyWebhook', () => {
  const secret = `whsec_${'a'.repeat(64)}`;
  const body = '{"id":"evt_123","type":"order.paid","livemode":true}';

  it('roundtrip — valid signature verifies', () => {
    const signed = signWebhook(secret, body);
    const verified = verifyWebhook({
      secret,
      rawBody: body,
      signatureHeader: signed.signatureHeader,
    });
    expect(verified.ok).toBe(true);
  });

  it('rejects tampered body', () => {
    const signed = signWebhook(secret, body);
    const tampered = body.replace('order.paid', 'order.refunded');
    const verified = verifyWebhook({
      secret,
      rawBody: tampered,
      signatureHeader: signed.signatureHeader,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('bad_signature');
  });

  it('rejects wrong secret', () => {
    const signed = signWebhook(secret, body);
    const otherSecret = `whsec_${'b'.repeat(64)}`;
    const verified = verifyWebhook({
      secret: otherSecret,
      rawBody: body,
      signatureHeader: signed.signatureHeader,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('bad_signature');
  });

  it('rejects malformed header — missing t', () => {
    const verified = verifyWebhook({
      secret,
      rawBody: body,
      signatureHeader: 'v1=abc',
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('malformed');
  });

  it('rejects malformed header — missing v1', () => {
    const verified = verifyWebhook({
      secret,
      rawBody: body,
      signatureHeader: 't=123',
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('malformed');
  });

  it('rejects null header', () => {
    const verified = verifyWebhook({
      secret,
      rawBody: body,
      signatureHeader: null,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('malformed');
  });

  it('rejects expired timestamp (> 5 min)', () => {
    const stale = signWebhook(secret, body, 1_700_000_000);
    const verified = verifyWebhook({
      secret,
      rawBody: body,
      signatureHeader: stale.signatureHeader,
      nowSec: 1_700_000_000 + 600, // +10 min
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('expired');
  });

  it('accepts within replay window', () => {
    const fresh = signWebhook(secret, body, 1_700_000_000);
    const verified = verifyWebhook({
      secret,
      rawBody: body,
      signatureHeader: fresh.signatureHeader,
      nowSec: 1_700_000_000 + 60, // +1 min
    });
    expect(verified.ok).toBe(true);
  });

  it('accepts disabled replay window', () => {
    const stale = signWebhook(secret, body, 1_700_000_000);
    const verified = verifyWebhook({
      secret,
      rawBody: body,
      signatureHeader: stale.signatureHeader,
      nowSec: 1_700_000_000 + 999_999,
      replayWindowSec: 0,
    });
    expect(verified.ok).toBe(true);
  });

  it('handles Unicode body — emoji', () => {
    const unicode = '{"name":"João 🎉","city":"São Paulo"}';
    const signed = signWebhook(secret, unicode);
    const verified = verifyWebhook({
      secret,
      rawBody: unicode,
      signatureHeader: signed.signatureHeader,
    });
    expect(verified.ok).toBe(true);
  });

  it('handles Unicode body — CJK', () => {
    const cjk = '{"name":"中国","greeting":"こんにちは"}';
    const signed = signWebhook(secret, cjk);
    const verified = verifyWebhook({
      secret,
      rawBody: cjk,
      signatureHeader: signed.signatureHeader,
    });
    expect(verified.ok).toBe(true);
  });

  it('rejects too-short secret', () => {
    expect(() => signWebhook('short', body)).toThrow(/too short/);
  });

  it('header format matches Stripe-style t=,v1=', () => {
    const signed = signWebhook(secret, body, 1_700_000_000);
    expect(signed.signatureHeader).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
  });

  it('two sigs at different timestamps differ', () => {
    const a = signWebhook(secret, body, 1_700_000_000);
    const b = signWebhook(secret, body, 1_700_000_001);
    expect(a.signatureHeader).not.toBe(b.signatureHeader);
  });
});

describe('generateWebhookSecret', () => {
  it('returns whsec_ prefix + 64 hex chars', () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[a-f0-9]{64}$/);
  });

  it('returns unique values', () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b);
  });
});
