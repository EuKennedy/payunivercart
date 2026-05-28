import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Univercart webhook signature scheme.
 *
 * Modeled on Stripe's `Stripe-Signature` header:
 *
 *     Univercart-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256>
 *
 * The signed string is `${timestamp}.${rawBody}` — timestamp prefixed
 * so a replay attacker can't reuse an old signature against a body
 * with a refreshed timestamp.
 *
 * Producers verify on their side:
 *   1. Extract `t` and `v1` from the header.
 *   2. Reject if `|now - t| > 5 minutes` (replay window).
 *   3. Compute `HMAC-SHA256(secret, '${t}.${rawBody}')` and `timingSafeEqual`
 *      against `v1`.
 *
 * The `verify` helper below does all three so consumer apps can drop
 * it in instead of writing their own.
 */

const REPLAY_WINDOW_SECONDS = 5 * 60;

export interface SignedEnvelope {
  /** Raw stringified JSON body that goes on the wire. */
  body: string;
  /** Value to put in the `Univercart-Signature` header. */
  signatureHeader: string;
  /** Unix-seconds timestamp embedded in the signature. */
  timestamp: number;
}

export function signWebhook(secret: string, body: string, nowSec?: number): SignedEnvelope {
  if (!secret || secret.length < 16) {
    throw new Error('webhook signing secret too short — minimum 16 chars');
  }
  const timestamp = nowSec ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${body}`;
  const signature = createHmac('sha256', secret).update(signedPayload).digest('hex');
  return {
    body,
    signatureHeader: `t=${timestamp},v1=${signature}`,
    timestamp,
  };
}

export type VerifyResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: 'malformed' | 'expired' | 'bad_signature' };

export function verifyWebhook(input: {
  secret: string;
  rawBody: string;
  signatureHeader: string | null | undefined;
  /** Replay window override. Defaults to 5 minutes. Set to 0 to disable. */
  replayWindowSec?: number;
  /** Inject clock for tests. */
  nowSec?: number;
}): VerifyResult {
  if (!input.signatureHeader) return { ok: false, reason: 'malformed' };

  const parts = Object.fromEntries(
    input.signatureHeader
      .split(',')
      .map((p) => p.trim().split('='))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return { ok: false, reason: 'malformed' };

  const replay = input.replayWindowSec ?? REPLAY_WINDOW_SECONDS;
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (replay > 0 && Math.abs(now - t) > replay) {
    return { ok: false, reason: 'expired' };
  }

  const expected = createHmac('sha256', input.secret).update(`${t}.${input.rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, timestamp: t };
}

/**
 * Generate a new webhook signing secret. 32 bytes → 64 hex chars,
 * shown to the producer exactly once (we never log the cleartext).
 */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`;
}
