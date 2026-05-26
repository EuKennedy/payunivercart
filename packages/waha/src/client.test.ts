import { PayunivercartError } from '@payunivercart/shared';
import { describe, expect, it, vi } from 'vitest';
import { WahaClient, isRetryableError } from './client';

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

describe('isRetryableError', () => {
  it('flags GATEWAY_UNAVAILABLE as retryable (network / 5xx / timeout)', () => {
    const err = new PayunivercartError({
      code: 'GATEWAY_UNAVAILABLE',
      message: 'upstream down',
    });
    expect(isRetryableError(err)).toBe(true);
  });

  it('flags 5xx-derived errors with details.retryable=true', () => {
    expect(isRetryableError({ code: 'GATEWAY_ERROR', details: { retryable: true } })).toBe(true);
  });

  it('rejects 4xx errors (non-retryable by contract)', () => {
    expect(isRetryableError({ code: 'GATEWAY_ERROR', details: { retryable: false } })).toBe(false);
  });

  it('rejects unrelated objects', () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
    expect(isRetryableError('boom')).toBe(false);
    expect(isRetryableError({})).toBe(false);
  });
});

describe('WahaClient.sendTextWithRetry', () => {
  // Lock the placeholder timer to make the backoff sleeps instant.
  // Real-time backoff (500ms + 2s + 8s) would balloon the test suite.
  const noSleep = () =>
    vi.stubGlobal('setTimeout', (fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

  it('returns on the first successful attempt without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 'msg-1' }, 200));
    const client = build(fetchImpl as unknown as typeof fetch);
    await client.sendTextWithRetry({
      session: 's',
      chatId: '5511999999999@c.us',
      text: 'oi',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxAttempts on transient 503, then succeeds', async () => {
    noSleep();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503))
      .mockResolvedValueOnce(jsonResponse({ id: 'msg-1' }, 200));
    const client = build(fetchImpl as unknown as typeof fetch);
    await client.sendTextWithRetry(
      { session: 's', chatId: '5511999999999@c.us', text: 'oi' },
      { maxAttempts: 3 },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('bubbles a 4xx non-retryable error on the first failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'bad chatId' }, 422));
    const client = build(fetchImpl as unknown as typeof fetch);
    await expect(
      client.sendTextWithRetry({
        session: 's',
        chatId: '5511999999999@c.us',
        text: 'oi',
      }),
    ).rejects.toThrow(PayunivercartError);
    // 4xx should NOT consume the retry budget.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts even when every response is transient', async () => {
    noSleep();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    const client = build(fetchImpl as unknown as typeof fetch);
    await expect(
      client.sendTextWithRetry(
        { session: 's', chatId: '5511999999999@c.us', text: 'oi' },
        { maxAttempts: 3 },
      ),
    ).rejects.toThrow(PayunivercartError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it('invokes onAttempt for every retry (not for the success or the final throw)', async () => {
    noSleep();
    const onAttempt = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ id: 'msg-1' }, 200));
    const client = build(fetchImpl as unknown as typeof fetch);
    await client.sendTextWithRetry(
      { session: 's', chatId: '5511999999999@c.us', text: 'oi' },
      { maxAttempts: 3, onAttempt },
    );
    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(onAttempt).toHaveBeenNthCalledWith(1, 1, expect.any(PayunivercartError));
    expect(onAttempt).toHaveBeenNthCalledWith(2, 2, expect.any(PayunivercartError));
    vi.unstubAllGlobals();
  });
});
