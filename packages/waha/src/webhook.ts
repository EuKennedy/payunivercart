import { createHmac, timingSafeEqual } from 'node:crypto';
import { PayunivercartError } from '@payunivercart/shared';
import { type WahaWebhookMessagePayload, wahaWebhookMessagePayloadSchema } from './types.js';

export interface VerifyWebhookOptions {
  /** Raw request body — DO NOT pre-parse; HMAC is over the exact bytes. */
  rawBody: string;
  /** Value of the `X-Webhook-Hmac` header (hex-encoded SHA-512). */
  signature: string;
  /** Webhook secret configured in WAHA. */
  secret: string;
}

/**
 * Verify a WAHA webhook signature using HMAC-SHA512 over the raw body.
 * Reference: WAHA docs §5.4 Security.
 */
export function verifyWahaWebhook(options: VerifyWebhookOptions): WahaWebhookMessagePayload {
  const { rawBody, signature, secret } = options;
  if (!signature) {
    throw new PayunivercartError({
      code: 'WEBHOOK_INVALID_SIGNATURE',
      message: 'Missing WAHA webhook signature',
    });
  }

  const expected = createHmac('sha512', secret).update(rawBody, 'utf8').digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new PayunivercartError({
      code: 'WEBHOOK_INVALID_SIGNATURE',
      message: 'WAHA webhook signature mismatch',
    });
  }

  const json = safeParse(rawBody);
  return wahaWebhookMessagePayloadSchema.parse(json);
}

function safeParse(raw: string): unknown {
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
