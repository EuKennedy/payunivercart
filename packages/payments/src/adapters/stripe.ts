import type { GatewayId, Money } from '@payunivercart/shared';
import Stripe from 'stripe';
import { type PaymentDeclineCode, PaymentError } from '../errors.js';
import {
  type CreateBoletoInput,
  type CreateCardInput,
  type CreatePixInput,
  type PaymentGateway,
  type PaymentResult,
  type RefundInput,
  type RefundResult,
  type StripeCredentials,
  type WebhookEvent,
  type WebhookRequest,
  stripeCredentialsSchema,
} from '../types.js';

/**
 * Stripe webhook clock-skew tolerance. Match Stripe's documented default
 * (300s) explicitly so an upstream SDK default change doesn't silently widen
 * our replay window.
 */
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

const SUPPORTED_CURRENCIES: readonly Money['currency'][] = ['BRL', 'USD', 'EUR'];

/**
 * Stripe adapter — primary path for USD card payments.
 * BR Pix and BR boleto require a Stripe account incorporated in Brazil and
 * are surfaced as gated features in the dashboard.
 */
export class StripeAdapter implements PaymentGateway<StripeCredentials> {
  readonly id: GatewayId = 'stripe';

  parseCredentials(input: unknown): StripeCredentials {
    return stripeCredentialsSchema.parse(input);
  }

  async validateCredentials(credentials: StripeCredentials): Promise<void> {
    const stripe = this.client(credentials);
    try {
      await stripe.balance.retrieve();
    } catch (cause) {
      throw new PaymentError(
        'Stripe credentials are not valid',
        { gatewayId: this.id, declineCode: 'AUTH_FAILED' },
        cause,
      );
    }
  }

  async createCard(credentials: StripeCredentials, input: CreateCardInput): Promise<PaymentResult> {
    const stripe = this.client(credentials);

    try {
      const intent = await stripe.paymentIntents.create(
        {
          amount: Number(input.amount.amount),
          currency: input.amount.currency.toLowerCase(),
          payment_method: input.card.token,
          payment_method_types: ['card'],
          confirm: true,
          confirmation_method: 'automatic',
          capture_method: 'automatic',
          description: input.description ?? undefined,
          receipt_email: input.customer.email,
          metadata: {
            ...flattenMetadata(input.metadata),
            internal_order_id: input.orderId,
            workspace_id: input.workspaceId,
          },
          statement_descriptor_suffix: 'PAYUNIVERCART',
        },
        { idempotencyKey: input.idempotencyKey },
      );

      return toPaymentResult(intent);
    } catch (cause) {
      throw mapStripeError(cause);
    }
  }

  async createPix(credentials: StripeCredentials, input: CreatePixInput): Promise<PaymentResult> {
    if (input.amount.currency !== 'BRL') {
      throw new PaymentError('Stripe Pix only supports BRL', {
        gatewayId: this.id,
        declineCode: 'UNSUPPORTED_CURRENCY',
      });
    }
    const stripe = this.client(credentials);
    try {
      const intent = await stripe.paymentIntents.create(
        {
          amount: Number(input.amount.amount),
          currency: 'brl',
          payment_method_types: ['pix'],
          payment_method_data: {
            type: 'pix',
            billing_details: {
              email: input.customer.email,
              name: input.customer.name,
            },
          },
          confirm: true,
          payment_method_options: {
            pix: { expires_after_seconds: input.expiresInSeconds ?? 3600 },
          },
          description: input.description ?? undefined,
          metadata: {
            ...flattenMetadata(input.metadata),
            internal_order_id: input.orderId,
            workspace_id: input.workspaceId,
          },
        },
        { idempotencyKey: input.idempotencyKey },
      );

      return toPaymentResult(intent);
    } catch (cause) {
      throw mapStripeError(cause);
    }
  }

