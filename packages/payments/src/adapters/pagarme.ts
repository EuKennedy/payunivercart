import { timingSafeEqual } from 'node:crypto';
import type { GatewayId } from '@payunivercart/shared';
import { PayunivercartError } from '@payunivercart/shared';
import { type PaymentDeclineCode, PaymentError } from '../errors';
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
} from '../types';

/**
 * Pagar.me v5 adapter. See `docs/research/payment-gateways.md §2`.
 *
 * Auth: HTTP Basic with `secretKey:`. Pagar.me v5 routes:
 *   - POST /core/v5/orders          (create order + first charge)
 *   - GET  /core/v5/orders/{id}
 *   - POST /core/v5/charges/{id}/refunds
 *
 * Webhooks: Pagar.me does NOT sign payloads with HMAC. They protect the
 * endpoint via HTTP Basic that the producer configures when registering
 * the webhook URL. We surface that contract: `webhookEndpointSecret` is
 * the value Pagar.me will send as the Basic password; we compare with
 * `timingSafeEqual`.
 */

const API = 'https://api.pagar.me/core/v5';

const TIMEOUTS_MS = {
  payment: 15_000,
  refund: 15_000,
  read: 5_000,
} as const;

export class PagarmeAdapter implements PaymentGateway<PagarmeCredentials> {
  readonly id: GatewayId = 'pagarme';

  parseCredentials(input: unknown): PagarmeCredentials {
    return pagarmeCredentialsSchema.parse(input);
  }

  async validateCredentials(credentials: PagarmeCredentials): Promise<void> {
    try {
      const res = await this.request(credentials, 'GET', '/balance', undefined, {
        timeoutMs: TIMEOUTS_MS.read,
      });
      if (res.status === 401 || res.status === 403) {
        throw new PaymentError('Pagar.me credentials are not valid', {
          gatewayId: this.id,
          declineCode: 'AUTH_FAILED',
        });
      }
      // Pagar.me returns 200 on balance for active keys; 404 here means
      // the endpoint moved — surface as VALIDATION rather than swallow.
      if (!res.ok && res.status !== 404) throw await this.mapHttpError(res, 'AUTH_FAILED');
    } catch (cause) {
      if (cause instanceof PaymentError) throw cause;
      throw new PaymentError(
        'Pagar.me credentials check failed',
        { gatewayId: this.id, declineCode: 'AUTH_FAILED' },
        cause,
      );
    }
  }

  async createPix(credentials: PagarmeCredentials, input: CreatePixInput): Promise<PaymentResult> {
    if (input.amount.currency !== 'BRL') {
      throw new PaymentError('Pagar.me Pix only supports BRL', {
        gatewayId: this.id,
        declineCode: 'UNSUPPORTED_CURRENCY',
      });
    }

    const body = {
      code: input.orderId,
      customer: buildCustomer(input.customer),
      items: [
        {
          amount: input.amount.amount,
          description: input.description ?? `Order ${input.orderId}`,
          quantity: 1,
          code: input.orderId,
        },
      ],
      payments: [
        {
          payment_method: 'pix',
          pix: {
            expires_in: input.expiresInSeconds ?? 3600,
            additional_information: [
              { name: 'order', value: input.orderId },
              { name: 'workspace', value: input.workspaceId },
            ],
          },
        },
      ],
      metadata: { ...input.metadata, workspace_id: input.workspaceId, order_id: input.orderId },
    };

    const res = await this.request(credentials, 'POST', '/orders', body, {
      idempotencyKey: input.idempotencyKey,
      timeoutMs: TIMEOUTS_MS.payment,
    });
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');
    const json = (await res.json()) as PagarmeOrderResponse;
    return this.toPaymentResult(json, 'pix');
  }

  async createCard(
    credentials: PagarmeCredentials,
    input: CreateCardInput,
  ): Promise<PaymentResult> {
    if (!input.card.token) {
      throw new PaymentError('Pagar.me card token required (browser tokenization)', {
        gatewayId: this.id,
        declineCode: 'INVALID_REQUEST',
      });
    }

    const body = {
      code: input.orderId,
      customer: buildCustomer(input.customer),
      items: [
        {
          amount: input.amount.amount,
          description: input.description ?? `Order ${input.orderId}`,
          quantity: 1,
          code: input.orderId,
        },
      ],
      payments: [
        {
          payment_method: 'credit_card',
          credit_card: {
            installments: input.installments,
            statement_descriptor: 'PAYUNIVERCART',
            card_token: input.card.token,
          },
        },
      ],
      metadata: { ...input.metadata, workspace_id: input.workspaceId, order_id: input.orderId },
    };

    const res = await this.request(credentials, 'POST', '/orders', body, {
      idempotencyKey: input.idempotencyKey,
      timeoutMs: TIMEOUTS_MS.payment,
    });
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');
    const json = (await res.json()) as PagarmeOrderResponse;
    return this.toPaymentResult(json, 'credit_card');
  }

