import type { GatewayId } from '@payunivercart/shared';
import { PayunivercartError } from '@payunivercart/shared';
import {
  type CreateBoletoInput,
  type CreateCardInput,
  type CreatePixInput,
  type PagarmeCredentials,
  type PaymentGateway,
  type PaymentResult,
  type RefundInput,
  type RefundResult,
  type WebhookEvent,
  type WebhookRequest,
  pagarmeCredentialsSchema,
} from '../types.js';

/**
 * Pagar.me adapter — see docs/research/payment-gateways.md §2.
 *
 * Implementation status (v0.0.1):
 *   ✓ Credential parsing & schema
 *   ☐ Webhook verification — Pagar.me uses HTTP Basic Auth on the endpoint, no HMAC
 *   ☐ Payment creation (Pix / card / boleto) — pending HTTP integration
 *   ☐ Refund — pending HTTP integration
 *   ☐ getCharge — pending HTTP integration
 */
export class PagarmeAdapter implements PaymentGateway<PagarmeCredentials> {
  readonly id: GatewayId = 'pagarme';

  parseCredentials(input: unknown): PagarmeCredentials {
    return pagarmeCredentialsSchema.parse(input);
  }

  async validateCredentials(_credentials: PagarmeCredentials): Promise<void> {
    throw notImplemented('validateCredentials');
  }

  async createPix(_credentials: PagarmeCredentials, _input: CreatePixInput): Promise<PaymentResult> {
    throw notImplemented('createPix');
  }

  async createCard(_credentials: PagarmeCredentials, _input: CreateCardInput): Promise<PaymentResult> {
    throw notImplemented('createCard');
  }

  async createBoleto(_credentials: PagarmeCredentials, _input: CreateBoletoInput): Promise<PaymentResult> {
    throw notImplemented('createBoleto');
  }

  async refund(_credentials: PagarmeCredentials, _input: RefundInput): Promise<RefundResult> {
    throw notImplemented('refund');
  }

  async getCharge(_credentials: PagarmeCredentials, _chargeId: string): Promise<PaymentResult> {
    throw notImplemented('getCharge');
  }

  verifyWebhook(_credentials: PagarmeCredentials, _request: WebhookRequest): WebhookEvent {
    throw notImplemented('verifyWebhook');
  }
}

function notImplemented(method: string): PayunivercartError {
  return new PayunivercartError({
    code: 'INTERNAL',
    message: `PagarmeAdapter.${method} is not implemented yet; pending HTTP integration.`,
    httpStatus: 501,
  });
}
