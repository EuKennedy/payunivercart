import { describe, expect, it } from 'vitest';
import { signWebhookPayload, verifyWebhookPayload } from './webhook-signature';

const secret = 'whsec_AbCdEfGhIjKlMnOpQrStUvWxYz12345678';

describe('webhook signature', () => {
  it('round-trips a fresh signature', () => {
    const body = JSON.stringify({ id: 'evt_xxx', type: 'entitlement.granted' });
    const header = signWebhookPayload({ secret, rawBody: body });
    const result = verifyWebhookPayload({ secret, rawBody: body, header });
    expect(result.ok).toBe(true);
  });

  it('rejects tampered body', () => {
    const body = JSON.stringify({ id: 'evt_xxx' });
    const header = signWebhookPayload({ secret, rawBody: body });
    const tampered = `${body.slice(0, -1)} `;
    const result = verifyWebhookPayload({ secret, rawBody: tampered, header });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects wrong secret', () => {
    const body = JSON.stringify({ id: 'evt_xxx' });
    const header = signWebhookPayload({ secret, rawBody: body });
    const result = verifyWebhookPayload({
      secret: 'whsec_different________________________',
      rawBody: body,
      header,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects stale timestamp', () => {
    const body = JSON.stringify({ id: 'evt_xxx' });
    const tenMinsAgo = Math.floor(Date.now() / 1000) - 600;
    const header = signWebhookPayload({ secret, rawBody: body, timestampSec: tenMinsAgo });
    const result = verifyWebhookPayload({ secret, rawBody: body, header });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('stale_timestamp');
  });

  it('rejects malformed header', () => {
    const body = 'x';
    const result = verifyWebhookPayload({ secret, rawBody: body, header: 'garbage' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });
});
