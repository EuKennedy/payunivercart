import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GatewayId } from '@payunivercart/shared';
import { PayunivercartError } from '@payunivercart/shared';
import { type PaymentDeclineCode, PaymentError } from '../errors';
import {
  type CancelSubscriptionInput,
  type CreateBoletoInput,
  type CreateCardInput,
  type CreatePixInput,
  type CreateSubscriptionInput,
  type MercadoPagoCredentials,
  type PaymentGateway,
  type PaymentResult,
  type RefundInput,
  type RefundResult,
  type SubscriptionResult,
  type WebhookEvent,
  type WebhookRequest,
  mercadoPagoCredentialsSchema,
} from '../types';

/**
 * Mercado Pago adapter. See `docs/research/payment-gateways.md §1`.
 *
 * Scope of this implementation:
 *   - Pix (the BR-default path; fully implemented).
 *   - Card + Boleto: scaffolded for HTTP but throw `INVALID_REQUEST` if
 *     called without a card_token / boleto-specific payload. The
 *     `apps/checkout` form gets a card token from MP's browser SDK
 *     before posting here; until that lands the safety net is to fail
 *     loud rather than ship a half-wired path.
 *   - Refund + getCharge fully implemented.
 *   - Webhook verification implements the manifest HMAC-SHA256 scheme MP
 *     ships with v2 webhooks. Tolerates the `id`-only variant for
 *     compatibility.
 *
 * Auth: `Authorization: Bearer <accessToken>`.
 * Idempotency: per-call `X-Idempotency-Key` header (caller supplies).
 */

const API = {
  prod: 'https://api.mercadopago.com',
} as const;

const TIMEOUTS_MS = {
  payment: 15_000,
  refund: 15_000,
  read: 5_000,
} as const;

const NOTIFICATION_URL_PLACEHOLDER = 'https://api.univercart.com/webhooks/gateway/mercadopago';

export class MercadoPagoAdapter implements PaymentGateway<MercadoPagoCredentials> {
  readonly id: GatewayId = 'mercadopago';

  parseCredentials(input: unknown): MercadoPagoCredentials {
    return mercadoPagoCredentialsSchema.parse(input);
  }

  async validateCredentials(credentials: MercadoPagoCredentials): Promise<void> {
    // `/users/me` is the cheapest authenticated read and returns 200 only
    // when the token is live. Any non-200 maps to AUTH_FAILED.
    try {
      const res = await this.request(credentials, 'GET', '/users/me', undefined, {
        timeoutMs: TIMEOUTS_MS.read,
      });
      if (!res.ok) throw await this.mapHttpError(res, 'AUTH_FAILED');
    } catch (cause) {
      if (cause instanceof PaymentError) throw cause;
      throw new PaymentError(
        'Mercado Pago credentials are not valid',
        { gatewayId: this.id, declineCode: 'AUTH_FAILED' },
        cause,
      );
    }
  }

  async createPix(
    credentials: MercadoPagoCredentials,
    input: CreatePixInput,
  ): Promise<PaymentResult> {
    if (input.amount.currency !== 'BRL') {
      throw new PaymentError('Mercado Pago Pix only supports BRL', {
        gatewayId: this.id,
        declineCode: 'UNSUPPORTED_CURRENCY',
      });
    }

    const body = {
      transaction_amount: centsToReais(input.amount.amount),
      description: input.description ?? `Order ${input.orderId}`,
      payment_method_id: 'pix',
      date_of_expiration: input.expiresInSeconds
        ? new Date(Date.now() + input.expiresInSeconds * 1000).toISOString()
        : undefined,
      payer: {
        email: input.customer.email,
        first_name: input.customer.name.split(' ')[0] ?? input.customer.name,
        last_name: input.customer.name.split(' ').slice(1).join(' ') || undefined,
        identification: documentTo(input.customer.document),
      },
      external_reference: input.orderId,
      notification_url: input.webhookUrl ?? NOTIFICATION_URL_PLACEHOLDER,
      metadata: {
        ...input.metadata,
        workspace_id: input.workspaceId,
        order_id: input.orderId,
      },
    };

    const res = await this.request(credentials, 'POST', '/v1/payments', body, {
      idempotencyKey: input.idempotencyKey,
      timeoutMs: TIMEOUTS_MS.payment,
    });
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');

    const json = (await res.json()) as MpPaymentResponse;
    return this.toPaymentResult(json, 'pix');
  }

