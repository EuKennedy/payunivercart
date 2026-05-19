import { timingSafeEqual } from 'node:crypto';
import type { GatewayId } from '@payunivercart/shared';
import { PayunivercartError } from '@payunivercart/shared';
import { type PaymentDeclineCode, PaymentError } from '../errors';
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
} from '../types';

/**
 * PagSeguro / PagBank Orders API adapter. See research §3.
 *
 * Auth: `Authorization: Bearer <token>`.
 * Orders endpoint: POST /orders accepts `qr_codes[]` for Pix, `charges[]`
 * with `payment_method.type: CREDIT_CARD` for card, and a `boleto`
 * payment method for boletos.
 *
 * Webhooks: PagSeguro signs via a shared token sent in the
 * `X-Authenticity-Token` header. We compare to `webhookToken` in
 * constant time.
 */

const API = 'https://api.pagseguro.com';

const TIMEOUTS_MS = {
  payment: 15_000,
  refund: 15_000,
  read: 5_000,
} as const;

export class PagSeguroAdapter implements PaymentGateway<PagSeguroCredentials> {
  readonly id: GatewayId = 'pagseguro';

  parseCredentials(input: unknown): PagSeguroCredentials {
    return pagSeguroCredentialsSchema.parse(input);
  }

  async validateCredentials(credentials: PagSeguroCredentials): Promise<void> {
    try {
      const res = await this.request(credentials, 'GET', '/public-keys/CARD', undefined, {
        timeoutMs: TIMEOUTS_MS.read,
      });
      // PagSeguro returns 200 + a `public_key` body for a healthy token.
      if (res.status === 401 || res.status === 403) {
        throw new PaymentError('PagSeguro credentials are not valid', {
          gatewayId: this.id,
          declineCode: 'AUTH_FAILED',
        });
      }
      if (!res.ok && res.status !== 404) throw await this.mapHttpError(res, 'AUTH_FAILED');
    } catch (cause) {
      if (cause instanceof PaymentError) throw cause;
      throw new PaymentError(
        'PagSeguro credentials check failed',
        { gatewayId: this.id, declineCode: 'AUTH_FAILED' },
        cause,
      );
    }
  }

  async createPix(
    credentials: PagSeguroCredentials,
    input: CreatePixInput,
  ): Promise<PaymentResult> {
    if (input.amount.currency !== 'BRL') {
      throw new PaymentError('PagSeguro Pix only supports BRL', {
        gatewayId: this.id,
        declineCode: 'UNSUPPORTED_CURRENCY',
      });
    }
    const body = {
      reference_id: input.orderId,
      customer: psCustomer(input.customer),
      items: [
        {
          reference_id: input.orderId,
          name: input.description ?? `Order ${input.orderId}`,
          quantity: 1,
          unit_amount: input.amount.amount,
        },
      ],
      qr_codes: [
        {
          amount: { value: input.amount.amount },
          expiration_date: new Date(
            Date.now() + (input.expiresInSeconds ?? 3600) * 1000,
          ).toISOString(),
        },
      ],
      notification_urls: [input.webhookUrl ?? 'https://pay.univercart.com/webhooks/pagseguro'],
      metadata: { workspace_id: input.workspaceId, order_id: input.orderId },
    };
    const res = await this.request(credentials, 'POST', '/orders', body, {
      idempotencyKey: input.idempotencyKey,
      timeoutMs: TIMEOUTS_MS.payment,
    });
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');
    const json = (await res.json()) as PsOrderResponse;
    return this.toPaymentResult(json, 'pix');
  }

  async createCard(
    credentials: PagSeguroCredentials,
    input: CreateCardInput,
  ): Promise<PaymentResult> {
    if (!input.card.token) {
      throw new PaymentError('PagSeguro card token required (browser tokenization)', {
        gatewayId: this.id,
        declineCode: 'INVALID_REQUEST',
      });
    }
    const body = {
      reference_id: input.orderId,
      customer: psCustomer(input.customer),
      items: [
        {
          reference_id: input.orderId,
          name: input.description ?? `Order ${input.orderId}`,
          quantity: 1,
          unit_amount: input.amount.amount,
        },
      ],
      charges: [
        {
          reference_id: input.orderId,
          description: input.description ?? `Order ${input.orderId}`,
          amount: { value: input.amount.amount, currency: 'BRL' },
          payment_method: {
            type: 'CREDIT_CARD',
            installments: input.installments,
            capture: true,
            card: { encrypted: input.card.token, holder: { name: input.card.holderName } },
          },
        },
      ],
      notification_urls: [input.webhookUrl ?? 'https://pay.univercart.com/webhooks/pagseguro'],
      metadata: { workspace_id: input.workspaceId, order_id: input.orderId },
    };
    const res = await this.request(credentials, 'POST', '/orders', body, {
      idempotencyKey: input.idempotencyKey,
      timeoutMs: TIMEOUTS_MS.payment,
    });
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');
    const json = (await res.json()) as PsOrderResponse;
    return this.toPaymentResult(json, 'credit_card');
  }

