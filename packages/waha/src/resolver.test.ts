import { describe, expect, it, vi } from 'vitest';
import { WahaClient } from './client.js';
import { ChatIdResolver, InMemoryChatIdCache } from './resolver.js';

function buildClient(fetchImpl: typeof fetch): WahaClient {
  return new WahaClient({
    baseUrl: 'http://waha.test',
    apiKey: 'test-key',
    defaultSession: 'tenant-1',
    fetchImpl,
    timeoutMs: 1_000,
  });
}

describe('ChatIdResolver', () => {
  it('resolves a BR pre-2012 chatId by calling check-exists (strips the 9)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ numberExists: true, chatId: '553184956383@c.us' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const resolver = new ChatIdResolver({
      client: buildClient(fetchMock as unknown as typeof fetch),
      cache: new InMemoryChatIdCache(),
    });
    const chatId = await resolver.resolve('+5531984956383', 'tenant-1');
    expect(chatId).toBe('553184956383@c.us');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('hits the cache on the second call', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ numberExists: true, chatId: '5531984956383@c.us' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const cache = new InMemoryChatIdCache();
    const resolver = new ChatIdResolver({
      client: buildClient(fetchMock as unknown as typeof fetch),
      cache,
    });
    await resolver.resolve('+5531984956383', 'tenant-1');
    await resolver.resolve('+5531984956383', 'tenant-1');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws PHONE_INVALID when the number is not on WhatsApp', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ numberExists: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const resolver = new ChatIdResolver({
      client: buildClient(fetchMock as unknown as typeof fetch),
      cache: new InMemoryChatIdCache(),
    });
    await expect(resolver.resolve('+5531984956383', 'tenant-1')).rejects.toThrowError(
      /PHONE_INVALID|not a registered/,
    );
  });
});
