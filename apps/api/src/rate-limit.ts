/**
 * Rate limiting middleware for sensitive surfaces.
 *
 * Three tiers, scoped by IP address (extracted from `X-Forwarded-For`
 * when behind Traefik / nginx, else the raw socket address). Counters
 * live in Redis so multiple api containers share state — no risk of a
 * caller dodging the cap by hitting a different replica.
 *
 * Tiers:
 *   - auth (10 req/min)  — `/api/auth/*` brute-force protection.
 *     Defends against credential stuffing, OTP spam, signup enumeration.
 *   - webhook (200 req/min) — `/webhooks/gateway/*` and `/webhooks/waha`.
 *     Gateways legitimately retry on 5xx so the cap is generous; goal
 *     is to absorb a misbehaving sender, not to throttle real traffic.
 *   - checkout (60 req/min) — `/trpc/checkout.*` publicProcedures.
 *     One human can plausibly create a few orders a minute; a bot
 *     trying to mass-create pending_payment rows cannot.
 *
 * Falls back to no-op limiter when Redis is unreachable. Failing open
 * is the deliberate choice — we'd rather serve a customer over an
 * unprotected limiter than 503 every request because the limiter store
 * is down. Sentry breadcrumb captures the failure so we know.
 */

import * as Sentry from '@sentry/node';
import type { MiddlewareHandler } from 'hono';
import type { Context } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { Redis } from 'ioredis';
import { RedisStore } from 'rate-limit-redis';

let redisSingleton: Redis | null = null;

function getRedis(redisUrl: string): Redis {
  if (redisSingleton) return redisSingleton;
  redisSingleton = new Redis(redisUrl, {
    // `enableOfflineQueue: true` (default) is REQUIRED here. The
    // `rate-limit-redis` store calls `loadIncrementScript` (EVAL) the
    // moment the limiter factory runs — which is at boot, before the
    // TCP handshake to Redis completes. With offline queue OFF, that
    // first command rejects immediately and the rejection escapes as
    // an unhandled promise → process crash → Coolify restart loop.
    // With offline queue ON, ioredis buffers the EVAL until the
    // connection is ready (typically <100ms) then flushes it.
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    // Cap reconnect storms — if Redis is genuinely down, back off
    // exponentially up to 5s between attempts instead of hammering.
    retryStrategy(times) {
      return Math.min(times * 200, 5000);
    },
  });
  redisSingleton.on('error', (err) => {
    Sentry.captureException(err, { tags: { component: 'rate-limit', store: 'redis' } });
  });
  return redisSingleton;
}

function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) {
    // First entry is the original client; subsequent entries are proxies.
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return (c.req.header('x-real-ip') ?? 'unknown').trim();
}

interface LimiterArgs {
  redisUrl: string;
  windowMs: number;
  limit: number;
  prefix: string;
}

function makeLimiter({ redisUrl, windowMs, limit, prefix }: LimiterArgs): MiddlewareHandler {
  try {
    const redis = getRedis(redisUrl);
    // `rate-limit-redis` and `hono-rate-limiter` ship slightly
    // mismatched Store interfaces (the former targets the express
    // limiter contract). The runtime behaviour is identical — we
    // bridge the types via `unknown`. The sendCommand bridge below is
    // also typed loosely because `ioredis.call` accepts varargs but
    // its type uses overloads that don't narrow through the spread.
    const store = new RedisStore({
      sendCommand: ((...args: string[]) =>
        (redis as unknown as { call: (...a: string[]) => Promise<unknown> }).call(
          ...args,
        )) as never,
      prefix: `ratelimit:${prefix}:`,
    });
    return rateLimiter({
      windowMs,
      limit,
      keyGenerator: clientIp,
      store: store as unknown as never,
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { component: 'rate-limit', stage: 'init' } });
    // Memory fallback: per-process counter. Imperfect (each replica
    // gets its own cap) but better than nothing while Redis is dead.
    return rateLimiter({
      windowMs,
      limit,
      keyGenerator: clientIp,
    });
  }
}

export function authRateLimit(redisUrl: string) {
  return makeLimiter({ redisUrl, windowMs: 60_000, limit: 10, prefix: 'auth' });
}

export function webhookRateLimit(redisUrl: string) {
  return makeLimiter({ redisUrl, windowMs: 60_000, limit: 200, prefix: 'webhook' });
}

export function checkoutRateLimit(redisUrl: string) {
  return makeLimiter({ redisUrl, windowMs: 60_000, limit: 60, prefix: 'checkout' });
}