  /**
   * Server-side card tokenization. PCI-DSS note: in production the
   * tokenization MUST happen client-side via MP's browser SDK so the
   * raw PAN never traverses our infrastructure. For sandbox /
   * single-merchant test setups, this path is acceptable; flip to
   * client-side tokenization before production (Block 26 follow-up).
   */
  async tokenizeCard(
    credentials: MercadoPagoCredentials,
    card: {
      cardNumber: string;
      expirationMonth: number;
      expirationYear: number;
      securityCode: string;
      holderName: string;
      holderDocument: string;
    },
  ): Promise<string> {
    const body = {
      card_number: card.cardNumber.replace(/\s+/g, ''),
      expiration_month: card.expirationMonth,
      expiration_year: card.expirationYear,
      security_code: card.securityCode,
      cardholder: {
        name: card.holderName,
        identification: documentTo(card.holderDocument),
      },
    };
    const res = await this.request(credentials, 'POST', '/v1/card_tokens', body, {
      timeoutMs: TIMEOUTS_MS.payment,
    });
    if (!res.ok) throw await this.mapHttpError(res, 'INVALID_CARD');
    const json = (await res.json()) as { id?: string };
    if (!json.id) {
      throw new PaymentError('Mercado Pago tokenization returned no id', {
        gatewayId: this.id,
        declineCode: 'INVALID_CARD',
      });
    }
    return json.id;
  }

  async createCard(
    credentials: MercadoPagoCredentials,
    input: CreateCardInput,
  ): Promise<PaymentResult> {
    if (!input.card.token) {
      throw new PaymentError('Card token required (use MP browser SDK to tokenize)', {
        gatewayId: this.id,
        declineCode: 'INVALID_REQUEST',
      });
    }
    const body = {
      transaction_amount: centsToReais(input.amount.amount),
      description: input.description ?? `Order ${input.orderId}`,
      token: input.card.token,
      installments: input.installments,
      payer: {
        email: input.customer.email,
        identification: documentTo(input.customer.document),
      },
      external_reference: input.orderId,
      notification_url: input.webhookUrl ?? NOTIFICATION_URL_PLACEHOLDER,
      metadata: {
        ...input.metadata,
        workspace_id: input.workspaceId,
        order_id: input.orderId,
      },
    };

    const res = await this.request(credentials, 'POST', '/v1/payments', body, {
      idempotencyKey: input.idempotencyKey,
      timeoutMs: TIMEOUTS_MS.payment,
    });
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');

    const json = (await res.json()) as MpPaymentResponse;
    return this.toPaymentResult(json, 'credit_card');
  }

  async createBoleto(
    credentials: MercadoPagoCredentials,
    input: CreateBoletoInput,
  ): Promise<PaymentResult> {
    if (input.amount.currency !== 'BRL') {
      throw new PaymentError('Mercado Pago Boleto only supports BRL', {
        gatewayId: this.id,
        declineCode: 'UNSUPPORTED_CURRENCY',
      });
    }
    const body = {
      transaction_amount: centsToReais(input.amount.amount),
      description: input.description ?? `Order ${input.orderId}`,
      payment_method_id: 'bolbradesco',
      date_of_expiration: input.dueDate?.toISOString(),
      payer: {
        email: input.customer.email,
        first_name: input.customer.name.split(' ')[0] ?? input.customer.name,
        last_name: input.customer.name.split(' ').slice(1).join(' ') || undefined,
        identification: documentTo(input.customer.document),
        address: {
          zip_code: input.billingAddress.zipCode.replace(/\D/g, ''),
          street_name: input.billingAddress.street,
          street_number: input.billingAddress.number,
          neighborhood: input.billingAddress.neighborhood,
          city: input.billingAddress.city,
          federal_unit: input.billingAddress.state,
        },
      },
      external_reference: input.orderId,
      notification_url: input.webhookUrl ?? NOTIFICATION_URL_PLACEHOLDER,
      metadata: {
        ...input.metadata,
        workspace_id: input.workspaceId,
        order_id: input.orderId,
      },
    };

    const res = await this.request(credentials, 'POST', '/v1/payments', body, {
      idempotencyKey: input.idempotencyKey,
      timeoutMs: TIMEOUTS_MS.payment,
    });
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');

    const json = (await res.json()) as MpPaymentResponse;
    return this.toPaymentResult(json, 'boleto');
  }