  async createBoleto(
    credentials: StripeCredentials,
    input: CreateBoletoInput,
  ): Promise<PaymentResult> {
    if (input.amount.currency !== 'BRL') {
      throw new PaymentError('Stripe Boleto only supports BRL', {
        gatewayId: this.id,
        declineCode: 'UNSUPPORTED_CURRENCY',
      });
    }
    const stripe = this.client(credentials);
    try {
      const intent = await stripe.paymentIntents.create(
        {
          amount: Number(input.amount.amount),
          currency: 'brl',
          payment_method_types: ['boleto'],
          payment_method_data: {
            type: 'boleto',
            boleto: { tax_id: input.customer.document.replace(/\D/g, '') },
            billing_details: {
              email: input.customer.email,
              name: input.customer.name,
              address: {
                line1: `${input.billingAddress.street}, ${input.billingAddress.number}`,
                ...(input.billingAddress.complement !== undefined && {
                  line2: input.billingAddress.complement,
                }),
                city: input.billingAddress.city,
                state: input.billingAddress.state,
                postal_code: input.billingAddress.zipCode.replace(/\D/g, ''),
                country: input.billingAddress.country,
              },
            },
          },
          confirm: true,
          metadata: {
            ...flattenMetadata(input.metadata),
            internal_order_id: input.orderId,
            workspace_id: input.workspaceId,
          },
        },
        { idempotencyKey: input.idempotencyKey },
      );

      return toPaymentResult(intent);
    } catch (cause) {
      throw mapStripeError(cause);
    }
  }

  async refund(credentials: StripeCredentials, input: RefundInput): Promise<RefundResult> {
    const stripe = this.client(credentials);
    try {
      const refundReason = mapRefundReason(input.reason);
      const refund = await stripe.refunds.create(
        {
          payment_intent: input.gatewayChargeId,
          ...(input.amount && { amount: Number(input.amount.amount) }),
          ...(refundReason && { reason: refundReason }),
        },
        { idempotencyKey: input.idempotencyKey },
      );

      return {
        gatewayRefundId: refund.id,
        status: refund.status === 'succeeded' ? 'refunded' : 'processing',
        amount: {
          amount: refund.amount,
          currency: parseStripeCurrency(refund.currency),
        },
        raw: refund,
      };
    } catch (cause) {
      throw mapStripeError(cause);
    }
  }

  async getCharge(credentials: StripeCredentials, chargeId: string): Promise<PaymentResult> {
    const stripe = this.client(credentials);
    try {
      const intent = await stripe.paymentIntents.retrieve(chargeId);
      return toPaymentResult(intent);
    } catch (cause) {
      throw mapStripeError(cause);
    }
  }

  verifyWebhook(credentials: StripeCredentials, request: WebhookRequest): WebhookEvent {
    if (!credentials.webhookSecret) {
      throw new PaymentError('Stripe webhook secret not configured', {
        gatewayId: this.id,
        declineCode: 'AUTH_FAILED',
      });
    }
    const stripe = this.client(credentials);
    // Header lookup is case-insensitive: Node, Hono, and Cloudflare Workers
    // normalize headers to lowercase, but other shims (e.g. AWS Lambda v1)
    // pass through the casing the client sent. We accept any casing.
    const signature = findHeaderValue(request.headers, 'stripe-signature');
    if (!signature) {
      throw new PaymentError('Missing Stripe-Signature header', {
        gatewayId: this.id,
        declineCode: 'AUTH_FAILED',
      });
    }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        request.rawBody,
        signature,
        credentials.webhookSecret,
        STRIPE_WEBHOOK_TOLERANCE_SECONDS,
      );
    } catch (cause) {
      throw new PaymentError(
        'Stripe webhook signature verification failed',
        {
          gatewayId: this.id,
          declineCode: 'AUTH_FAILED',
        },
        cause,
      );
    }

    return {
      gatewayId: this.id,
      eventId: event.id,
      eventType: event.type,
      occurredAt: new Date(event.created * 1000),
      resourceId: (event.data.object as { id?: string }).id ?? event.id,
      raw: event,
    };
  }

  private client(credentials: StripeCredentials): Stripe {
    return new Stripe(credentials.secretKey, {
      apiVersion: '2024-11-20.acacia',
      typescript: true,
      maxNetworkRetries: 2,
      timeout: 15_000,
    });
  }
}

