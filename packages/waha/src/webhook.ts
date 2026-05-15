import { createHmac, timingSafeEqual } from 'node:crypto';
import { PayunivercartError } from '@payunivercart/shared';
import { ZodError } from 'zod';
import { type WahaWebhookPayload, wahaWebhookPayloadSchema } from './types.js';

export interface VerifyWebhookOptions {
  /** Raw request body — DO NOT pre-parse; HMAC is over the exact bytes. */
  rawBody: string;
  /** Value of the `X-Webhook-Hmac` header (hex-encoded SHA-512). */
  signature: string;
  /** Webhook secret configured in WAHA. */
  secret: string;
  /**
   * Anti-replay window in seconds. Reject events whose `timestamp` field is
   * outside `[now - skewSeconds, now + skewSeconds]`. Defaults to 300 (5 min)
   * which is the convention shared with Stripe and Mercado Pago.
   *
   * Set to `Infinity` for tests that pin a fixed timestamp; never disable
   * in production.
   */
  skewSeconds?: number;
  /** Wall clock injection point for tests. */
  now?: () => Date;
}

const SHA512_HEX_LENGTH = 128;
const DEFAULT_SKEW_SECONDS = 300;

/**
 * Verify a WAHA webhook signature using HMAC-SHA512 over the raw body, then
 * parse and discriminate the payload.
 *
 * Hardening notes (Bloco 5):
 *   - Signature header normalized to lowercase before timing-safe compare;
 *     WAHA upgrades have shipped both uppercase and lowercase hex in the
 *     past, and a fail-closed case-sensitive compare silently breaks the
 *     entire OTP / cart-recovery flow.
 *   - Length asserted to 128 hex chars (SHA-512). Anything shorter is
 *     rejected without running HMAC — saves CPU and prevents a malformed
 *     header from leaking timing information.
 *   - 300-second timestamp window enforced; captured webhooks cannot be
 *     replayed indefinitely. Combined with the
 *     `webhooks_inbound(source, event_id)` unique index in `packages/db`
 *     this gives us replay protection at both the verifier and the
 *     persistence layers.
 *   - Zod parse failures are wrapped in `PayunivercartError` so HTTP
 *     boundaries can map them to 400 instead of an unhandled 500.
 */
export function verifyWahaWebhook(options: VerifyWebhookOptions): WahaWebhookPayload {
  const { rawBody, signature, secret } = options;
  const skewSeconds = options.skewSeconds ?? DEFAULT_SKEW_SECONDS;

  if (!signature || typeof signature !== 'string') {
    throw signatureError('Missing WAHA webhook signature');
  }

  const normalized = signature.trim().toLowerCase();
  if (normalized.length !== SHA512_HEX_LENGTH || !/^[0-9a-f]+$/.test(normalized)) {
    throw signatureError(`WAHA webhook signature must be ${SHA512_HEX_LENGTH} lowercase hex chars`);
  }

  const expected = createHmac('sha512', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(normalized, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw signatureError('WAHA webhook signature mismatch');
  }

  const json = safeParseJson(rawBody);
  const parsed = safeZodParse(json);

  enforceTimestampWindow(parsed.timestamp, skewSeconds, options.now);
  return parsed;
}

function signatureError(message: string): PayunivercartError {
  return new PayunivercartError({
    code: 'WEBHOOK_INVALID_SIGNATURE',
    message,
  });
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new PayunivercartError({
      code: 'VALIDATION',
      message: 'WAHA webhook body is not valid JSON',
      cause,
    });
  }
}

function safeZodParse(json: unknown): WahaWebhookPayload {
  try {
    return wahaWebhookPayloadSchema.parse(json);
  } catch (cause) {
    if (cause instanceof ZodError) {
      throw new PayunivercartError({
        code: 'VALIDATION',
        message: 'WAHA webhook payload failed schema validation',
        cause,
        details: { issues: cause.issues },
      });
    }
    throw cause;
  }
}

function enforceTimestampWindow(
  timestampSeconds: number,
  skewSeconds: number,
  nowFn?: () => Date,
): void {
  if (skewSeconds === Number.POSITIVE_INFINITY) return;
  const nowSeconds = Math.floor((nowFn ?? (() => new Date()))().getTime() / 1000);
  const drift = Math.abs(nowSeconds - timestampSeconds);
  if (!Number.isFinite(drift) || drift > skewSeconds) {
    throw new PayunivercartError({
      code: 'WEBHOOK_INVALID_SIGNATURE',
      message: `WAHA webhook timestamp outside ${skewSeconds}s window`,
      details: { driftSeconds: drift, skewSeconds },
    });
  }
}