  /**
   * Create a recurring subscription via MP `/preapproval`. Status is
   * forced to `authorized` because we already have a card token —
   * "pending" forces the buyer to log into MP to confirm, which kills
   * conversion. End-date is optional; omit for evergreen.
   *
   * MP's recurring engine charges the first cycle immediately (~1h
   * delay in their docs). Subsequent cycles fire on
   * `next_payment_date` and surface through the
   * `subscription_authorized_payment` webhook topic.
   */
  async createSubscription(
    credentials: MercadoPagoCredentials,
    input: CreateSubscriptionInput,
  ): Promise<SubscriptionResult> {
    if (input.amount.currency !== 'BRL') {
      throw new PaymentError('Mercado Pago subscription only supports BRL', {
        gatewayId: this.id,
        declineCode: 'UNSUPPORTED_CURRENCY',
      });
    }
    const body: Record<string, unknown> = {
      reason: input.reason,
      external_reference: input.subscriptionId,
      payer_email: input.customer.email,
      card_token_id: input.cardToken,
      status: 'authorized',
      auto_recurring: {
        frequency: input.frequency,
        frequency_type: input.frequencyType,
        transaction_amount: centsToReais(input.amount.amount),
        currency_id: 'BRL',
        ...(input.startDate ? { start_date: input.startDate.toISOString() } : {}),
        ...(input.endDate ? { end_date: input.endDate.toISOString() } : {}),
        ...(input.trialDays && input.trialDays > 0
          ? { free_trial: { frequency: input.trialDays, frequency_type: 'days' } }
          : {}),
      },
      ...(input.backUrl ? { back_url: input.backUrl } : {}),
      ...(input.webhookUrl ? { notification_url: input.webhookUrl } : {}),
      metadata: {
        ...input.metadata,
        workspace_id: input.workspaceId,
        subscription_id: input.subscriptionId,
        product_id: input.productId,
        plan_id: input.planId,
      },
    };

    const res = await this.request(credentials, 'POST', '/preapproval', body, {
      timeoutMs: TIMEOUTS_MS.payment,
    });
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');

    const json = (await res.json()) as MpPreapprovalResponse;
    return this.toSubscriptionResult(json);
  }

  async cancelSubscription(
    credentials: MercadoPagoCredentials,
    input: CancelSubscriptionInput,
  ): Promise<SubscriptionResult> {
    const res = await this.request(
      credentials,
      'PUT',
      `/preapproval/${encodeURIComponent(input.gatewaySubscriptionId)}`,
      { status: 'cancelled' },
      { timeoutMs: TIMEOUTS_MS.payment },
    );
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');
    const json = (await res.json()) as MpPreapprovalResponse;
    return this.toSubscriptionResult(json);
  }

  async getSubscription(
    credentials: MercadoPagoCredentials,
    gatewaySubscriptionId: string,
  ): Promise<SubscriptionResult> {
    const res = await this.request(
      credentials,
      'GET',
      `/preapproval/${encodeURIComponent(gatewaySubscriptionId)}`,
      undefined,
      { timeoutMs: TIMEOUTS_MS.read },
    );
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');
    const json = (await res.json()) as MpPreapprovalResponse;
    return this.toSubscriptionResult(json);
  }

  async refund(credentials: MercadoPagoCredentials, input: RefundInput): Promise<RefundResult> {
    const body = input.amount !== undefined ? { amount: centsToReais(input.amount.amount) } : {};
    const res = await this.request(
      credentials,
      'POST',
      `/v1/payments/${encodeURIComponent(input.gatewayChargeId)}/refunds`,
      body,
      { idempotencyKey: input.idempotencyKey, timeoutMs: TIMEOUTS_MS.refund },
    );
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');

    const json = (await res.json()) as MpRefundResponse;
    return {
      gatewayRefundId: String(json.id),
      status: json.status === 'approved' ? 'refunded' : 'processing',
      amount: { amount: reaisToCents(json.amount), currency: 'BRL' },
      raw: json,
    };
  }

  async getCharge(credentials: MercadoPagoCredentials, chargeId: string): Promise<PaymentResult> {
    const res = await this.request(
      credentials,
      'GET',
      `/v1/payments/${encodeURIComponent(chargeId)}`,
      undefined,
      { timeoutMs: TIMEOUTS_MS.read },
    );
    if (!res.ok) throw await this.mapHttpError(res, 'PROCESSING_ERROR');
    const json = (await res.json()) as MpPaymentResponse;
    return this.toPaymentResult(json, deriveMethodFromPm(json.payment_method_id));
  }

