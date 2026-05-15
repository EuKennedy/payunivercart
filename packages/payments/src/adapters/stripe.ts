import type { GatewayId } from '@payunivercart/shared';
import Stripe from 'stripe';
import { PaymentError } from '../errors.js';
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
 * Stripe adapter — primary path for USD card payments.
 * BR Pix and BR boleto require a Stripe account incorporated in Brazil and
 * are surfaced as gated features in the dashboard.
 */
export class StripeAdapter
  implements PaymentGateway<StripeCredentials>
{
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

  async createBoleto(credentials: StripeCredentials, input: CreateBoletoInput): Promise<PaymentResult> {
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
                line2: input.billingAddress.complement,
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
      const refund = await stripe.refunds.create(
        {
          payment_intent: input.gatewayChargeId,
          amount: input.amount ? Number(input.amount.amount) : undefined,
          reason: mapRefundReason(input.reason),
        },
        { idempotencyKey: input.idempotencyKey },
      );

      return {
        gatewayRefundId: refund.id,
        status: refund.status === 'succeeded' ? 'refunded' : 'processing',
        amount: {
          amount: refund.amount,
          currency: refund.currency.toUpperCase() as 'BRL' | 'USD' | 'EUR',
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
    const signature = request.headers['stripe-signature'] ?? request.headers['Stripe-Signature'];
    if (!signature) {
      throw new PaymentError('Missing Stripe-Signature header', {
        gatewayId: this.id,
        declineCode: 'AUTH_FAILED',
      });
    }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(request.rawBody, signature, credentials.webhookSecret);
    } catch (cause) {
      throw new PaymentError('Stripe webhook signature verification failed', {
        gatewayId: this.id,
        declineCode: 'AUTH_FAILED',
      }, cause);
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
  const pixDisplay = nextAction?.type === 'pix_display_qr_code' ? nextAction.pix_display_qr_code : undefined;
  const boletoDisplay = nextAction?.type === 'boleto_display_details' ? nextAction.boleto_display_details : undefined;
  const charge = intent.latest_charge && typeof intent.latest_charge === 'object' ? intent.latest_charge : undefined;
  const card = charge?.payment_method_details?.card;

  return {
    gatewayId: 'stripe',
    gatewayChargeId: intent.id,
    gatewayRequestId: intent.id,
    status: mapStripeStatus(intent.status),
    method: derivePaymentMethod(intent),
    amount: {
      amount: intent.amount,
      currency: intent.currency.toUpperCase() as 'BRL' | 'USD' | 'EUR',
    },
    pixQrCode: pixDisplay?.data,
    pixQrCodeImage: pixDisplay?.image_url_png ?? pixDisplay?.image_url_svg,
    pixCopyPaste: pixDisplay?.data,
    pixExpiresAt: pixDisplay?.expires_at ? new Date(pixDisplay.expires_at * 1000) : undefined,
    boletoUrl: boletoDisplay?.hosted_voucher_url ?? undefined,
    boletoBarcode: boletoDisplay?.number ?? undefined,
    boletoDueDate: boletoDisplay?.expires_at ? new Date(boletoDisplay.expires_at * 1000) : undefined,
    cardBrand: card?.brand,
    cardLast4: card?.last4,
    cardThreeDsRedirectUrl:
      nextAction?.type === 'redirect_to_url' ? nextAction.redirect_to_url?.url ?? undefined : undefined,
    raw: intent,
  };
}

function mapStripeStatus(status: Stripe.PaymentIntent.Status): PaymentResult['status'] {
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

function flattenMetadata(meta: Record<string, string | number | boolean> | undefined): Record<string, string> {
  if (!meta) return {};
  return Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, String(v)]));
}

function mapStripeError(cause: unknown): PaymentError {
  if (cause instanceof Stripe.errors.StripeError) {
    const declineCode = mapStripeDeclineCode(cause.code);
    return new PaymentError(cause.message, {
      gatewayId: 'stripe',
      declineCode,
      rawCode: cause.code,
      rawMessage: cause.message,
      retryable: cause.type === 'StripeConnectionError' || cause.type === 'StripeAPIError',
    }, cause);
  }
  return new PaymentError('Unexpected Stripe error', {
    gatewayId: 'stripe',
    declineCode: 'UNKNOWN',
  }, cause);
}

function mapStripeDeclineCode(code: string | undefined): import('../errors.js').PaymentDeclineCode {
  switch (code) {
    case 'card_declined':
      return 'ISSUER_DECLINED';
    case 'insufficient_funds':
      return 'INSUFFICIENT_FUNDS';
    case 'incorrect_cvc':
    case 'invalid_cvc':
      return 'INVALID_CVC';
    case 'expired_card':
      return 'EXPIRED_CARD';
    case 'fraudulent':
      return 'FRAUD_SUSPECTED';
    case 'authentication_required':
      return 'THREE_DS_REQUIRED';
    case 'rate_limit':
      return 'RATE_LIMITED';
    case 'idempotency_key_in_use':
      return 'PROCESSING_ERROR';
    case 'invalid_request_error':
      return 'INVALID_REQUEST';
    default:
      return code ? 'UNKNOWN' : 'PROCESSING_ERROR';
  }
}
