import { describe, expect, it } from 'vitest';
import { metaAdapter } from './meta';

/**
 * Meta CAPI adapter — credentials parse + event-name mapping locks.
 *
 * Network-level send/test paths are covered by the integration smoke
 * (skipped when META_TEST_TOKEN env is unset). These tests focus on
 * the pure surface: credentials Zod schema + event name mapping.
 */

describe('metaAdapter.parseCredentials', () => {
  it('accepts valid Meta credentials', () => {
    const parsed = metaAdapter.parseCredentials({
      pixelId: '1234567890123456',
      accessToken: 'A'.repeat(80),
    });
    expect(parsed.pixelId).toBe('1234567890123456');
  });

  it('rejects too-short access token', () => {
    expect(() =>
      metaAdapter.parseCredentials({
        pixelId: '1234567890123456',
        accessToken: 'short',
      }),
    ).toThrow();
  });

  it('rejects too-short pixel id', () => {
    expect(() =>
      metaAdapter.parseCredentials({
        pixelId: 'x',
        accessToken: 'A'.repeat(80),
      }),
    ).toThrow();
  });

  it('trims surrounding whitespace', () => {
    const parsed = metaAdapter.parseCredentials({
      pixelId: '  1234567890123456  ',
      accessToken: `   ${'A'.repeat(80)}   `,
      testEventCode: '  TEST123  ',
    });
    expect(parsed.pixelId).toBe('1234567890123456');
    expect(parsed.testEventCode).toBe('TEST123');
  });

  it('accepts optional testEventCode', () => {
    const parsed = metaAdapter.parseCredentials({
      pixelId: '1234567890123456',
      accessToken: 'A'.repeat(80),
      testEventCode: 'TEST12345',
    });
    expect(parsed.testEventCode).toBe('TEST12345');
  });

  it('rejects testEventCode shorter than 3 chars', () => {
    expect(() =>
      metaAdapter.parseCredentials({
        pixelId: '1234567890123456',
        accessToken: 'A'.repeat(80),
        testEventCode: 'TT',
      }),
    ).toThrow();
  });
});

describe('metaAdapter.test (validation probe)', () => {
  // Lock the contract the upsert path depends on: the probe MUST hit
  // Meta with a non-empty user_data (otherwise "Invalid parameter") AND
  // MUST force test_event_code routing when the producer set one
  // (otherwise the probe pollutes production attribution).
  function captureFetch() {
    const calls: { url: string; body: unknown }[] = [];
    const fakeFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? 'null')) });
      return new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'trace-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    return {
      calls,
      restore: () => {
        globalThis.fetch = original;
      },
    };
  }

  it('probe ships with non-empty user_data + test_event_code when set', async () => {
    const { calls, restore } = captureFetch();
    try {
      const result = await metaAdapter.test(
        {
          pixelId: '1234567890123456',
          accessToken: 'A'.repeat(80),
          testEventCode: 'TEST78486',
        },
        { publicPixelId: '1234567890123456', testMode: false },
      );
      expect(result.ok).toBe(true);
      const body = calls[0]?.body as {
        data: { user_data: Record<string, unknown> }[];
        test_event_code?: string;
      };
      expect(body).toBeDefined();
      expect(Object.keys(body.data[0]?.user_data ?? {})).not.toHaveLength(0);
      // testMode forced true → testEventCode passes through.
      expect(body.test_event_code).toBe('TEST78486');
    } finally {
      restore();
    }
  });

  it('probe ships with non-empty user_data even when no testEventCode is set', async () => {
    const { calls, restore } = captureFetch();
    try {
      await metaAdapter.test(
        { pixelId: '1234567890123456', accessToken: 'A'.repeat(80) },
        { publicPixelId: '1234567890123456', testMode: false },
      );
      const body = calls[0]?.body as {
        data: { user_data: Record<string, unknown> }[];
        test_event_code?: string;
      };
      expect(Object.keys(body.data[0]?.user_data ?? {})).not.toHaveLength(0);
      // No testEventCode set → field omitted (undefined serialises out).
      expect(body.test_event_code).toBeUndefined();
    } finally {
      restore();
    }
  });
});