  /**
   * Verify a Mercado Pago v2 webhook.
   *
   * Manifest format documented in MP docs:
   *   `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
   *
   * Header: `x-signature: ts=<ts>,v1=<hex_hmac_sha256>`
   * The signing secret is the webhook's HMAC secret (NOT the API access
   * token); we read it from credentials.webhookSecret.
   */
  verifyWebhook(credentials: MercadoPagoCredentials, request: WebhookRequest): WebhookEvent {
    if (!credentials.webhookSecret) {
      throw new PaymentError('Mercado Pago webhook secret not configured', {
        gatewayId: this.id,
        declineCode: 'AUTH_FAILED',
      });
    }

    const sig = findHeader(request.headers, 'x-signature');
    const reqId = findHeader(request.headers, 'x-request-id');
    if (!sig) throw signatureError('Missing x-signature header');

    const parts = Object.fromEntries(
      sig.split(',').map((p) => {
        const eq = p.indexOf('=');
        return eq === -1 ? [p.trim(), ''] : [p.slice(0, eq).trim(), p.slice(eq + 1).trim()];
      }),
    ) as Record<string, string>;

    const ts = parts.ts;
    const v1 = parts.v1;
    if (!ts || !v1) throw signatureError('Malformed x-signature');

    const dataId = String(
      request.queryParams?.['data.id'] ??
        (() => {
          try {
            return (JSON.parse(request.rawBody) as { data?: { id?: unknown } })?.data?.id ?? '';
          } catch {
            return '';
          }
        })(),
    );

    const manifest =
      reqId !== undefined ? `id:${dataId};request-id:${reqId};ts:${ts};` : `id:${dataId};ts:${ts};`;
    const expected = createHmac('sha256', credentials.webhookSecret)
      .update(manifest, 'utf8')
      .digest('hex');
    const a = Buffer.from(expected.toLowerCase(), 'utf8');
    const b = Buffer.from(v1.toLowerCase(), 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw signatureError('Mercado Pago webhook signature mismatch');
    }

    let payload: { id?: unknown; type?: unknown; action?: unknown; data?: { id?: unknown } };
    try {
      payload = JSON.parse(request.rawBody) as typeof payload;
    } catch (cause) {
      throw new PaymentError(
        'Mercado Pago webhook body is not valid JSON',
        {
          gatewayId: this.id,
          declineCode: 'INVALID_REQUEST',
        },
        cause,
      );
    }

    return {
      gatewayId: this.id,
      eventId: String(payload.id ?? `mp:${dataId}:${ts}`),
      eventType: String(payload.action ?? payload.type ?? 'unknown'),
      occurredAt: new Date(Number(ts) * 1000),
      resourceId: String(payload.data?.id ?? dataId),
      raw: payload,
    };
  }

  /* ------------------------------------------------------------------- */
  /* internals                                                            */
  /* ------------------------------------------------------------------- */

