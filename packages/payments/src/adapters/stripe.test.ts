import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { PaymentError } from '../errors';
import { mapStripeDeclineCode, mapStripeError, mapStripeStatus } from './stripe';

/* -------------------------------------------------------------------------- */
/*  mapStripeStatus                                                            */
/* -------------------------------------------------------------------------- */

describe('mapStripeStatus', () => {
  it.each([
    ['requires_payment_method', 'pending'],
    ['requires_confirmation', 'pending'],
    ['requires_action', 'pending'],
    ['processing', 'processing'],
    ['requires_capture', 'authorized'],
    ['succeeded', 'paid'],
    ['canceled', 'cancelled'],
  ] as const)('maps Stripe status %s -> %s', (input, expected) => {
    expect(mapStripeStatus(input)).toBe(expected);
  });

  it('falls back to "pending" and warns on unknown future status', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = mapStripeStatus(
      'future_unmapped_status' as unknown as Parameters<typeof mapStripeStatus>[0],
    );

    expect(result).toBe('pending');
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = warn.mock.calls[0]?.[0];
    expect(typeof payload).toBe('string');
    expect(payload).toContain('stripe.unknown_payment_intent_status');
    expect(payload).toContain('future_unmapped_status');
    warn.mockRestore();
  });
});

/* -------------------------------------------------------------------------- */
/*  mapStripeDeclineCode — coverage of known Stripe codes                      */
/* -------------------------------------------------------------------------- */

describe('mapStripeDeclineCode', () => {
  it.each([
    ['card_declined', 'ISSUER_DECLINED'],
    ['do_not_honor', 'ISSUER_DECLINED'],
    ['pickup_card', 'ISSUER_DECLINED'],
    ['insufficient_funds', 'INSUFFICIENT_FUNDS'],
    ['incorrect_cvc', 'INVALID_CVC'],
    ['invalid_cvc', 'INVALID_CVC'],
    ['expired_card', 'EXPIRED_CARD'],
    ['invalid_expiry_month', 'EXPIRED_CARD'],
    ['invalid_expiry_year', 'EXPIRED_CARD'],
    ['fraudulent', 'FRAUD_SUSPECTED'],
    ['stolen_card', 'FRAUD_SUSPECTED'],
    ['lost_card', 'FRAUD_SUSPECTED'],
    ['authentication_required', 'THREE_DS_REQUIRED'],
    ['invalid_number', 'CARD_NOT_SUPPORTED'],
    ['invalid_account', 'CARD_NOT_SUPPORTED'],
    ['card_not_supported', 'CARD_NOT_SUPPORTED'],
    ['currency_not_supported', 'UNSUPPORTED_CURRENCY'],
    ['rate_limit', 'RATE_LIMITED'],
    ['try_again_later', 'PROCESSING_ERROR'],
    ['processing_error', 'PROCESSING_ERROR'],
    ['idempotency_key_in_use', 'INVALID_REQUEST'],
    ['invalid_request_error', 'INVALID_REQUEST'],
    ['parameter_missing', 'INVALID_REQUEST'],
    ['api_key_expired', 'AUTH_FAILED'],
    ['invalid_api_key', 'AUTH_FAILED'],
  ] as const)('maps %s -> %s', (input, expected) => {
    expect(mapStripeDeclineCode(input)).toBe(expected);
  });

  it('maps unknown code to UNKNOWN', () => {
    expect(mapStripeDeclineCode('totally_new_code_2027')).toBe('UNKNOWN');
  });

  it('maps undefined code to PROCESSING_ERROR (transient, no code present)', () => {
    expect(mapStripeDeclineCode(undefined)).toBe('PROCESSING_ERROR');
  });
});

/* -------------------------------------------------------------------------- */
/*  mapStripeError — retry classification                                      */
/* -------------------------------------------------------------------------- */

function makeStripeError(opts: {
  message: string;
  type: Stripe.errors.StripeError['type'];
  code?: string;
}): Stripe.errors.StripeError {
  const ctorByType: Record<string, new (raw: object) => Stripe.errors.StripeError> = {
    StripeCardError: Stripe.errors.StripeCardError,
    StripeInvalidRequestError: Stripe.errors.StripeInvalidRequestError,
    StripeAPIError: Stripe.errors.StripeAPIError,
    StripeAuthenticationError: Stripe.errors.StripeAuthenticationError,
    StripePermissionError: Stripe.errors.StripePermissionError,
    StripeRateLimitError: Stripe.errors.StripeRateLimitError,
    StripeConnectionError: Stripe.errors.StripeConnectionError,
    StripeSignatureVerificationError: Stripe.errors.StripeSignatureVerificationError,
    StripeIdempotencyError: Stripe.errors.StripeIdempotencyError,
  };
  const Ctor = ctorByType[opts.type] ?? Stripe.errors.StripeError;
  return new Ctor({ message: opts.message, ...(opts.code ? { code: opts.code } : {}) });
}

describe('mapStripeError — retry classification', () => {
  it('classifies StripeConnectionError as retryable', () => {
    const e = makeStripeError({ message: 'connect ECONNRESET', type: 'StripeConnectionError' });
    const mapped = mapStripeError(e);
    expect(mapped).toBeInstanceOf(PaymentError);
    expect(mapped.retryable).toBe(true);
  });

  it('classifies StripeAPIError as retryable', () => {
    const e = makeStripeError({ message: 'internal', type: 'StripeAPIError' });
    expect(mapStripeError(e).retryable).toBe(true);
  });

  it('classifies StripeRateLimitError as retryable (via declineCode)', () => {
    const e = makeStripeError({
      message: 'slow down',
      type: 'StripeRateLimitError',
      code: 'rate_limit',
    });
    const mapped = mapStripeError(e);
    expect(mapped.declineCode).toBe('RATE_LIMITED');
    expect(mapped.retryable).toBe(true);
  });

  it('explicitly NOT retryable on idempotency_key_in_use (prevents infinite loop)', () => {
    const e = makeStripeError({
      message: 'idempotency key already used',
      type: 'StripeIdempotencyError',
      code: 'idempotency_key_in_use',
    });
    const mapped = mapStripeError(e);
    expect(mapped.declineCode).toBe('INVALID_REQUEST');
    expect(mapped.retryable).toBe(false);
  });

  it('NOT retryable on card_declined', () => {
    const e = makeStripeError({
      message: 'declined',
      type: 'StripeCardError',
      code: 'card_declined',
    });
    expect(mapStripeError(e).retryable).toBe(false);
  });

  it('NOT retryable on invalid_request_error', () => {
    const e = makeStripeError({
      message: 'bad param',
      type: 'StripeInvalidRequestError',
      code: 'invalid_request_error',
    });
    expect(mapStripeError(e).retryable).toBe(false);
  });

  it('wraps non-Stripe error as UNKNOWN', () => {
    const mapped = mapStripeError(new Error('out of band'));
    expect(mapped.declineCode).toBe('UNKNOWN');
    expect(mapped.gatewayId).toBe('stripe');
  });

  it('forwards raw code to rawCode field', () => {
    const e = makeStripeError({
      message: 'declined',
      type: 'StripeCardError',
      code: 'card_declined',
    });
    expect(mapStripeError(e).rawCode).toBe('card_declined');
  });
});