  async createBoleto(
    credentials: PagSeguroCredentials,
    input: CreateBoletoInput,
  ): Promise<PaymentResult> {
    if (input.amount.currency !== 'BRL') {
      throw new PaymentError('PagSeguro Boleto only supports BRL', {
        gatewayId: this.id,
        declineCode: 'UNSUPPORTED_CURRENCY',
      });
    }
    const body = {
      reference_id: input.orderId,
      customer: psCustomer(input.customer),
      items: [
        {
          reference_id: input.orderId,
          name: input.description ?? `Order ${input.orderId}`,
          quantity: 1,
          unit_amount: input.amount.amount,
        },
      ],
      charges: [
        {
          reference_id: input.orderId,
          description: input.description ?? `Order ${input.orderId}`,
          amount: { value: input.amount.amount, currency: 'BRL' },
          payment_method: {
            type: 'BOLETO',
            boleto: {
              due_date: input.dueDate.toISOString().slice(0, 10),
              instruction_lines: { line_1: 'Pagar até a data de vencimento.' },
              holder: {
                name: input.customer.name,
                tax_id: input.customer.document.replace(/\D/g, ''),
                email: input.customer.email,
                address: psAddress(input.billingAddress),
              },
            },
          },
        },
      ],
      notification_urls: [input.webhookUrl ?? 'https://pay.univercart.com/webhooks/pagseguro'],
      metadata: { workspace_id: input.workspaceId, order_id: input.orderId },
    };
    const res = await this.request(credentials, 'POST', '/orders', body, {
      idempotencyKey: input.idempotencyKey,
      timeoutMs: TIMEOUTS_MS.payment,
    });
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');
    const json = (await res.json()) as PsOrderResponse;
    return this.toPaymentResult(json, 'boleto');
  }

  async refund(credentials: PagSeguroCredentials, input: RefundInput): Promise<RefundResult> {
    const body = input.amount !== undefined ? { amount: { value: input.amount.amount } } : {};
    const res = await this.request(
      credentials,
      'POST',
      `/charges/${encodeURIComponent(input.gatewayChargeId)}/cancel`,
      body,
      { idempotencyKey: input.idempotencyKey, timeoutMs: TIMEOUTS_MS.refund },
    );
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');
    const json = (await res.json()) as PsChargeResponse;
    return {
      gatewayRefundId: String(json.id),
      status: json.status === 'CANCELED' ? 'refunded' : 'processing',
      amount: { amount: json.amount?.value ?? 0, currency: 'BRL' },
      raw: json,
    };
  }

  async getCharge(credentials: PagSeguroCredentials, chargeId: string): Promise<PaymentResult> {
    const res = await this.request(
      credentials,
      'GET',
      `/orders/${encodeURIComponent(chargeId)}`,
      undefined,
      { timeoutMs: TIMEOUTS_MS.read },
    );
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');
    const json = (await res.json()) as PsOrderResponse;
    return this.toPaymentResult(json, derivePsMethod(json));
  }

  /**
   * PagSeguro signs notifications with a shared token in
   * `X-Authenticity-Token`. We compare it to `webhookToken` in
   * constant time.
   */
  verifyWebhook(credentials: PagSeguroCredentials, request: WebhookRequest): WebhookEvent {
    if (!credentials.webhookToken) {
      throw new PaymentError('PagSeguro webhook token not configured', {
        gatewayId: this.id,
        declineCode: 'AUTH_FAILED',
      });
    }
    const provided = findHeader(request.headers, 'x-authenticity-token');
    if (!provided) throw signatureError('Missing X-Authenticity-Token header');

    const a = Buffer.from(credentials.webhookToken, 'utf-8');
    const b = Buffer.from(provided, 'utf-8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw signatureError('PagSeguro webhook token mismatch');
    }
    let payload: {
      id?: unknown;
      type?: unknown;
      charges?: Array<{ id?: unknown }>;
      created_at?: string;
    };
    try {
      payload = JSON.parse(request.rawBody) as typeof payload;
    } catch (cause) {
      throw new PaymentError(
        'PagSeguro webhook body is not valid JSON',
        {
          gatewayId: this.id,
          declineCode: 'INVALID_REQUEST',
        },
        cause,
      );
    }
    return {
      gatewayId: this.id,
      eventId: String(payload.id ?? `ps:${Date.now()}`),
      eventType: String(payload.type ?? 'order'),
      occurredAt: payload.created_at ? new Date(payload.created_at) : new Date(),
      resourceId: String(payload.charges?.[0]?.id ?? payload.id ?? ''),
      raw: payload,
    };
  }

  /* ------------------------------------------------------------------- */

