import { PayunivercartError } from '@payunivercart/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentError } from '../errors';
import type { CreatePixInput, PagSeguroCredentials, WebhookRequest } from '../types';
import { PagSeguroAdapter } from './pagseguro';

/**
 * PagSeguro adapter — Pix happy-path + webhook (X-Authenticity-Token).
 *
 * Notes specific to PagSeguro:
 *   - Bearer-token auth.
 *   - Webhook signing is a static shared token in `X-Authenticity-Token`
 *     (no HMAC). We compare to `webhookToken` in constant time.
 *   - createPix posts to `/orders` with a `qr_codes[]` block.
 */

const CREDENTIALS: PagSeguroCredentials = {
  bearerToken: 'PS-TEST-bearer-token-xyz',
  publicKey: 'PS-TEST-public-key',
  webhookToken: 'ps-webhook-shared-token-1234567890',
  isSandbox: true,
};

function pixInput(): CreatePixInput {
  return {
    workspaceId: '00000000-0000-0000-0000-000000000001',
    orderId: '00000000-0000-0000-0000-000000000010',
    amount: { amount: 4_990, currency: 'BRL' },
    customer: {
      name: 'Ana Lima',
      email: 'ana@example.com',
      document: '12345678909',
      phoneE164: '+5531984956383',
    },
    description: 'eBook',
    expiresInSeconds: 3600,
    idempotencyKey: 'idem-ps-1',
  };
}

const PS_ORDER_OK = {
  id: 'ORDE_001',
  status: 'WAITING',
  amount: { value: 4_990, currency: 'BRL' },
  qr_codes: [
    {
      id: 'QRCO_001',
      amount: { value: 4_990 },
      text: '00020126...pagseguro-pix...6304QRSH',
      expiration_date: '2026-05-19T21:00:00Z',
      links: [{ rel: 'QRCODE.PNG', href: 'https://api.pagseguro.com/qr/png/QRCO_001' }],
    },
  ],
  charges: [
    {
      id: 'CHAR_001',
      status: 'WAITING',
      amount: { value: 4_990, currency: 'BRL' },
    },
  ],
};

describe('PagSeguroAdapter.createPix', () => {
  let adapter: PagSeguroAdapter;
  beforeEach(() => {
    adapter = new PagSeguroAdapter();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to /orders with Bearer auth + canonical Pix body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(PS_ORDER_OK), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await adapter.createPix(CREDENTIALS, pixInput());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCall = fetchSpy.mock.calls[0];
    if (!firstCall) throw new Error('fetch not called');
    const [url, init] = firstCall;
    expect(String(url)).toBe('https://api.pagseguro.com/orders');
    expect(init?.method).toBe('POST');

    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${CREDENTIALS.bearerToken}`);
    expect(headers['Content-Type']).toBe('application/json');

    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(sent.reference_id).toBe(pixInput().orderId);
    const qrCodes = sent.qr_codes as Record<string, unknown>[];
    expect((qrCodes[0]?.amount as Record<string, unknown>).value).toBe(4_990);

    expect(result.method).toBe('pix');
    expect(result.status).toBe('pending');
    expect(result.gatewayChargeId).toBe('CHAR_001');
    expect(result.amount).toEqual({ amount: 4_990, currency: 'BRL' });
    expect(result.pixQrCode).toContain('00020126');
    expect(result.pixQrCodeImage).toContain('QRCO_001');
  });

  it('refuses non-BRL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      adapter.createPix(CREDENTIALS, { ...pixInput(), amount: { amount: 100, currency: 'USD' } }),
    ).rejects.toBeInstanceOf(PaymentError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps 401 to AUTH_FAILED', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error_messages: [{ code: 'invalid_token' }] }), {
        status: 401,
      }),
    );
    await expect(adapter.createPix(CREDENTIALS, pixInput())).rejects.toMatchObject({
      declineCode: 'AUTH_FAILED',
      gatewayId: 'pagseguro',
    });
  });
});

describe('PagSeguroAdapter.verifyWebhook', () => {
  const adapter = new PagSeguroAdapter();

  function req(token: string): WebhookRequest {
    return {
      rawBody: JSON.stringify({
        id: 'NOTI_001',
        type: 'CHARGE.PAID',
        charges: [{ id: 'CHAR_001' }],
        created_at: '2026-05-19T21:30:00Z',
      }),
      headers: { 'x-authenticity-token': token },
      queryParams: {},
    };
  }

  it('accepts a request whose X-Authenticity-Token matches webhookToken', () => {
    const token = CREDENTIALS.webhookToken ?? '';
    const event = adapter.verifyWebhook(CREDENTIALS, req(token));
    expect(event.gatewayId).toBe('pagseguro');
    expect(event.eventType).toBe('CHARGE.PAID');
    expect(event.resourceId).toBe('CHAR_001');
  });

  it('rejects a wrong token', () => {
    expect(() => adapter.verifyWebhook(CREDENTIALS, req('wrong-token-1234567890'))).toThrowError(
      PayunivercartError,
    );
  });

  it('refuses to verify when no webhookToken is set', () => {
    const credsNoSecret: PagSeguroCredentials = { ...CREDENTIALS, webhookToken: undefined };
    expect(() => adapter.verifyWebhook(credsNoSecret, req('whatever-1234567890'))).toThrow(
      PaymentError,
    );
  });
});