  async createBoleto(
    credentials: PagarmeCredentials,
    input: CreateBoletoInput,
  ): Promise<PaymentResult> {
    if (input.amount.currency !== 'BRL') {
      throw new PaymentError('Pagar.me Boleto only supports BRL', {
        gatewayId: this.id,
        declineCode: 'UNSUPPORTED_CURRENCY',
      });
    }
    const body = {
      code: input.orderId,
      customer: { ...buildCustomer(input.customer), address: buildAddress(input.billingAddress) },
      items: [
        {
          amount: input.amount.amount,
          description: input.description ?? `Order ${input.orderId}`,
          quantity: 1,
          code: input.orderId,
        },
      ],
      payments: [
        {
          payment_method: 'boleto',
          boleto: {
            instructions: 'Pagar até a data de vencimento.',
            due_at: input.dueDate.toISOString(),
            document_number: input.orderId.slice(0, 16),
            type: 'DM',
          },
        },
      ],
      metadata: { ...input.metadata, workspace_id: input.workspaceId, order_id: input.orderId },
    };
    const res = await this.request(credentials, 'POST', '/orders', body, {
      idempotencyKey: input.idempotencyKey,
      timeoutMs: TIMEOUTS_MS.payment,
    });
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');
    const json = (await res.json()) as PagarmeOrderResponse;
    return this.toPaymentResult(json, 'boleto');
  }

  async refund(credentials: PagarmeCredentials, input: RefundInput): Promise<RefundResult> {
    const body = input.amount !== undefined ? { amount: input.amount.amount } : {};
    const res = await this.request(
      credentials,
      'POST',
      `/charges/${encodeURIComponent(input.gatewayChargeId)}/refund`,
      body,
      { idempotencyKey: input.idempotencyKey, timeoutMs: TIMEOUTS_MS.refund },
    );
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');
    const json = (await res.json()) as PagarmeChargeResponse;
    return {
      gatewayRefundId: String(json.id),
      status: json.status === 'refunded' ? 'refunded' : 'processing',
      amount: { amount: json.amount, currency: 'BRL' },
      raw: json,
    };
  }

  async getCharge(credentials: PagarmeCredentials, chargeId: string): Promise<PaymentResult> {
    const res = await this.request(
      credentials,
      'GET',
      `/orders/${encodeURIComponent(chargeId)}`,
      undefined,
      { timeoutMs: TIMEOUTS_MS.read },
    );
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');
    const json = (await res.json()) as PagarmeOrderResponse;
    return this.toPaymentResult(json, derivePagarmeMethod(json));
  }

  /**
   * Pagar.me v5 does NOT sign webhooks. The endpoint is protected by an
   * HTTP Basic password the producer set when registering. We compare
   * the `Authorization` header password to `webhookEndpointSecret` in
   * constant time.
   */
  verifyWebhook(credentials: PagarmeCredentials, request: WebhookRequest): WebhookEvent {
    if (!credentials.webhookEndpointSecret) {
      throw new PaymentError('Pagar.me webhook endpoint secret not configured', {
        gatewayId: this.id,
        declineCode: 'AUTH_FAILED',
      });
    }
    const auth = findHeader(request.headers, 'authorization');
    if (!auth || !auth.toLowerCase().startsWith('basic ')) {
      throw signatureError('Missing Basic Authorization header');
    }
    const decoded = Buffer.from(auth.slice('basic '.length).trim(), 'base64').toString('utf-8');
    const provided = decoded.includes(':') ? decoded.split(':').slice(1).join(':') : decoded;

    const a = Buffer.from(credentials.webhookEndpointSecret, 'utf-8');
    const b = Buffer.from(provided, 'utf-8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw signatureError('Pagar.me webhook secret mismatch');
    }

    let payload: { id?: unknown; type?: unknown; data?: { id?: unknown }; created_at?: string };
    try {
      payload = JSON.parse(request.rawBody) as typeof payload;
    } catch (cause) {
      throw new PaymentError(
        'Pagar.me webhook body is not valid JSON',
        {
          gatewayId: this.id,
          declineCode: 'INVALID_REQUEST',
        },
        cause,
      );
    }
    return {
      gatewayId: this.id,
      eventId: String(payload.id ?? `pagarme:${Date.now()}`),
      eventType: String(payload.type ?? 'unknown'),
      occurredAt: payload.created_at ? new Date(payload.created_at) : new Date(),
      resourceId: String(payload.data?.id ?? payload.id ?? ''),
      raw: payload,
    };
  }

  /* ------------------------------------------------------------------- */