  private async request(
    credentials: PagSeguroCredentials,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    opts: { idempotencyKey?: string; timeoutMs: number },
  ): Promise<Response> {
    const url = `${API}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      return await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${credentials.bearerToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // PagSeguro accepts `x-idempotency-key` to dedupe POSTs.
          ...(opts.idempotencyKey && { 'x-idempotency-key': opts.idempotencyKey }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new PaymentError(
        'PagSeguro upstream unreachable',
        { gatewayId: this.id, declineCode: 'GATEWAY_TIMEOUT', retryable: true },
        cause,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async mapHttpError(res: Response, fallback: PaymentDeclineCode): Promise<PaymentError> {
    const body = (await safeReadJson(res)) as
      | { error_messages?: Array<{ description?: string; code?: string }> }
      | undefined;
    const status = res.status;
    let declineCode: PaymentDeclineCode = fallback;
    if (status === 401 || status === 403) declineCode = 'AUTH_FAILED';
    else if (status === 429) declineCode = 'RATE_LIMITED';
    else if (status >= 500) declineCode = 'GATEWAY_TIMEOUT';
    else if (status === 400 || status === 422) declineCode = 'INVALID_REQUEST';

    const first = body?.error_messages?.[0];
    return new PaymentError(first?.description ?? `PagSeguro returned ${status}`, {
      gatewayId: 'pagseguro',
      declineCode,
      ...(first?.code && { rawCode: first.code }),
      retryable: declineCode === 'GATEWAY_TIMEOUT' || declineCode === 'RATE_LIMITED',
    });
  }

  private toPaymentResult(json: PsOrderResponse, method: PaymentResult['method']): PaymentResult {
    const charge = json.charges?.[0];
    const qr = json.qr_codes?.[0];
    const boletoLink = charge?.links?.find((l) => l.rel === 'PAY')?.href;
    return {
      gatewayId: this.id,
      gatewayChargeId: charge?.id ?? json.id,
      gatewayRequestId: json.id,
      status: mapPsStatus(charge?.status ?? json.status),
      method,
      amount: { amount: json.amount?.value ?? charge?.amount?.value ?? 0, currency: 'BRL' },
      pixQrCode: qr?.text,
      pixQrCodeImage: qr?.links?.find((l) => l.rel === 'QRCODE.PNG')?.href,
      pixCopyPaste: qr?.text,
      pixExpiresAt: qr?.expiration_date ? new Date(qr.expiration_date) : undefined,
      boletoUrl: boletoLink,
      boletoBarcode: charge?.payment_method?.boleto?.barcode?.content,
      boletoDueDate: charge?.payment_method?.boleto?.due_date
        ? new Date(charge.payment_method.boleto.due_date)
        : undefined,
      cardBrand: charge?.payment_method?.card?.brand,
      cardLast4: charge?.payment_method?.card?.last_digits,
      raw: json,
    };
  }
}

/* helpers */

function psCustomer(c: CreatePixInput['customer']) {
  return {
    name: c.name,
    email: c.email,
    tax_id: c.document.replace(/\D/g, ''),
    phones: [
      {
        country: '55',
        area: c.phoneE164.slice(3, 5),
        number: c.phoneE164.slice(5),
        type: 'MOBILE',
      },
    ],
  };
}

function psAddress(a: CreateBoletoInput['billingAddress']) {
  return {
    street: a.street,
    number: a.number,
    complement: a.complement,
    locality: a.neighborhood,
    city: a.city,
    region_code: a.state,
    country: a.country,
    postal_code: a.zipCode.replace(/\D/g, ''),
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
    details: { gatewayId: 'pagseguro' },
  });
}

async function safeReadJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function mapPsStatus(status?: string): PaymentResult['status'] {
  switch (status) {
    case 'WAITING':
    case 'IN_ANALYSIS':
      return 'pending';
    case 'PAID':
      return 'paid';
    case 'AUTHORIZED':
      return 'authorized';
    case 'DECLINED':
      return 'failed';
    case 'CANCELED':
      return 'cancelled';
    default:
      return 'pending';
  }
}

function derivePsMethod(o: PsOrderResponse): PaymentResult['method'] {
  const t = o.charges?.[0]?.payment_method?.type;
  if (!t) return 'pix';
  if (t === 'CREDIT_CARD') return 'credit_card';
  if (t === 'BOLETO') return 'boleto';
  return 'pix';
}

interface PsOrderResponse {
  id: string;
  status?: string;
  amount?: { value: number };
  charges?: Array<{
    id: string;
    status: string;
    amount?: { value: number };
    payment_method?: {
      type?: string;
      card?: { brand?: string; last_digits?: string };
      boleto?: {
        due_date?: string;
        barcode?: { content?: string };
      };
    };
    links?: Array<{ rel: string; href: string }>;
  }>;
  qr_codes?: Array<{
    text?: string;
    expiration_date?: string;
    links?: Array<{ rel: string; href: string }>;
  }>;
}

interface PsChargeResponse {
  id: string;
  status: string;
  amount?: { value: number };
}
