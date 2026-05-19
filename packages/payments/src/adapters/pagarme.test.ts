import { PayunivercartError } from '@payunivercart/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentError } from '../errors';
import type { CreatePixInput, PagarmeCredentials, WebhookRequest } from '../types';
import { PagarmeAdapter } from './pagarme';

/**
 * Pagar.me v5 adapter — covers createPix happy-path + verifyWebhook.
 *
 * Notes specific to Pagar.me:
 *   - HTTP Basic auth: `Basic base64(<secretKey>:)` (empty user, secret
 *     as password — quirky but documented).
 *   - Pagar.me does NOT sign webhooks. They protect the endpoint with
 *     HTTP Basic and we compare the password to `webhookEndpointSecret`.
 *   - createPix posts to `/orders` with `payments[].payment_method=pix`.
 */

const CREDENTIALS: PagarmeCredentials = {
  secretKey: 'sk_test_pagarme_xyz123',
  publicKey: 'pk_test_pagarme_xyz123',
  webhookEndpointSecret: 'wh-endpoint-secret-1234567890',
  isSandbox: true,
};

function pixInput(): CreatePixInput {
  return {
    workspaceId: '00000000-0000-0000-0000-000000000001',
    orderId: '00000000-0000-0000-0000-000000000010',
    amount: { amount: 9_900, currency: 'BRL' },
    customer: {
      name: 'João da Silva',
      email: 'joao@example.com',
      document: '12345678909',
      phoneE164: '+5531984956383',
    },
    description: 'Plano Premium',
    expiresInSeconds: 3600,
    idempotencyKey: 'idem-pagarme-1',
  };
}

const PAGARME_ORDER_OK = {
  id: 'or_test_12345',
  status: 'pending',
  amount: 9_900,
  charges: [
    {
      id: 'ch_test_67890',
      status: 'pending',
      last_transaction: {
        qr_code: '00020126...pagarme-pix...6304XYZW',
        qr_code_url: 'https://api.pagar.me/qr/abc.png',
        expires_at: '2026-05-19T20:00:00Z',
      },
    },
  ],
};

describe('PagarmeAdapter.createPix', () => {
  let adapter: PagarmeAdapter;
  beforeEach(() => {
    adapter = new PagarmeAdapter();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to /core/v5/orders with Basic auth + canonical Pix body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(PAGARME_ORDER_OK), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await adapter.createPix(CREDENTIALS, pixInput());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCall = fetchSpy.mock.calls[0];
    if (!firstCall) throw new Error('fetch not called');
    const [url, init] = firstCall;
    expect(String(url)).toBe('https://api.pagar.me/core/v5/orders');
    expect(init?.method).toBe('POST');

    const headers = init?.headers as Record<string, string>;
    const expectedBasic = Buffer.from(`${CREDENTIALS.secretKey}:`).toString('base64');
    expect(headers.Authorization).toBe(`Basic ${expectedBasic}`);
    expect(headers['Content-Type']).toBe('application/json');

    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(sent.code).toBe(pixInput().orderId);
    const payments = sent.payments as Record<string, unknown>[];
    expect(payments[0]?.payment_method).toBe('pix');
    const items = sent.items as Record<string, unknown>[];
    expect(items[0]?.amount).toBe(9_900);

    expect(result.method).toBe('pix');
    expect(result.status).toBe('pending');
    expect(result.gatewayChargeId).toBe('ch_test_67890');
    expect(result.amount).toEqual({ amount: 9_900, currency: 'BRL' });
    expect(result.pixQrCode).toContain('00020126');
    expect(result.pixExpiresAt?.toISOString()).toBe('2026-05-19T20:00:00.000Z');
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
      new Response(JSON.stringify({ message: 'invalid token' }), { status: 401 }),
    );
    await expect(adapter.createPix(CREDENTIALS, pixInput())).rejects.toMatchObject({
      declineCode: 'AUTH_FAILED',
      gatewayId: 'pagarme',
    });
  });
});

describe('PagarmeAdapter.verifyWebhook', () => {
  const adapter = new PagarmeAdapter();

  function basicAuth(password: string): string {
    return `Basic ${Buffer.from(`webhook:${password}`).toString('base64')}`;
  }

  function req(authPassword: string): WebhookRequest {
    return {
      rawBody: JSON.stringify({
        id: 'hk_evt_1',
        type: 'order.paid',
        data: { id: 'or_test_12345', charges: [{ id: 'ch_test_67890' }] },
      }),
      headers: { authorization: authPassword },
      queryParams: {},
    };
  }

  it('accepts a request whose Basic password matches webhookEndpointSecret', () => {
    const secret = CREDENTIALS.webhookEndpointSecret ?? '';
    const event = adapter.verifyWebhook(CREDENTIALS, req(basicAuth(secret)));
    expect(event.gatewayId).toBe('pagarme');
    expect(event.eventType).toBe('order.paid');
  });

  it('rejects a request with the wrong Basic password', () => {
    expect(() =>
      adapter.verifyWebhook(CREDENTIALS, req(basicAuth('different-secret-1234567890'))),
    ).toThrowError(PayunivercartError);
  });

  it('refuses to verify when no webhookEndpointSecret is set', () => {
    const credsNoSecret: PagarmeCredentials = { ...CREDENTIALS, webhookEndpointSecret: undefined };
    expect(() =>
      adapter.verifyWebhook(credsNoSecret, req(basicAuth('whatever-1234567890'))),
    ).toThrow(PaymentError);
  });
});
