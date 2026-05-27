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

  /**
   * Allowed origins for CORS + Better-Auth trust. Comma-separated.
   * Each value MUST be a fully-qualified origin (`https://host[:port]`
   * or `http://host[:port]`). No wildcards, no trailing paths — they
   * would silently turn into "match anything" once Hono's CORS
   * normaliser strips them. The regex below is conservative: scheme +
   * hostname (letters, digits, dots, hyphens) + optional port.
   */
  AUTH_TRUSTED_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value, ctx) => {
      const origins = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const ORIGIN_REGEX = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;
      for (const origin of origins) {
        if (!ORIGIN_REGEX.test(origin)) {
          ctx.addIssue({
            code: 'custom',
            message: `Invalid origin in AUTH_TRUSTED_ORIGINS: "${origin}". Expected "https://host" or "http://host[:port]" — no wildcards, no paths.`,
          });
          return z.NEVER;
        }
        if (origin === '*' || origin.includes('*')) {
          ctx.addIssue({
            code: 'custom',
            message: 'AUTH_TRUSTED_ORIGINS cannot contain wildcards.',
          });
          return z.NEVER;
        }
      }
      return origins;
    }),

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

  /** Sentry DSN. When empty, Sentry init is a no-op. */
  SENTRY_DSN: z.string().optional(),
  /** Service name surfaced as the Sentry `serverName`. Useful when api +
   * workers share one project. */
  SENTRY_RELEASE: z.string().optional(),

  /**
   * Comma-separated list of emails authorised to use the super-admin
   * surface (`apps/admin`). Validated against the Better-Auth session
   * email by `superuserProcedure`. Empty list = the admin router
   * refuses every request — safe default until the operator wires the
   * first internal account.
   */
  ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),

  /**
   * Univercart Connect — public base URL of THIS api (Connect endpoints
   * live at `${CONNECT_API_BASE}/v1/...`). Falls back to API_PUBLIC_URL
   * when unset so single-host dev keeps working.
   */
  CONNECT_API_BASE: z.string().url().optional(),

  /**
   * Univercart Connect — public base URL of the checkout app, used to
   * mint magic links (`${CHECKOUT_PUBLIC_URL}/connect/setup?t=<JWT>`).
   * If your partner exposes its own setup page, override via the
   * partner's webhook handler — this is only the default landing page.
   */
  CHECKOUT_PUBLIC_URL: z.string().url().optional(),

  /**
   * Run drizzle migrations on API boot, before the HTTP server starts
   * listening. Defends against the Coolify pitfall where the compose
   * `migrate` one-shot is skipped between deploys because it's already
   * "completed", leaving the schema behind the app code and 500-ing every
   * SELECT that references a new column.
   *
   * Drizzle's migrator records applied migrations in `__drizzle_migrations`,
   * so running it on every boot is idempotent and cheap (one round-trip
   * to read the journal, zero writes when already up to date).
   *
   * Default: `true` (always on). Set `RUN_MIGRATIONS_ON_BOOT=false` to
   * opt out — e.g. when a separate CI job owns the migrate step and you
   * want the API container to refuse to start instead of healing the gap.
   */
  RUN_MIGRATIONS_ON_BOOT: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
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
