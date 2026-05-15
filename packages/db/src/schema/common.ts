import { sql } from 'drizzle-orm';
import { pgEnum, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Re-usable column helpers so every table follows the same conventions:
 *   - UUID v4 primary keys
 *   - timestamptz with millisecond precision
 *   - Soft-delete via `deleted_at` on tables that need it
 */

export const id = () => uuid().primaryKey().defaultRandom();
export const fk = () => uuid();

export const createdAt = () =>
  timestamp({ mode: 'date', withTimezone: true, precision: 3 }).notNull().default(sql`now()`);

/**
 * `updatedAt` defaults to `now()` on insert AND auto-refreshes on every
 * Drizzle-driven UPDATE via `$onUpdate`. Direct SQL `UPDATE` statements need
 * a Postgres trigger; rely on the ORM for the common path and a trigger for
 * any future direct DML.
 */
export const updatedAt = () =>
  timestamp({ mode: 'date', withTimezone: true, precision: 3 })
    .notNull()
    .default(sql`now()`)
    .$onUpdate(() => new Date());

export const deletedAt = () => timestamp({ mode: 'date', withTimezone: true, precision: 3 });

/**
 * Required timestamptz column with NO default. Use this for fields like
 * `expiresAt`, `accessTokenExpiresAt`, `dueDate`, etc. — values the app must
 * compute explicitly. Using `createdAt()` for these creates rows that are
 * born already expired.
 */
export const timestampTz = () =>
  timestamp({ mode: 'date', withTimezone: true, precision: 3 }).notNull();

/**
 * Optional timestamptz column with no default. Use for event-occurrence
 * timestamps that are NULL until the event happens (e.g. `paid_at`,
 * `cancelled_at`, `sent_at`, `processed_at`). Never use `createdAt()` for
 * these — it sets `now()` and the row reads as if the event already fired.
 */
export const timestampTzNullable = () =>
  timestamp({ mode: 'date', withTimezone: true, precision: 3 });

/** Currency ISO 4217. */
export const currencyEnum = pgEnum('currency', ['BRL', 'USD', 'EUR']);

export const gatewayIdEnum = pgEnum('gateway_id', [
  'mercadopago',
  'pagarme',
  'pagseguro',
  'stripe',
]);

export const paymentMethodEnum = pgEnum('payment_method', [
  'pix',
  'credit_card',
  'boleto',
  'stripe_card_usd',
]);

export const transactionStatusEnum = pgEnum('transaction_status', [
  'pending',
  'processing',
  'authorized',
  'paid',
  'refunded',
  'partially_refunded',
  'chargedback',
  'failed',
  'cancelled',
  'expired',
]);

export const orderStatusEnum = pgEnum('order_status', [
  'draft',
  'pending_payment',
  'paid',
  'partially_refunded',
  'refunded',
  'cancelled',
  'expired',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'past_due',
  'cancelled',
  'paused',
  'trialing',
]);

export const localeEnum = pgEnum('locale', ['pt-BR', 'en', 'es']);

export const memberRoleEnum = pgEnum('member_role', ['owner', 'admin', 'editor', 'viewer']);

export const productTypeEnum = pgEnum('product_type', [
  'one_time',
  'subscription',
  'course',
  'physical',
]);
