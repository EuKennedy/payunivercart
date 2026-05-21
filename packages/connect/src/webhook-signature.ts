import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe-style webhook signature header construction + verification.
 *
 * Header format we emit:
 *   X-Univercart-Signature: t=1716307200,v1=<hex>
 *
 *   t  = unix-seconds timestamp when we generated the signature
 *   v1 = lowercase hex of HMAC-SHA-256(secret, `${t}.${rawBody}`)
 *
 * Partners verify by recomputing v1 and comparing in constant time.
 * We also enforce a 5-minute replay window on the receiver side.
 */

export interface SignWebhookPayloadInput {
  secret: string;
  rawBody: string;
  /** Override timestamp for tests; defaults to now(). */
  timestampSec?: number;
}

export function signWebhookPayload(input: SignWebhookPayloadInput): string {
  const ts = input.timestampSec ?? Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', input.secret).update(`${ts}.${input.rawBody}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

export interface VerifyWebhookPayloadOptions {
  secret: string;
  rawBody: string;
  header: string;
  toleranceSec?: number; // default 300
  clockNowSec?: number; // override for tests
}

export type VerifyWebhookResult =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'stale_timestamp' };

export function verifyWebhookPayload(opts: VerifyWebhookPayloadOptions): VerifyWebhookResult {
  const parts = Object.fromEntries(
    opts.header.split(',').map((kv) => kv.split('=') as [string, string]),
  );
  const tRaw = parts.t;
  const providedHex = parts.v1;
  if (typeof tRaw !== 'string' || typeof providedHex !== 'string' || providedHex.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  const ts = Number.parseInt(tRaw, 10);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'malformed' };
  }

  const tolerance = opts.toleranceSec ?? 300;
  const nowSec = opts.clockNowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > tolerance) return { ok: false, reason: 'stale_timestamp' };

  const expectedHex = createHmac('sha256', opts.secret)
    .update(`${ts}.${opts.rawBody}`)
    .digest('hex');
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(providedHex, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}
