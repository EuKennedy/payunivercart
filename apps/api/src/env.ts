import { PayunivercartError } from '@payunivercart/shared';
import { z } from 'zod';

/**
 * Boot-time environment validation. Refuses to start the API if ANY required
 * env value still contains the `__REPLACE_ME__` placeholder marker from
 * `.env.example`. This prevents the most common "deploy with default
 * password" mistake.
 *
 * Every value is parsed by zod so we fail loudly with a precise error
 * naming the variable, not with a cryptic runtime crash three frames deep.
 */

const PLACEHOLDER_MARKER = '__REPLACE_ME__';

function noPlaceholder(name: string) {
  return (value: string) => {
    if (value.includes(PLACEHOLDER_MARKER)) {
      throw new Error(
        `Environment variable ${name} still contains "${PLACEHOLDER_MARKER}". Copy .env.example and replace every placeholder before booting.`,
      );
    }
    return value;
  };
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  /** Postgres connection string. Used by Drizzle. */
  DATABASE_URL: z
    .string()
    .url({ message: 'DATABASE_URL must be a valid URL' })
    .transform(noPlaceholder('DATABASE_URL')),

  /** Redis connection string (BullMQ + caches). */
  REDIS_URL: z.string().url().transform(noPlaceholder('REDIS_URL')),

  /** Better-Auth signing secret — must be high-entropy hex. */
  AUTH_SECRET: z
    .string()
    .min(64, { message: 'AUTH_SECRET must be at least 64 hex chars (`openssl rand -hex 32`).' })
    .transform(noPlaceholder('AUTH_SECRET')),

  AUTH_TRUSTED_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  /**
   * Public URL this api is reachable at (the domain Coolify maps the
   * `api` service to). Used by Better-Auth to construct absolute
   * callback URLs (e.g. password-reset links). Fallback uses
   * `AUTH_TRUSTED_ORIGINS[0]` for backward-compat with single-host dev.
   */
  API_PUBLIC_URL: z.string().url().optional(),

  /** WAHA. */
  WAHA_BASE_URL: z.string().url().transform(noPlaceholder('WAHA_BASE_URL')),
  WAHA_API_KEY: z.string().min(8).transform(noPlaceholder('WAHA_API_KEY')),
  WAHA_DEFAULT_SESSION: z.string().min(1).default('default'),
  WAHA_WEBHOOK_SECRET: z.string().min(16).transform(noPlaceholder('WAHA_WEBHOOK_SECRET')),

  /** Crypto KEK registry: `<keyId>:<b64>[,...]` (see packages/crypto/registry.ts) */
  ENCRYPTION_KEYS: z.string().min(1).transform(noPlaceholder('ENCRYPTION_KEYS')),
  ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1).optional(),

  /** Audit chain HMAC keys — independent from ENCRYPTION_KEYS. */
  AUDIT_KEYS: z.string().min(1).transform(noPlaceholder('AUDIT_KEYS')),
  AUDIT_ACTIVE_KEY_ID: z.string().min(1).optional(),

  /** Resend (transactional email). Optional in dev. */
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | undefined;

/**
 * Read + validate the process environment. Exits the process with a
 * structured error message on validation failure so misconfiguration
 * cannot reach the request path.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (cached) return cached;
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new PayunivercartError({
      code: 'INTERNAL',
      message: `Invalid environment configuration:\n${issues}`,
      details: { issues: result.error.issues },
    });
  }
  cached = result.data;
  return cached;
}

/** Reset the memoized env. Tests only. */
export function __resetEnvForTests(): void {
  cached = undefined;
}
