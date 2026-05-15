import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, timestampTz, timestampTzNullable, updatedAt } from './common.js';

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
    userId: id()
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
    userId: id()
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
    // Defense-in-depth: any non-null password MUST be an argon2id hash, the
    // format Better-Auth emits. A bug that wrote plaintext (or bcrypt, or
    // any other format) is rejected at the DB level rather than silently
    // accepted and only discovered when login starts failing.
    check(
      'accounts_password_argon2id_format',
      sql`password IS NULL OR password LIKE '$argon2id$%'`,
    ),
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
    userId: id()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('two_factor_user_unique').on(table.userId)],
);
