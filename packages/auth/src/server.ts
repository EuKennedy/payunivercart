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
 *   - Email + password (argon2id, enforced at DB level by a CHECK
 *     constraint from Bloco 2).
 *   - Second factor / passwordless: email OTP, with WhatsApp OTP added
 *     side-by-side using the same code generator. Producer picks the
 *     channel at the login screen.
 *
 * The Drizzle adapter binds to the existing tables in
 * `@payunivercart/db`: `users`, `sessions`, `accounts`, `verifications`,
 * `two_factor`. No schema migration is needed at this point — Bloco 2
 * already declared every column Better-Auth expects.
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
    emailAndPassword: {
      enabled: true,
      // The DB-level CHECK on accounts.password (`LIKE '$argon2id$%'`)
      // requires Better-Auth's default argon2id hasher; do NOT swap to
      // bcrypt or pbkdf2 here without dropping the CHECK first.
      autoSignIn: false,
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
