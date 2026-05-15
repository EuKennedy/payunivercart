import { createHmac } from 'node:crypto';
import { PayunivercartError } from '@payunivercart/shared';
import { describe, expect, it } from 'vitest';
import { WAHA_EVENT } from './types.js';
import { verifyWahaWebhook } from './webhook.js';

const SECRET = 'super-secret-waha-token';
const FIXED_NOW = new Date('2026-05-15T12:00:00Z');
const fixedNowFn = () => FIXED_NOW;
const nowSeconds = Math.floor(FIXED_NOW.getTime() / 1000);

function makeBody(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function sign(rawBody: string, secret = SECRET): string {
  return createHmac('sha512', secret).update(rawBody, 'utf8').digest('hex');
}

const baseMessage = {
  event: WAHA_EVENT.MESSAGE,
  session: 'tenant-1',
  timestamp: nowSeconds,
  payload: {
    id: 'msg_1',
    from: '5531984956383@c.us',
    body: 'hello',
    fromMe: false,
  },
};

describe('verifyWahaWebhook — happy path', () => {
  it('verifies a valid signature and returns the typed payload', () => {
    const body = makeBody(baseMessage);
    const result = verifyWahaWebhook({
      rawBody: body,
      signature: sign(body),
      secret: SECRET,
      now: fixedNowFn,
    });
    expect(result.event).toBe('message');
    expect(result.session).toBe('tenant-1');
  });

  it('accepts UPPERCASE signature header (WAHA upgrade compat)', () => {
    const body = makeBody(baseMessage);
    const result = verifyWahaWebhook({
      rawBody: body,
      signature: sign(body).toUpperCase(),
      secret: SECRET,
      now: fixedNowFn,
    });
    expect(result.event).toBe('message');
  });

  it('trims whitespace around the signature', () => {
    const body = makeBody(baseMessage);
    const result = verifyWahaWebhook({
      rawBody: body,
      signature: `  ${sign(body)}  `,
      secret: SECRET,
      now: fixedNowFn,
    });
    expect(result.session).toBe('tenant-1');
  });

  it('discriminates a message.ack event payload', () => {
    const payload = {
      event: WAHA_EVENT.MESSAGE_ACK,
      session: 'tenant-1',
      timestamp: nowSeconds,
      payload: { id: 'msg_1', ack: 3, ackName: 'read' },
    };
    const body = makeBody(payload);
    const result = verifyWahaWebhook({
      rawBody: body,
      signature: sign(body),
      secret: SECRET,
      now: fixedNowFn,
    });
    expect(result.event).toBe('message.ack');
    if (result.event === 'message.ack') {
      expect(result.payload.ack).toBe(3);
    }
  });

  it('passes an unknown event through as `unknown` variant', () => {
    const payload = {
      event: 'group.join',
      session: 'tenant-1',
      timestamp: nowSeconds,
      payload: { foo: 'bar' },
    };
    const body = makeBody(payload);
    const result = verifyWahaWebhook({
      rawBody: body,
      signature: sign(body),
      secret: SECRET,
      now: fixedNowFn,
    });
    expect(result.event).toBe('group.join');
  });
});

describe('verifyWahaWebhook — signature errors', () => {
  it('rejects an empty signature', () => {
    const body = makeBody(baseMessage);
    expect(() =>
      verifyWahaWebhook({ rawBody: body, signature: '', secret: SECRET, now: fixedNowFn }),
    ).toThrowError(PayunivercartError);
  });

  it('rejects a signature shorter than 128 hex chars', () => {
    const body = makeBody(baseMessage);
    expect(() =>
      verifyWahaWebhook({ rawBody: body, signature: 'abcd', secret: SECRET, now: fixedNowFn }),
    ).toThrow(/128/);
  });

  it('rejects a signature with non-hex characters', () => {
    const body = makeBody(baseMessage);
    const bad = `${'z'.repeat(128)}`;
    expect(() =>
      verifyWahaWebhook({ rawBody: body, signature: bad, secret: SECRET, now: fixedNowFn }),
    ).toThrow(/hex/);
  });

  it('rejects a signature signed with the wrong secret', () => {
    const body = makeBody(baseMessage);
    expect(() =>
      verifyWahaWebhook({
        rawBody: body,
        signature: sign(body, 'wrong-secret'),
        secret: SECRET,
        now: fixedNowFn,
      }),
    ).toThrow(/mismatch/);
  });
});

describe('verifyWahaWebhook — anti-replay window', () => {
  it('rejects a webhook with timestamp 6 minutes in the past', () => {
    const old = { ...baseMessage, timestamp: nowSeconds - 360 };
    const body = makeBody(old);
    expect(() =>
      verifyWahaWebhook({ rawBody: body, signature: sign(body), secret: SECRET, now: fixedNowFn }),
    ).toThrow(/window/);
  });

  it('rejects a webhook with timestamp 6 minutes in the future', () => {
    const future = { ...baseMessage, timestamp: nowSeconds + 360 };
    const body = makeBody(future);
    expect(() =>
      verifyWahaWebhook({ rawBody: body, signature: sign(body), secret: SECRET, now: fixedNowFn }),
    ).toThrow(/window/);
  });

  it('accepts a webhook within the default 5-minute window', () => {
    const edge = { ...baseMessage, timestamp: nowSeconds - 250 };
    const body = makeBody(edge);
    const result = verifyWahaWebhook({
      rawBody: body,
      signature: sign(body),
      secret: SECRET,
      now: fixedNowFn,
    });
    expect(result.session).toBe('tenant-1');
  });

  it('honors a custom skewSeconds override', () => {
    const distant = { ...baseMessage, timestamp: nowSeconds - 1000 };
    const body = makeBody(distant);
    const result = verifyWahaWebhook({
      rawBody: body,
      signature: sign(body),
      secret: SECRET,
      skewSeconds: 2000,
      now: fixedNowFn,
    });
    expect(result.session).toBe('tenant-1');
  });
});

describe('verifyWahaWebhook — body parsing', () => {
  it('throws VALIDATION on invalid JSON', () => {
    const body = '{ not json';
    // Note: signature is computed over the (invalid) body so it passes HMAC.
    expect(() =>
      verifyWahaWebhook({ rawBody: body, signature: sign(body), secret: SECRET, now: fixedNowFn }),
    ).toThrow(/JSON/);
  });

  it('throws VALIDATION on schema-mismatched payload (missing session)', () => {
    const malformed = { event: 'message', timestamp: nowSeconds, payload: {} };
    const body = makeBody(malformed);
    expect(() =>
      verifyWahaWebhook({ rawBody: body, signature: sign(body), secret: SECRET, now: fixedNowFn }),
    ).toThrow(/schema/);
  });
});