function toPaymentResult(intent: Stripe.PaymentIntent): PaymentResult {
  const nextAction = intent.next_action;
  const pixDisplay =
    nextAction?.type === 'pix_display_qr_code' ? nextAction.pix_display_qr_code : undefined;
  const boletoDisplay =
    nextAction?.type === 'boleto_display_details' ? nextAction.boleto_display_details : undefined;
  const charge =
    intent.latest_charge && typeof intent.latest_charge === 'object'
      ? intent.latest_charge
      : undefined;
  const card = charge?.payment_method_details?.card;

  return {
    gatewayId: 'stripe',
    gatewayChargeId: intent.id,
    gatewayRequestId: intent.id,
    status: mapStripeStatus(intent.status),
    method: derivePaymentMethod(intent),
    amount: {
      amount: intent.amount,
      currency: parseStripeCurrency(intent.currency),
    },
    pixQrCode: pixDisplay?.data,
    pixQrCodeImage: pixDisplay?.image_url_png ?? pixDisplay?.image_url_svg,
    pixCopyPaste: pixDisplay?.data,
    pixExpiresAt: pixDisplay?.expires_at ? new Date(pixDisplay.expires_at * 1000) : undefined,
    boletoUrl: boletoDisplay?.hosted_voucher_url ?? undefined,
    boletoBarcode: boletoDisplay?.number ?? undefined,
    boletoDueDate: boletoDisplay?.expires_at
      ? new Date(boletoDisplay.expires_at * 1000)
      : undefined,
    cardBrand: card?.brand ?? undefined,
    cardLast4: card?.last4 ?? undefined,
    cardThreeDsRedirectUrl:
      nextAction?.type === 'redirect_to_url'
        ? (nextAction.redirect_to_url?.url ?? undefined)
        : undefined,
    raw: intent,
  };
}

/** Exported for unit tests. Not part of the public API. */
export function mapStripeStatus(status: Stripe.PaymentIntent.Status): PaymentResult['status'] {
  switch (status) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
      return 'pending';
    case 'processing':
      return 'processing';
    case 'requires_capture':
      return 'authorized';
    case 'succeeded':
      return 'paid';
    case 'canceled':
      return 'cancelled';
    default: {
      // Stripe occasionally introduces new PaymentIntent statuses (last seen:
      // none breaking, but `requires_source` / `requires_source_action` existed
      // historically). Fall back to `pending` and surface a structured warning
      // so the operator hears about it before billing is affected.
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'stripe.unknown_payment_intent_status',
          status,
        }),
      );
      return 'pending';
    }
  }
}

function derivePaymentMethod(intent: Stripe.PaymentIntent): PaymentResult['method'] {
  const types = intent.payment_method_types;
  if (types.includes('pix')) return 'pix';
  if (types.includes('boleto')) return 'boleto';
  if (types.includes('card') && intent.currency === 'brl') return 'credit_card';
  return 'stripe_card_usd';
}

function mapRefundReason(reason: string | undefined): Stripe.RefundCreateParams.Reason | undefined {
  if (!reason) return undefined;
  if (reason === 'fraud') return 'fraudulent';
  if (reason === 'duplicate') return 'duplicate';
  return 'requested_by_customer';
}

function flattenMetadata(
  meta: Record<string, string | number | boolean> | undefined,
): Record<string, string> {
  if (!meta) return {};
  return Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, String(v)]));
}

/**
 * Convert any Stripe-thrown error (or anything else) into a structured
 * `PaymentError`. The `retryable` flag is explicit per code — the gateway-
 * layer worker reads this and a `true` value triggers exponential backoff;
 * a `false` is terminal. Getting this wrong creates either silent dropped
 * payments or infinite retry loops.
 */
export function mapStripeError(cause: unknown): PaymentError {
  if (!(cause instanceof Stripe.errors.StripeError)) {
    return new PaymentError(
      'Unexpected Stripe error',
      { gatewayId: 'stripe', declineCode: 'UNKNOWN' },
      cause,
    );
  }
  const declineCode = mapStripeDeclineCode(cause.code);
  const retryable = isRetryableStripeError(cause, declineCode);
  return new PaymentError(
    cause.message,
    {
      gatewayId: 'stripe',
      declineCode,
      ...(cause.code !== undefined && { rawCode: cause.code }),
      rawMessage: cause.message,
      retryable,
    },
    cause,
  );
}

