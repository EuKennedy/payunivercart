import type { GatewayId } from '@payunivercart/shared';
import { PayunivercartError } from '@payunivercart/shared';
import {
  type CreateBoletoInput,
  type CreateCardInput,
  type CreatePixInput,
  type PagSeguroCredentials,
  type PaymentGateway,
  type PaymentResult,
  type RefundInput,
  type RefundResult,
  type WebhookEvent,
  type WebhookRequest,
  pagSeguroCredentialsSchema,
} from '../types.js';

/**
 * PagSeguro / PagBank adapter — see docs/research/payment-gateways.md §3.
 *
 * Implementation status (v0.0.1):
 *   ✓ Credential parsing & schema
 *   ☐ Webhook verification — PagSeguro signs via shared notification token (header check)
 *   ☐ Payment creation (Pix / card / boleto) — pending HTTP integration
 *   ☐ Refund — pending HTTP integration
 *   ☐ getCharge — pending HTTP integration
 */
export class PagSeguroAdapter implements PaymentGateway<PagSeguroCredentials> {
  readonly id: GatewayId = 'pagseguro';

  parseCredentials(input: unknown): PagSeguroCredentials {
    return pagSeguroCredentialsSchema.parse(input);
  }

  async validateCredentials(_credentials: PagSeguroCredentials): Promise<void> {
    throw notImplemented('validateCredentials');
  }

  async createPix(
    _credentials: PagSeguroCredentials,
    _input: CreatePixInput,
  ): Promise<PaymentResult> {
    throw notImplemented('createPix');
  }

  async createCard(
    _credentials: PagSeguroCredentials,
    _input: CreateCardInput,
  ): Promise<PaymentResult> {
    throw notImplemented('createCard');
  }

  async createBoleto(
    _credentials: PagSeguroCredentials,
    _input: CreateBoletoInput,
  ): Promise<PaymentResult> {
    throw notImplemented('createBoleto');
  }

  async refund(_credentials: PagSeguroCredentials, _input: RefundInput): Promise<RefundResult> {
    throw notImplemented('refund');
  }

  async getCharge(_credentials: PagSeguroCredentials, _chargeId: string): Promise<PaymentResult> {
    throw notImplemented('getCharge');
  }

  verifyWebhook(_credentials: PagSeguroCredentials, _request: WebhookRequest): WebhookEvent {
    throw notImplemented('verifyWebhook');
  }
}

function notImplemented(method: string): PayunivercartError {
  return new PayunivercartError({
    code: 'INTERNAL',
    message: `PagSeguroAdapter.${method} is not implemented yet; pending HTTP integration.`,
    httpStatus: 501,
  });
}
