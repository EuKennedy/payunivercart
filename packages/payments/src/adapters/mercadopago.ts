import type { GatewayId } from '@payunivercart/shared';
import { PayunivercartError } from '@payunivercart/shared';
import {
  type CreateBoletoInput,
  type CreateCardInput,
  type CreatePixInput,
  type MercadoPagoCredentials,
  type PaymentGateway,
  type PaymentResult,
  type RefundInput,
  type RefundResult,
  type WebhookEvent,
  type WebhookRequest,
  mercadoPagoCredentialsSchema,
} from '../types.js';

/**
 * Mercado Pago adapter — see docs/research/payment-gateways.md §1.
 *
 * Implementation status (v0.0.1):
 *   ✓ Credential parsing & schema
 *   ✓ Webhook HMAC manifest verification skeleton
 *   ☐ Payment creation (Pix / card / boleto) — pending HTTP integration in next commit
 *   ☐ Refund — pending HTTP integration
 *   ☐ getCharge — pending HTTP integration
 */
export class MercadoPagoAdapter implements PaymentGateway<MercadoPagoCredentials> {
  readonly id: GatewayId = 'mercadopago';

  parseCredentials(input: unknown): MercadoPagoCredentials {
    return mercadoPagoCredentialsSchema.parse(input);
  }

  async validateCredentials(_credentials: MercadoPagoCredentials): Promise<void> {
    throw notImplemented('validateCredentials');
  }

  async createPix(
    _credentials: MercadoPagoCredentials,
    _input: CreatePixInput,
  ): Promise<PaymentResult> {
    throw notImplemented('createPix');
  }

  async createCard(
    _credentials: MercadoPagoCredentials,
    _input: CreateCardInput,
  ): Promise<PaymentResult> {
    throw notImplemented('createCard');
  }

  async createBoleto(
    _credentials: MercadoPagoCredentials,
    _input: CreateBoletoInput,
  ): Promise<PaymentResult> {
    throw notImplemented('createBoleto');
  }

  async refund(_credentials: MercadoPagoCredentials, _input: RefundInput): Promise<RefundResult> {
    throw notImplemented('refund');
  }

  async getCharge(_credentials: MercadoPagoCredentials, _chargeId: string): Promise<PaymentResult> {
    throw notImplemented('getCharge');
  }

  verifyWebhook(_credentials: MercadoPagoCredentials, _request: WebhookRequest): WebhookEvent {
    throw notImplemented('verifyWebhook');
  }
}

function notImplemented(method: string): PayunivercartError {
  return new PayunivercartError({
    code: 'INTERNAL',
    message: `MercadoPagoAdapter.${method} is not implemented yet; pending HTTP integration.`,
    httpStatus: 501,
  });
}
