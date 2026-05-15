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
  timestamp({ mode: 'date', withTimezone: true, precision: 3 })
    .notNull()
    .default(sql`now()`);

export const updatedAt = () =>
  timestamp({ mode: 'date', withTimezone: true, precision: 3 })
    .notNull()
    .default(sql`now()`);

export const deletedAt = () =>
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
