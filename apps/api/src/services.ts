import type { AuditService } from '@payunivercart/audit';
import { type Auth, createAuth } from '@payunivercart/auth';
import { CryptoService, loadKeyRegistryFromEnv } from '@payunivercart/crypto';
import { createDatabaseClient } from '@payunivercart/db';
import { WahaClient } from '@payunivercart/waha';
import type { AppEnv } from './env';

/**
 * Long-lived process-wide services. Built once at boot and handed to
 * request-scoped tRPC contexts via `c.set('services', ...)`. None of the
 * services hold mutable state that needs request isolation.
 *
 * AuditService is constructed with a placeholder port for now — the real
 * Drizzle-backed port lands when the first DB-touching endpoint does
 * (next sub-block); until then the audit service has nothing to write
 * against and must NOT be invoked.
 */
export interface AppServices {
  env: AppEnv;
  db: ReturnType<typeof createDatabaseClient>;
  crypto: CryptoService;
  waha: WahaClient;
  auth: Auth;
  /**
   * AuditService is created lazily once the production Drizzle port is
   * wired. Calling `services.audit()` before that throws so misuse is
   * loud during development.
   */
  audit: () => AuditService;
}

export function buildServices(env: AppEnv): AppServices {
  const db = createDatabaseClient({
    connectionString: env.DATABASE_URL,
    ssl: env.NODE_ENV === 'production',
  });

  const encryptionRegistry = loadKeyRegistryFromEnv({
    keysEnv: env.ENCRYPTION_KEYS,
    activeKeyIdEnv: env.ENCRYPTION_ACTIVE_KEY_ID,
    envVarName: 'ENCRYPTION_KEYS',
  });
  const crypto = new CryptoService(encryptionRegistry);

  const waha = new WahaClient({
    baseUrl: env.WAHA_BASE_URL,
    apiKey: env.WAHA_API_KEY,
    defaultSession: env.WAHA_DEFAULT_SESSION,
  });

  // Better-Auth's `baseURL` is the absolute origin of THIS api service.
  // Use `API_PUBLIC_URL` when set (production: `https://api.univercart.com`);
  // fall back to the first trusted origin (single-host dev with the api
  // behind the same nginx as the dashboard) and finally to localhost.
  const apiBase = (
    env.API_PUBLIC_URL ??
    env.AUTH_TRUSTED_ORIGINS[0] ??
    'http://localhost:4000'
  ).replace(/\/$/, '');

  const auth = createAuth({
    db: db.db,
    secret: env.AUTH_SECRET,
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    baseURL: `${apiBase}/api/auth`,
    waha,
    wahaSessionName: env.WAHA_DEFAULT_SESSION,
    emailSender: {
      async sendEmailOtp({ to, code }) {
        // Real Resend integration lands with `packages/emails`. Until then
        // we log a structured event the operator can pick up from stdout
        // so local dev still works end-to-end.
        process.stdout.write(
          `${JSON.stringify({
            level: 'info',
            event: 'auth.emailOtp.pending',
            to,
            code,
          })}\n`,
        );
      },
    },
  });

  return {
    env,
    db,
    crypto,
    waha,
    auth,
    audit: () => {
      throw new Error(
        'AuditService not yet wired to the Drizzle port; will land with the first DB-writing endpoint.',
      );
    },
  };
}
