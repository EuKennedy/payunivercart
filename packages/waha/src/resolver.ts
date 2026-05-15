import { PayunivercartError, normalizePhone } from '@payunivercart/shared';
import type { WahaClient } from './client.js';
import type { WahaChatId } from './types.js';

/**
 * Cache port. Implementations: Redis in production, in-memory for tests.
 * Keys are scoped per (session, e164) so different tenants can have different
 * resolutions for the same phone number if they ever do.
 */
export interface ChatIdCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ChatIdResolverOptions {
  client: WahaClient;
  cache: ChatIdCache;
  /** Default 30 days. */
  ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Resolve the WAHA chatId for a phone number, caching the result.
 *
 * The BR pre-2012 quirk (some WhatsApp accounts have chatIds without the
 * "9" digit, regardless of the current dial format) cannot be inferred from
 * the number alone. The only reliable source of truth is WAHA's
 * `check-exists` endpoint.
 */
export class ChatIdResolver {
  private readonly client: WahaClient;
  private readonly cache: ChatIdCache;
  private readonly ttlSeconds: number;

  constructor(options: ChatIdResolverOptions) {
    this.client = options.client;
    this.cache = options.cache;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  /**
   * Resolve a chatId for the given phone input.
   *
   * @throws PayunivercartError('PHONE_INVALID') if the number is unparseable or unknown on WhatsApp.
   */
  async resolve(phoneInput: string, session: string): Promise<WahaChatId> {
    const phone = normalizePhone(phoneInput);
    const cacheKey = makeCacheKey(session, phone.e164);

    const cached = await this.cache.get(cacheKey);
    if (cached !== null) {
      return cached as WahaChatId;
    }

    const response = await this.client.checkExists(phone.digits, session);

    if (!response.numberExists || !response.chatId) {
      throw new PayunivercartError({
        code: 'PHONE_INVALID',
        message: `Phone ${phone.e164} is not a registered WhatsApp number`,
        details: { e164: phone.e164, session },
      });
    }

    await this.cache.set(cacheKey, response.chatId, this.ttlSeconds);
    return response.chatId;
  }

  /** Invalidate a cached resolution (e.g. when WAHA returns "not delivered"). */
  async invalidate(phoneInput: string, session: string): Promise<void> {
    const phone = normalizePhone(phoneInput);
    await this.cache.delete(makeCacheKey(session, phone.e164));
  }
}

function makeCacheKey(session: string, e164: string): string {
  return `waha:chatid:${session}:${e164}`;
}

/** Simple in-memory cache, only suitable for tests and single-process dev runs. */
export class InMemoryChatIdCache implements ChatIdCache {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
