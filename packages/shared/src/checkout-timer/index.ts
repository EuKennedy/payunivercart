import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-product checkout appearance vocabulary + the visit-token
 * primitive that makes the scarcity countdown's expiry discount safe
 * to trust.
 *
 * The countdown is *evergreen*: it starts when THIS buyer first opens
 * the checkout, and the clock is persisted in their `localStorage`.
 * Which means the only party that knows how long the buyer has waited
 * is the buyer's own browser — and the browser is precisely the party
 * that profits from lying about it.
 *
 * So the browser is never asked for anything numeric. At `getBySlug`
 * time the server mints an opaque, HMAC-signed attestation of when it
 * issued the token (`iat`). The page stores it beside the clock and
 * replays it verbatim on `createOrder`; the server re-verifies the
 * HMAC with `AUTH_SECRET`, compares `iat` against its OWN clock, and
 * recomputes the discount from the product row it already fetched. A
 * forged, tampered, replayed or entirely absent token simply means
 * full price — never a thrown error, never a partial trust.
 *
 * Wire format — deliberately NOT a JWT. There is no `alg` header,
 * hence no `alg: none` confusion surface, and no third party ever
 * parses it (contrast `packages/connect/src/jwt.ts`, whose whole point
 * is that partners can decode it):
 *
 *     token   := `${payload}.${sig}`
 *     payload := b64url(JSON.stringify({ v, p, iat, exp }))
 *     sig     := b64url(HMAC_SHA256(secret, payload))
 *
 * `exp` is what bounds stockpiling. A patient attacker can always mint
 * a token and genuinely wait out the configured duration — that is
 * semantically an honest buyer, i.e. the feature, not a hole. What the
 * signature buys us is that a buyer with devtools open cannot *skip*
 * the wait, which is the entire scarcity mechanic. What `exp` buys us
 * is that nobody farms a pile of tokens today to cash in next month.
 *
 * This module imports `node:crypto` and is therefore server-only, in
 * the same way `idempotency/index.ts` is.
 */

/* -------------------------------------------------------------------------- */
/*  Shared vocabulary                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What happens when a visitor's countdown reaches zero.
 *
 * `restart` — the cycle begins again (evergreen urgency, no state).
 * `last_chance` — the counter freezes at 00:00, the copy swaps to the
 * producer's last-chance message, and the OPTIONAL configured discount
 * becomes claimable. There is no third "disappear silently" behavior.
 *
 * Declared here, once, so the DB CHECK constraint, the zod enums on
 * both routers and the two React unions can never drift apart — the
 * checkout-template strings (`'single' | 'stepper' | 'express'`) are
 * the cautionary tale, hand-copied into three files.
 */
export const CHECKOUT_TIMER_EXPIRED_BEHAVIORS = ['restart', 'last_chance'] as const;
export type CheckoutTimerExpiredBehavior = (typeof CHECKOUT_TIMER_EXPIRED_BEHAVIORS)[number];

/**
 * How the last-chance discount is expressed. `percent` reads
 * `checkout_timer_discount_percent` (1–90), `fixed` reads
 * `checkout_timer_discount_cents`. NULL on the column means the
 * producer configured no discount at all.
 */
export const CHECKOUT_TIMER_DISCOUNT_TYPES = ['percent', 'fixed'] as const;
export type CheckoutTimerDiscountType = (typeof CHECKOUT_TIMER_DISCOUNT_TYPES)[number];

/** Whether the promotional top banner renders uploaded bytes or copy. */
export const CHECKOUT_BANNER_TYPES = ['image', 'text'] as const;
export type CheckoutBannerType = (typeof CHECKOUT_BANNER_TYPES)[number];

/* -------------------------------------------------------------------------- */
/*  Visit token                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Payload version. Bumping it invalidates every token in flight —
 * `verifyVisitToken` reports an unrecognised version as `malformed`,
 * which the caller already treats as "full price". That is the correct
 * failure mode: a producer never loses a sale over a schema change,
 * they only lose the discount for the visitors mid-countdown.
 */
const VISIT_TOKEN_VERSION = 1;

/**
 * `AUTH_SECRET` is validated `.min(64)` at API boot, so this floor can
 * never trip in production. It exists to catch a caller wiring in a
 * placeholder or an empty string in a test/script, which would produce
 * a perfectly valid-looking token anyone could forge.
 */
const MIN_SECRET_LENGTH = 32;