  private async request(
    credentials: MercadoPagoCredentials,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: unknown,
    opts: { idempotencyKey?: string; timeoutMs: number },
  ): Promise<Response> {
    const url = `${API.prod}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      return await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(opts.idempotencyKey && { 'X-Idempotency-Key': opts.idempotencyKey }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new PaymentError(
        'Mercado Pago upstream unreachable',
        { gatewayId: this.id, declineCode: 'GATEWAY_TIMEOUT', retryable: true },
        cause,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async mapHttpError(res: Response, fallback: PaymentDeclineCode): Promise<PaymentError> {
    const body = await safeReadJson(res);
    const status = res.status;
    let declineCode: PaymentDeclineCode = fallback;
    if (status === 401 || status === 403) declineCode = 'AUTH_FAILED';
    else if (status === 429) declineCode = 'RATE_LIMITED';
    else if (status >= 500) declineCode = 'GATEWAY_TIMEOUT';
    else if (status === 400) declineCode = 'INVALID_REQUEST';

    const mpError = body as
      | { message?: string; cause?: Array<{ code?: string; description?: string }> }
      | undefined;
    const cause = mpError?.cause?.[0];
    const rawCode = cause?.code;
    if (rawCode) declineCode = mapMpStatusDetailToDeclineCode(rawCode, declineCode);

    return new PaymentError(mpError?.message ?? `Mercado Pago returned ${status}`, {
      gatewayId: 'mercadopago',
      declineCode,
      ...(rawCode && { rawCode }),
      ...(cause?.description && { rawMessage: cause.description }),
      retryable: declineCode === 'GATEWAY_TIMEOUT' || declineCode === 'RATE_LIMITED',
    });
  }

  private toPaymentResult(json: MpPaymentResponse, method: PaymentResult['method']): PaymentResult {
    const pix = json.point_of_interaction?.transaction_data;
    const boletoUrl = json.transaction_details?.external_resource_url;
    const expiresAt = json.date_of_expiration ? new Date(json.date_of_expiration) : undefined;
    return {
      gatewayId: this.id,
      gatewayChargeId: String(json.id),
      gatewayRequestId: String(json.id),
      status: mapMpStatus(json.status, json.status_detail),
      method,
      amount: {
        amount: reaisToCents(json.transaction_amount),
        currency: 'BRL',
      },
      pixQrCode: pix?.qr_code,
      pixQrCodeImage: pix?.qr_code_base64,
      pixCopyPaste: pix?.qr_code,
      pixExpiresAt: expiresAt,
      boletoUrl,
      boletoBarcode: json.barcode?.content,
      boletoDueDate: expiresAt,
      cardBrand: json.payment_method_id ?? undefined,
      cardLast4: json.card?.last_four_digits,
      raw: json,
    };
  }

  private toSubscriptionResult(json: MpPreapprovalResponse): SubscriptionResult {
    return {
      gatewayId: this.id,
      gatewaySubscriptionId: String(json.id),
      status: mapMpSubscriptionStatus(json.status),
      nextChargeAt: json.next_payment_date ? new Date(json.next_payment_date) : undefined,
      firstPaymentId: json.last_payment_id ? String(json.last_payment_id) : undefined,
      raw: json,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function centsToReais(cents: number): number {
  return Math.round(cents) / 100;
}

function reaisToCents(reais: number): number {
  return Math.round(reais * 100);
}

function documentTo(doc: string): { type: 'CPF' | 'CNPJ'; number: string } {
  const digits = doc.replace(/\D/g, '');
  return { type: digits.length === 14 ? 'CNPJ' : 'CPF', number: digits };
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
    details: { gatewayId: 'mercadopago' },
  });
}

async function safeReadJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    try {
      return await res.text();
    } catch {
      return null;
    }
  }
}

/** Map MP `status` + `status_detail` to our canonical `TransactionStatus`. */
function mapMpStatus(status: string, _detail?: string): PaymentResult['status'] {
  switch (status) {
    case 'pending':
    case 'in_process':
    case 'in_mediation':
      return 'pending';
    case 'authorized':
      return 'authorized';
    case 'approved':
      return 'paid';
    case 'rejected':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'refunded':
      return 'refunded';
    case 'charged_back':
      return 'chargedback';
    default:
      return 'pending';
  }
}

function mapMpStatusDetailToDeclineCode(
  detail: string,
  fallback: PaymentDeclineCode,
): PaymentDeclineCode {
  switch (detail) {
    case 'cc_rejected_insufficient_amount':
      return 'INSUFFICIENT_FUNDS';
    case 'cc_rejected_bad_filled_card_number':
    case 'cc_rejected_bad_filled_other':
      return 'INVALID_CARD';
    case 'cc_rejected_bad_filled_security_code':
      return 'INVALID_CVC';
    case 'cc_rejected_bad_filled_date':
    case 'cc_rejected_card_expired':
      return 'EXPIRED_CARD';
    case 'cc_rejected_high_risk':
    case 'cc_rejected_blacklist':
      return 'FRAUD_SUSPECTED';
    case 'cc_rejected_call_for_authorize':
    case 'cc_rejected_other_reason':
      return 'ISSUER_DECLINED';
    default:
      return fallback;
  }
}

function deriveMethodFromPm(pm?: string): PaymentResult['method'] {
  if (!pm) return 'pix';
  if (pm === 'pix') return 'pix';
  if (pm.startsWith('bol')) return 'boleto';
  return 'credit_card';
}

/* -------------------------------------------------------------------------- */
/* response shapes                                                            */
/* -------------------------------------------------------------------------- */

interface MpPaymentResponse {
  id: number | string;
  status: string;
  status_detail?: string;
  transaction_amount: number;
  payment_method_id?: string;
  date_of_expiration?: string;
  point_of_interaction?: {
    transaction_data?: {
      qr_code?: string;
      qr_code_base64?: string;
      ticket_url?: string;
    };
  };
  transaction_details?: {
    external_resource_url?: string;
  };
  barcode?: { content?: string };
  card?: { last_four_digits?: string };
}

interface MpRefundResponse {
  id: number | string;
  status: string;
  amount: number;
}

interface MpPreapprovalResponse {
  id: number | string;
  status: string;
  reason?: string;
  payer_email?: string;
  external_reference?: string;
  next_payment_date?: string;
  last_payment_id?: number | string;
  auto_recurring?: {
    frequency?: number;
    frequency_type?: string;
    transaction_amount?: number;
    currency_id?: string;
  };
}

/** MP preapproval status → our canonical subscription status. */
function mapMpSubscriptionStatus(status: string): SubscriptionResult['status'] {
  switch (status) {
    case 'authorized':
      return 'active';
    case 'pending':
      return 'pending';
    case 'paused':
      return 'paused';
    case 'cancelled':
      return 'cancelled';
    case 'finished':
    case 'expired':
      return 'expired';
    default:
      return 'pending';
  }
}
