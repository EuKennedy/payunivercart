import { schema } from '@payunivercart/db';
import type { WahaChatId, WahaClient } from '@payunivercart/waha';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins/email-otp';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/**
 * Better-Auth server config for payunivercart.
 *
 * Identity model:
 *   - Email + password (scrypt; default Better-Auth hash format).
 *   - Second factor / passwordless: email OTP, with WhatsApp OTP added
 *     side-by-side using the same code generator. Producer picks the
 *     channel at the login screen.
 *
 * The Drizzle adapter binds to the existing tables in
 * `@payunivercart/db`: `users`, `sessions`, `accounts`, `verifications`,
 * `two_factor`. No schema migration is needed at this point — Bloco 2
 * already declared every column Better-Auth expects.
 *
 * Workspace bootstrap:
 *   On every successful user create, we delegate to the caller-supplied
 *   `onUserCreated(...)` to provision the producer's organization +
 *   workspace + owner membership. Better-Auth's `after` hook runs in a
 *   separate transaction from the user insert, so we apply a
 *   compensation pattern: if `onUserCreated` throws, we call
 *   `onUserCreationFailed` to delete the orphan user row. Net effect at
 *   the API boundary: signup either fully succeeds or fully fails, no
 *   half-created accounts to confuse retries.
 *
 * The factory takes the WAHA client as a parameter so the WhatsApp OTP
 * channel can be wired without making this package depend on a process-
 * wide service registry. `apps/api` constructs both at boot and hands
 * the WahaClient in.
 */

export interface AuthServerConfig {
  db: PgDatabase<PgQueryResultHKT, typeof schema>;
  secret: string;
  trustedOrigins: readonly string[];
  baseURL: string;
  waha: WahaClient;
  wahaSessionName: string;
  emailSender: {
    /** Called by Better-Auth when an email OTP needs to be delivered. */
    sendEmailOtp: (input: { to: string; code: string }) => Promise<void>;
  };
  /**
   * Provision the organization + workspace + owner membership for a
   * brand-new user. Runs AFTER Better-Auth has committed the user row.
   * If this throws, the user row is rolled back via
   * `onUserCreationFailed`. Both callbacks are required so a misconfigured
   * caller cannot silently leave half-provisioned accounts behind.
   */
  onUserCreated: (user: { id: string; email: string; name: string }) => Promise<void>;
  /**
   * Compensation: delete the orphan user row when `onUserCreated`
   * throws. Best-effort by design — the caller logs failures but the
   * original error reaches the signup endpoint so the producer gets a
   * coherent message.
   */
  onUserCreationFailed: (userId: string) => Promise<void>;
}

export function createAuth(config: AuthServerConfig) {
  return betterAuth({
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: [...config.trustedOrigins],
    advanced: {
      database: {
        // Every primary key in our schema is a Postgres UUID
        // (`uuid().primaryKey().defaultRandom()`). Better-Auth's default
        // ID generator emits a random alphanumeric string, which Postgres
        // rejects on INSERT with `22P02 string_to_uuid`. Override it to
        // emit RFC 4122 UUIDs so the adapter writes the shape the schema
        // expects.
        generateId: () => crypto.randomUUID(),
      },
    },
    database: drizzleAdapter(config.db, {
      provider: 'pg',
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        twoFactor: schema.twoFactor,
      },
    }),
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            try {
              await config.onUserCreated({
                id: user.id,
                email: user.email,
                name: user.name,
              });
            } catch (cause) {
              // Compensate: delete the orphan user row. Best-effort —
              // a cleanup failure is logged but the ORIGINAL error is
              // what we surface to the signup endpoint.
              try {
                await config.onUserCreationFailed(user.id);
              } catch (cleanupCause) {
                process.stdout.write(
                  `${JSON.stringify({
                    level: 'error',
                    event: 'auth.userCreated.cleanupFailed',
                    userId: user.id,
                    cleanupError:
                      cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause),
                  })}\n`,
                );
              }
              throw cause;
            }
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      // Sign the user in immediately after sign-up so the dashboard can
      // redirect to /dashboard without an extra login round-trip. Email
      // verification is decoupled (lands when Resend is wired) — until
      // then the producer can use the panel right after creating the
      // workspace.
      autoSignIn: true,
      requireEmailVerification: false,
    },
    session: {
      // 30-day rolling sessions. `freshAge: 0` so every request renews
      // the cookie expiry without forcing an exchange.
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    plugins: [
      emailOTP({
        async sendVerificationOTP({ email, otp }) {
          await config.emailSender.sendEmailOtp({ to: email, code: otp });
        },
        otpLength: 6,
        expiresIn: 60 * 10, // 10 minutes
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/* -------------------------------------------------------------------------- */
/* WhatsApp OTP — sister channel of `emailOTP`                                */
/* -------------------------------------------------------------------------- */

/**
 * Deliver a 6-digit OTP via WAHA. Called by the dashboard's
 * "send code to my WhatsApp" button (separate endpoint, not a
 * Better-Auth plugin — Better-Auth's plugin surface assumes email
 * semantics).
 */
export async function sendWhatsappOtp(opts: {
  waha: WahaClient;
  sessionName: string;
  chatId: WahaChatId;
  code: string;
  productName?: string;
}): Promise<void> {
  const product = opts.productName ?? 'payunivercart';
  const text = [
    `*${product}* — Seu código de acesso:`,
    '',
    `*${opts.code}*`,
    '',
    'Válido por 10 minutos. Se você não solicitou este código, ignore esta mensagem.',
  ].join('\n');
  await opts.waha.sendText({
    session: opts.sessionName,
    chatId: opts.chatId,
    text,
    linkPreview: false,
  });
}
