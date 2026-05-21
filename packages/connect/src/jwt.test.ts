import { describe, expect, it } from 'vitest';
import { signMagicLink, verifyMagicLink } from './jwt';

const secret = 'jwtsec_AbCdEfGhIjKlMnOpQrStUvWxYz123456';

describe('jwt magic link', () => {
  it('round-trips a valid token', () => {
    const out = signMagicLink({
      subscriptionId: 'sub_123',
      email: 'a@b.com',
      name: 'Buyer',
      partnerSlug: 'zapgrup',
      partnerRoleSlug: 'entry',
      jwtSigningSecret: secret,
    });
    const verified = verifyMagicLink(out.jwt, {
      jwtSigningSecret: secret,
      audience: 'zapgrup',
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.sub).toBe('sub_123');
      expect(verified.claims.role).toBe('entry');
      expect(verified.claims.jti).toBe(out.jti);
    }
  });

  it('rejects a tampered signature', () => {
    const out = signMagicLink({
      subscriptionId: 'sub_123',
      email: 'a@b.com',
      name: 'Buyer',
      partnerSlug: 'zapgrup',
      partnerRoleSlug: 'entry',
      jwtSigningSecret: secret,
    });
    const tampered = `${out.jwt.slice(0, -4)}aaaa`;
    const verified = verifyMagicLink(tampered, {
      jwtSigningSecret: secret,
      audience: 'zapgrup',
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('bad_signature');
  });

  it('rejects expired token', () => {
    const out = signMagicLink({
      subscriptionId: 'sub_123',
      email: 'a@b.com',
      name: 'Buyer',
      partnerSlug: 'zapgrup',
      partnerRoleSlug: 'entry',
      jwtSigningSecret: secret,
      expiresInSeconds: 60,
    });
    const verified = verifyMagicLink(out.jwt, {
      jwtSigningSecret: secret,
      audience: 'zapgrup',
      clockNowSec: Math.floor(Date.now() / 1000) + 120,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('expired');
  });

  it('rejects wrong audience', () => {
    const out = signMagicLink({
      subscriptionId: 'sub_123',
      email: 'a@b.com',
      name: 'Buyer',
      partnerSlug: 'zapgrup',
      partnerRoleSlug: 'entry',
      jwtSigningSecret: secret,
    });
    const verified = verifyMagicLink(out.jwt, {
      jwtSigningSecret: secret,
      audience: 'other-saas',
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('bad_audience');
  });

  it('rejects wrong secret', () => {
    const out = signMagicLink({
      subscriptionId: 'sub_123',
      email: 'a@b.com',
      name: 'Buyer',
      partnerSlug: 'zapgrup',
      partnerRoleSlug: 'entry',
      jwtSigningSecret: secret,
    });
    const verified = verifyMagicLink(out.jwt, {
      jwtSigningSecret: 'jwtsec_different________________________',
      audience: 'zapgrup',
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('bad_signature');
  });
});