interface VisitTokenClaims {
  /** Payload version. */
  v: number;
  /** Product id the token is scoped to. */
  p: string;
  /** Unix seconds — when the server issued the token. */
  iat: number;
  /** Unix seconds — after which the token is refused. */
  exp: number;
}

function b64urlEncode(input: Buffer | string): string {
  // `base64url` (RFC 4648 §5) is standard base64 with `+`→`-`, `/`→`_`
  // and no `=` padding — identical output to the previous manual
  // strip+swap, minus the `/=+$/` regex CodeQL flagged as a polynomial
  // ReDoS. Not exploitable here (the regex only ever ran on base64
  // output, where `=` is ≤2 trailing chars), but the stdlib encoding is
  // both faster and clean of the alert.
  return Buffer.from(input).toString('base64url');
}

function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function hmacSha256(secret: string, data: string): string {
  return b64urlEncode(createHmac('sha256', secret).update(data).digest());
}

export interface SignVisitTokenInput {
  /** `AUTH_SECRET`. Never a per-product or per-workspace value. */
  secret: string;
  /** `products.id` — a token minted for one product is refused for any other. */
  productId: string;
  /**
   * Lifetime in seconds. Callers use
   * `Math.max(86_400, durationMinutes * 240)` — four countdown cycles,
   * floored at a day, so a buyer who leaves the tab open overnight
   * still converts while the farming window stays finite.
   */
  ttlSec: number;
  /** Inject clock for tests. Unix seconds. */
  nowSec?: number;
}

/**
 * Mint a visit token attesting that the server handed this visitor a
 * countdown at `iat`. Cheap enough to run on every public checkout
 * render — one HMAC, no IO, no storage.
 */
export function signVisitToken(input: SignVisitTokenInput): string {
  if (!input.secret || input.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`visit token secret too short — minimum ${MIN_SECRET_LENGTH} chars`);
  }
  const iat = input.nowSec ?? Math.floor(Date.now() / 1000);
  const claims: VisitTokenClaims = {
    v: VISIT_TOKEN_VERSION,
    p: input.productId,
    iat,
    exp: iat + input.ttlSec,
  };
  const payload = b64urlEncode(JSON.stringify(claims));
  return `${payload}.${hmacSha256(input.secret, payload)}`;
}

export interface VerifyVisitTokenInput {
  /** `AUTH_SECRET` — the same value that minted the token. */
  secret: string;
  /** The opaque token replayed by the browser. */
  token: string;
  /** The product being purchased right now, from the server's own query. */
  productId: string;
  /** Inject clock for tests. Unix seconds. */
  nowSec?: number;
}

export type VerifyVisitTokenResult =
  | { ok: true; iat: number }
  | { ok: false; reason: 'malformed' | 'expired' | 'bad_signature' | 'product_mismatch' };

/**
 * Verify a visit token and recover the issue time. Total function —
 * every hostile input (garbage, truncated base64, non-JSON payload,
 * wrong product, stale `exp`) returns a reason instead of throwing,
 * because the only caller sits inside `createOrder` and must degrade to
 * full price rather than fail a payment.
 *
 * Order of operations is load-bearing: the HMAC is checked BEFORE the
 * payload is parsed, so untrusted JSON never reaches `JSON.parse`
 * unless we signed it ourselves.
 */
export function verifyVisitToken(input: VerifyVisitTokenInput): VerifyVisitTokenResult {
  if (!input.token) return { ok: false, reason: 'malformed' };

  const parts = input.token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const payloadSegment = parts[0];
  const providedSig = parts[1];
  if (!payloadSegment || !providedSig) return { ok: false, reason: 'malformed' };

  // `timingSafeEqual` THROWS on unequal lengths — guard first, exactly
  // as `webhooks/signature.ts:83` does.
  const expectedSig = hmacSha256(input.secret, payloadSegment);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let claims: VisitTokenClaims;
  try {
    claims = JSON.parse(b64urlDecode(payloadSegment).toString('utf-8')) as VisitTokenClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.v !== VISIT_TOKEN_VERSION) return { ok: false, reason: 'malformed' };
  if (typeof claims.p !== 'string' || claims.p.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)) {
    return { ok: false, reason: 'malformed' };
  }

  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (claims.exp < nowSec) return { ok: false, reason: 'expired' };
  if (claims.p !== input.productId) return { ok: false, reason: 'product_mismatch' };

  return { ok: true, iat: claims.iat };
}
