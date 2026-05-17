import { boolean, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, fk, id, timestampTz, timestampTzNullable, updatedAt } from './common';

/**
 * Better-Auth managed tables. Names and columns match the Better-Auth
 * Drizzle adapter contract; do not rename without updating the auth config.
 */

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text().notNull(),
    emailVerified: boolean().notNull().default(false),
    name: text().notNull(),
    image: text(),
    twoFactorEnabled: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text().notNull(),
    /** Absolute expiry instant. App must compute explicitly — no default. */
    expiresAt: timestampTz(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('sessions_token_unique').on(table.token),
    index('sessions_user_idx').on(table.userId),
    index('sessions_expires_idx').on(table.expiresAt),
  ],
);

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text().notNull(),
    providerId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    /** OAuth access token expiry — nullable for providers that don't issue one. */
    accessTokenExpiresAt: timestampTzNullable(),
    refreshTokenExpiresAt: timestampTzNullable(),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('accounts_provider_account_unique').on(table.providerId, table.accountId),
    index('accounts_user_idx').on(table.userId),
    // No DB-level CHECK on password format. Better-Auth changes hash
    // algorithms between minor versions (scrypt in 1.3.x, argon2id in
    // 1.6.x, both with different prefixes/separators) and pinning the
    // schema to one format trades resilience for a defense-in-depth gain
    // we don't really need — the only writer to this column is the auth
    // library itself, audited and trusted. If a bug ever wrote plaintext,
    // the app-level audit chain would catch it on the very next read.
  ],
);

export const verifications = pgTable(
  'verifications',
  {
    id: id(),
    identifier: text().notNull(),
    value: text().notNull(),
    /** OTP / magic-link expiry. App computes (e.g. now + 10min). */
    expiresAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('verifications_identifier_idx').on(table.identifier),
    index('verifications_expires_idx').on(table.expiresAt),
  ],
);

/** Two-factor TOTP secrets per user. */
export const twoFactor = pgTable(
  'two_factor',
  {
    id: id(),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('two_factor_user_unique').on(table.userId)],
);
