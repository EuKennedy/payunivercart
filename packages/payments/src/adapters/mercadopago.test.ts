import { createHmac } from 'node:crypto';
import { PayunivercartError } from '@payunivercart/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentError } from '../errors';
import type { CreatePixInput, MercadoPagoCredentials, WebhookRequest } from '../types';
import { MercadoPagoAdapter } from './mercadopago';

/**
 * Exercises the bits we depend on at checkout/webhook time:
 *   - createPix happy-path against the documented MP `/v1/payments`
 *     contract — body, headers, decoded result.
 *   - createPix BRL-only currency guard.
 *   - verifyWebhook signature scheme (manifest + HMAC-SHA256).
 *
 * Network is mocked at the global `fetch` boundary so the suite stays
 * self-contained.
 */

const CREDENTIALS: MercadoPagoCredentials = {
  accessToken: 'TEST-access-token',
  publicKey: 'TEST-public-key',
  webhookSecret: 'super-long-webhook-secret-xyz',
  isSandbox: true,
};

function pixInput(): CreatePixInput {
  return {
    workspaceId: '00000000-0000-0000-0000-000000000001',
    orderId: '00000000-0000-0000-0000-000000000010',
    amount: { amount: 12_345, currency: 'BRL' },
    customer: {
      name: 'Maria Souza',
      email: 'maria@example.com',
      document: '12345678909',
      phoneE164: '+5531984956383',
    },
    description: 'Curso de Foo',
    expiresInSeconds: 3600,
    idempotencyKey: 'idem-abc-123',
    metadata: { public_reference: 'UNV-DEMO1234' },
  };
}

const MP_PAYMENT_OK = {
  id: 1234567890,
  status: 'pending',
  status_detail: 'pending_waiting_transfer',
  transaction_amount: 123.45,
  payment_method_id: 'pix',
  date_of_expiration: '2026-05-19T20:00:00.000-03:00',
  point_of_interaction: {
    transaction_data: {
      qr_code: '00020126...long-pix-payload...6304ABCD',
      qr_code_base64: 'iVBORw0KGgoAAAANSUhEUgAAA...',
    },
  },
};

function mockFetchOnce(payload: unknown, init: ResponseInit = { status: 201 }): void {
  vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
    async () =>
      new Response(JSON.stringify(payload), {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      }),
  );
}

describe('MercadoPagoAdapter.createPix', () => {
  let adapter: MercadoPagoAdapter;
  beforeEach(() => {
    adapter = new MercadoPagoAdapter();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to /v1/payments with bearer + idempotency-key + canonical body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(MP_PAYMENT_OK), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await adapter.createPix(CREDENTIALS, pixInput());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCall = fetchSpy.mock.calls[0];
    if (!firstCall) throw new Error('fetch not called');
    const [url, init] = firstCall;
    expect(String(url)).toBe('https://api.mercadopago.com/v1/payments');
    expect(init?.method).toBe('POST');

    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${CREDENTIALS.accessToken}`);
    expect(headers['X-Idempotency-Key']).toBe('idem-abc-123');
    expect(headers['Content-Type']).toBe('application/json');

    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(sent.payment_method_id).toBe('pix');
    expect(sent.transaction_amount).toBe(123.45);
    expect(sent.external_reference).toBe(pixInput().orderId);
    expect((sent.payer as Record<string, unknown>).email).toBe('maria@example.com');
    expect((sent.metadata as Record<string, unknown>).workspace_id).toBe(pixInput().workspaceId);

    expect(result.status).toBe('pending');
    expect(result.method).toBe('pix');
    expect(result.gatewayChargeId).toBe('1234567890');
    expect(result.amount).toEqual({ amount: 12_345, currency: 'BRL' });
    expect(result.pixQrCode).toContain('00020126');
    expect(result.pixQrCodeImage).toBeTruthy();
  });

  it('rejects non-BRL currency without hitting the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const input: CreatePixInput = {
      ...pixInput(),
      amount: { amount: 1_000, currency: 'USD' },
    };
    await expect(adapter.createPix(CREDENTIALS, input)).rejects.toBeInstanceOf(PaymentError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps a 401 to AUTH_FAILED', async () => {
    mockFetchOnce(
      { message: 'invalid access token', cause: [{ code: 'invalid_token' }] },
      { status: 401 },
    );
    await expect(adapter.createPix(CREDENTIALS, pixInput())).rejects.toMatchObject({
      declineCode: 'AUTH_FAILED',
      gatewayId: 'mercadopago',
    });
  });
});

describe('MercadoPagoAdapter.verifyWebhook', () => {
  const adapter = new MercadoPagoAdapter();
  const dataId = '1234567890';
  const requestId = 'req-1';
  const ts = '1715800000';

  function signedRequest(opts: { tamper?: boolean }): WebhookRequest {
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const secret = CREDENTIALS.webhookSecret ?? '';
    const v1 = createHmac('sha256', secret).update(manifest, 'utf8').digest('hex');
    const finalV1 = opts.tamper ? `${v1.slice(0, -2)}00` : v1;
    return {
      rawBody: JSON.stringify({
        id: 'evt-mp-1',
        action: 'payment.updated',
        type: 'payment',
        data: { id: dataId },
      }),
      headers: {
        'x-signature': `ts=${ts},v1=${finalV1}`,
        'x-request-id': requestId,
      },
      queryParams: { 'data.id': dataId },
    };
  }

  it('returns the canonical WebhookEvent for a valid signature', () => {
    const event = adapter.verifyWebhook(CREDENTIALS, signedRequest({ tamper: false }));
    expect(event.gatewayId).toBe('mercadopago');
    expect(event.resourceId).toBe(dataId);
    expect(event.eventType).toBe('payment.updated');
    expect(event.occurredAt.getTime()).toBe(Number(ts) * 1000);
  });

  it('throws PayunivercartError on a tampered signature', () => {
    expect(() => adapter.verifyWebhook(CREDENTIALS, signedRequest({ tamper: true }))).toThrowError(
      PayunivercartError,
    );
  });

  it('refuses to verify when no webhook secret is configured', () => {
    const credsNoSecret: MercadoPagoCredentials = { ...CREDENTIALS, webhookSecret: undefined };
    expect(() => adapter.verifyWebhook(credsNoSecret, signedRequest({ tamper: false }))).toThrow(
      PaymentError,
    );
  });
});