/**
 * Decide whether retrying is safe. Stripe error TYPES tell us about network
 * conditions; CODES tell us about logical state. Both inform the answer.
 *
 *   - StripeConnectionError / StripeAPIError -> network or upstream blip,
 *     safe to retry with the same idempotency key.
 *   - `idempotency_key_in_use` -> Stripe is still processing the previous
 *     attempt with this key. Retrying immediately re-fires the same code
 *     path; we must NOT spin on it. Returning `false` is the only way to
 *     stop the worker; the caller bumps `attempt` to mint a new key.
 *   - `rate_limit` -> safe to retry after backoff.
 *   - Everything else from a typed Stripe error -> caller bug, terminal.
 */
function isRetryableStripeError(
  error: Stripe.errors.StripeError,
  declineCode: PaymentDeclineCode,
): boolean {
  if (error.type === 'StripeConnectionError' || error.type === 'StripeAPIError') return true;
  // Special-case: do NOT retry an idempotency-key collision; same key + same
  // payload would just keep colliding. The caller's retry strategy must bump
  // `attempt` to mint a new key (Bloco 4 builder).
  if (error.code === 'idempotency_key_in_use') return false;
  if (declineCode === 'RATE_LIMITED') return true;
  return false;
}

/** Exported for unit tests. */
export function mapStripeDeclineCode(code: string | undefined): PaymentDeclineCode {
  switch (code) {
    // Card / issuer responses
    case 'card_declined':
    case 'do_not_honor':
    case 'pickup_card':
    case 'restricted_card':
    case 'service_not_allowed':
    case 'security_violation':
    case 'transaction_not_allowed':
    case 'card_velocity_exceeded':
    case 'withdrawal_count_limit_exceeded':
      return 'ISSUER_DECLINED';

    case 'insufficient_funds':
      return 'INSUFFICIENT_FUNDS';

    case 'incorrect_cvc':
    case 'invalid_cvc':
      return 'INVALID_CVC';

    case 'expired_card':
    case 'invalid_expiry_month':
    case 'invalid_expiry_year':
      return 'EXPIRED_CARD';

    // Fraud signals
    case 'fraudulent':
    case 'stolen_card':
    case 'lost_card':
      return 'FRAUD_SUSPECTED';

    // 3DS / SCA
    case 'authentication_required':
      return 'THREE_DS_REQUIRED';

    // Card shape / network compat
    case 'invalid_number':
    case 'invalid_account':
    case 'card_not_supported':
      return 'CARD_NOT_SUPPORTED';

    // Currency
    case 'currency_not_supported':
      return 'UNSUPPORTED_CURRENCY';

    // Transient — retry candidates
    case 'rate_limit':
      return 'RATE_LIMITED';
    case 'try_again_later':
    case 'processing_error':
      return 'PROCESSING_ERROR';

    // Caller bugs — never retryable
    case 'idempotency_key_in_use':
    case 'invalid_request_error':
    case 'parameter_invalid_empty':
    case 'parameter_invalid_integer':
    case 'parameter_invalid_string_blank':
    case 'parameter_missing':
    case 'parameter_unknown':
      return 'INVALID_REQUEST';

    // Auth
    case 'api_key_expired':
    case 'invalid_api_key':
      return 'AUTH_FAILED';

    default:
      return code ? 'UNKNOWN' : 'PROCESSING_ERROR';
  }
}

/**
 * Validate that a Stripe currency string is one we accept and surface it as
 * the strongly-typed `Money['currency']`. Anything else throws as
 * `UNSUPPORTED_CURRENCY` — better than a silent `as` cast lying to the
 * type system while writing wrong currency labels into the DB.
 */
function parseStripeCurrency(currency: string): Money['currency'] {
  const upper = currency.toUpperCase() as Money['currency'];
  if (!SUPPORTED_CURRENCIES.includes(upper)) {
    throw new PaymentError(`Stripe returned unsupported currency "${currency}"`, {
      gatewayId: 'stripe',
      declineCode: 'UNSUPPORTED_CURRENCY',
      rawCode: currency,
      retryable: false,
    });
  }
  return upper;
}

/**
 * Case-insensitive header lookup. Hono/Express-style header maps may be
 * lowercased, but other deployments preserve the casing the upstream sent.
 * We iterate once instead of taking a `?:` fallback that only catches two
 * variants.
 */
function findHeaderValue(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want && typeof value === 'string') return value;
  }
  return undefined;
}