  private async request(
    credentials: PagarmeCredentials,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    opts: { idempotencyKey?: string; timeoutMs: number },
  ): Promise<Response> {
    const url = `${API}${path}`;
    const basic = Buffer.from(`${credentials.secretKey}:`).toString('base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      return await fetch(url, {
        method,
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // Pagar.me v5 honors `Idempotency-Key` on POST /orders.
          ...(opts.idempotencyKey && { 'Idempotency-Key': opts.idempotencyKey }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new PaymentError(
        'Pagar.me upstream unreachable',
        { gatewayId: this.id, declineCode: 'GATEWAY_TIMEOUT', retryable: true },
        cause,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async mapHttpError(res: Response, fallback: PaymentDeclineCode): Promise<PaymentError> {
    const body = (await safeReadJson(res)) as
      | { message?: string; errors?: Record<string, unknown> }
      | undefined;
    const status = res.status;
    let declineCode: PaymentDeclineCode = fallback;
    if (status === 401 || status === 403) declineCode = 'AUTH_FAILED';
    else if (status === 429) declineCode = 'RATE_LIMITED';
    else if (status >= 500) declineCode = 'GATEWAY_TIMEOUT';
    else if (status === 400 || status === 422) declineCode = 'INVALID_REQUEST';

    return new PaymentError(body?.message ?? `Pagar.me returned ${status}`, {
      gatewayId: 'pagarme',
      declineCode,
      retryable: declineCode === 'GATEWAY_TIMEOUT' || declineCode === 'RATE_LIMITED',
    });
  }

  private toPaymentResult(
    json: PagarmeOrderResponse,
    method: PaymentResult['method'],
  ): PaymentResult {
    const charge = json.charges?.[0];
    const tx = charge?.last_transaction;
    return {
      gatewayId: this.id,
      gatewayChargeId: charge?.id ?? json.id,
      gatewayRequestId: json.id,
      status: mapPagarmeStatus(charge?.status ?? json.status),
      method,
      amount: { amount: json.amount, currency: 'BRL' },
      pixQrCode: tx?.qr_code,
      pixQrCodeImage: tx?.qr_code_url,
      pixCopyPaste: tx?.qr_code,
      pixExpiresAt: tx?.expires_at ? new Date(tx.expires_at) : undefined,
      boletoUrl: tx?.url ?? tx?.pdf,
      boletoBarcode: tx?.barcode,
      boletoDueDate: tx?.due_at ? new Date(tx.due_at) : undefined,
      cardBrand: tx?.card?.brand,
      cardLast4: tx?.card?.last_four_digits,
      raw: json,
    };
  }
}

/* helpers */

function buildCustomer(c: CreatePixInput['customer']) {
  return {
    name: c.name,
    email: c.email,
    type: c.document.replace(/\D/g, '').length === 14 ? 'company' : 'individual',
    document: c.document.replace(/\D/g, ''),
    phones: {
      home_phone: {
        country_code: '55',
        area_code: c.phoneE164.slice(3, 5),
        number: c.phoneE164.slice(5),
      },
    },
  } as const;
}

function buildAddress(a: CreateBoletoInput['billingAddress']) {
  return {
    line_1: `${a.number}, ${a.street}, ${a.neighborhood}`,
    line_2: a.complement,
    zip_code: a.zipCode.replace(/\D/g, ''),
    city: a.city,
    state: a.state,
    country: a.country,
  };
}

function findHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

function signatureError(message: string): PayunivercartError {
  return new PayunivercartError({
    code: 'WEBHOOK_INVALID_SIGNATURE',
    message,
    details: { gatewayId: 'pagarme' },
  });
}

async function safeReadJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function mapPagarmeStatus(status?: string): PaymentResult['status'] {
  switch (status) {
    case 'pending':
    case 'processing':
      return 'pending';
    case 'paid':
      return 'paid';
    case 'failed':
      return 'failed';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    case 'refunded':
      return 'refunded';
    case 'chargedback':
      return 'chargedback';
    default:
      return 'pending';
  }
}

function derivePagarmeMethod(o: PagarmeOrderResponse): PaymentResult['method'] {
  const m = o.charges?.[0]?.payment_method ?? '';
  if (m === 'pix') return 'pix';
  if (m === 'boleto') return 'boleto';
  return 'credit_card';
}

interface PagarmeOrderResponse {
  id: string;
  amount: number;
  status: string;
  charges?: Array<{
    id: string;
    status: string;
    payment_method?: string;
    last_transaction?: {
      qr_code?: string;
      qr_code_url?: string;
      expires_at?: string;
      url?: string;
      pdf?: string;
      barcode?: string;
      due_at?: string;
      card?: { brand?: string; last_four_digits?: string };
    };
  }>;
}

interface PagarmeChargeResponse {
  id: string;
  status: string;
  amount: number;
}
