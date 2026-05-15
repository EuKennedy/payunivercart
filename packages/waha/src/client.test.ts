import { PayunivercartError } from '@payunivercart/shared';
import { describe, expect, it, vi } from 'vitest';
import { WahaClient } from './client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function build(
  fetchImpl: typeof fetch,
  overrides?: Partial<ConstructorParameters<typeof WahaClient>[0]>,
) {
  return new WahaClient({
    baseUrl: 'http://waha.test',
    apiKey: 'test-key',
    defaultSession: 'tenant-1',
    fetchImpl,
    ...overrides,
  });
}

describe('WahaClient constructor — URL validation', () => {
  it('accepts http://', () => {
    expect(() => build(vi.fn() as unknown as typeof fetch)).not.toThrow();
  });

  it('accepts https://', () => {
    expect(() =>
      build(vi.fn() as unknown as typeof fetch, { baseUrl: 'https://waha.example.com' }),
    ).not.toThrow();
  });

  it('rejects file:// (SSRF)', () => {
    expect(() =>
      build(vi.fn() as unknown as typeof fetch, { baseUrl: 'file:///etc/passwd' }),
    ).toThrowError(PayunivercartError);
  });

  it('rejects gopher:// (SSRF)', () => {
    expect(() =>
      build(vi.fn() as unknown as typeof fetch, { baseUrl: 'gopher://example.com/' }),
    ).toThrowError(PayunivercartError);
  });

  it('rejects an unparseable URL', () => {
    expect(() => build(vi.fn() as unknown as typeof fetch, { baseUrl: 'not-a-url' })).toThrowError(
      PayunivercartError,
    );
  });

  it('rejects an empty baseUrl', () => {
    expect(() => build(vi.fn() as unknown as typeof fetch, { baseUrl: '' })).toThrowError(
      PayunivercartError,
    );
  });

  it('strips trailing slashes', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ numberExists: true, chatId: '1@c.us' }));
    const client = build(fetchMock as unknown as typeof fetch, {
      baseUrl: 'http://waha.test/////',
    });
    await client.checkExists('123');
    const calledUrl = fetchMock.mock.calls[0]?.[0];
    expect(typeof calledUrl).toBe('string');
    expect(calledUrl).toMatch(/^http:\/\/waha\.test\/api\//);
    expect(calledUrl).not.toMatch(/waha\.test\/\//);
  });
});

describe('WahaClient request — HTTP error mapping', () => {
  it('maps 401 to GATEWAY_INVALID_CREDENTIALS / httpStatus 401', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 }));
    const client = build(fetchMock as unknown as typeof fetch);
    try {
      await client.checkExists('123');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PayunivercartError);
      expect((err as PayunivercartError).code).toBe('GATEWAY_INVALID_CREDENTIALS');
      expect((err as PayunivercartError).httpStatus).toBe(401);
    }
  });

  it('maps 403 to GATEWAY_INVALID_CREDENTIALS', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const client = build(fetchMock as unknown as typeof fetch);
    await expect(client.checkExists('123')).rejects.toMatchObject({
      code: 'GATEWAY_INVALID_CREDENTIALS',
    });
  });

  it('maps 422 (caller bug) to GATEWAY_ERROR / httpStatus 400 / retryable false', async () => {
    const fetchMock = vi.fn(async () => new Response('bad input', { status: 422 }));
    const client = build(fetchMock as unknown as typeof fetch);
    try {
      await client.checkExists('123');
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as PayunivercartError;
      expect(e.code).toBe('GATEWAY_ERROR');
      expect(e.httpStatus).toBe(400);
      expect((e.details as { retryable?: boolean }).retryable).toBe(false);
    }
  });

  it('maps 429 (rate limit) to GATEWAY_UNAVAILABLE / 503 / retryable true', async () => {
    const fetchMock = vi.fn(async () => new Response('slow down', { status: 429 }));
    const client = build(fetchMock as unknown as typeof fetch);
    try {
      await client.checkExists('123');
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as PayunivercartError;
      expect(e.code).toBe('GATEWAY_UNAVAILABLE');
      expect(e.httpStatus).toBe(503);
      expect((e.details as { retryable?: boolean }).retryable).toBe(true);
    }
  });

  it('maps 503 to GATEWAY_UNAVAILABLE / 503 / retryable true', async () => {
    const fetchMock = vi.fn(async () => new Response('outage', { status: 503 }));
    const client = build(fetchMock as unknown as typeof fetch);
    await expect(client.checkExists('123')).rejects.toMatchObject({
      code: 'GATEWAY_UNAVAILABLE',
      httpStatus: 503,
    });
  });
});

describe('WahaClient — connection failure', () => {
  it('wraps a fetch rejection in GATEWAY_UNAVAILABLE / 503', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = build(fetchMock as unknown as typeof fetch);
    try {
      await client.checkExists('123');
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as PayunivercartError;
      expect(e.code).toBe('GATEWAY_UNAVAILABLE');
      expect(e.httpStatus).toBe(503);
    }
  });

  // Note: a real timeout integration test would have to wait the per-method
  // default (5s+) and is left to the integration suite. The constructor
  // `timeoutMs` is currently only consulted as a fallback for callers that
  // do not pass a per-call value; every public method passes one. See
  // TIMEOUTS_MS in client.ts.
});
