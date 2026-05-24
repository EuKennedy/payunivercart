import { sql } from 'drizzle-orm';
import { bigint, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { checkouts } from './checkouts';
import {
  createdAt,
  currencyEnum,
  fk,
  id,
  orderStatusEnum,
  timestampTzNullable,
  updatedAt,
} from './common';
import { productOffers, products } from './products';
import { subscriptions } from './subscriptions';
import { workspaces } from './workspaces';

export const orders = pgTable(
  'orders',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    checkoutId: fk().references(() => checkouts.id, { onDelete: 'set null' }),
    /**
     * When this order is materialised from a subscription cycle (initial
     * activation OR a recurring renewal), points back to the parent
     * subscription. NULL for one-time purchases.
     *
     * `cycleNumber` starts at 1 for the activation charge and increments
     * by 1 on every subsequent recurring charge — lets analytics + the
     * Pedidos UI distinguish "first sale" from "renewal #3".
     */
    subscriptionId: fk().references(() => subscriptions.id, { onDelete: 'set null' }),
    cycleNumber: integer(),
    publicReference: text().notNull(),
    status: orderStatusEnum().notNull().default('draft'),
    customerName: text().notNull(),
    customerEmail: text().notNull(),
    customerDocument: text().notNull(),
    customerPhoneRaw: text().notNull(),
    customerPhoneE164: text().notNull(),
    customerWahaChatId: text(),
    shippingAddress: jsonb(),
    subtotalCents: bigint({ mode: 'bigint' }).notNull().default(sql`0`),
    discountCents: bigint({ mode: 'bigint' }).notNull().default(sql`0`),
    shippingCents: bigint({ mode: 'bigint' }).notNull().default(sql`0`),
    totalCents: bigint({ mode: 'bigint' }).notNull(),
    currency: currencyEnum().notNull().default('BRL'),
    ipAddress: text(),
    userAgent: text(),
    metadata: jsonb().notNull().default({}),
    paidAt: timestampTzNullable(),
    cancelledAt: timestampTzNullable(),
    /** Order-level expiry, distinct from per-transaction Pix/Boleto expiry. */
    expiresAt: timestampTzNullable(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('orders_workspace_reference_unique').on(table.workspaceId, table.publicReference),
    index('orders_workspace_idx').on(table.workspaceId),
    index('orders_status_idx').on(table.workspaceId, table.status),
    index('orders_email_idx').on(table.workspaceId, table.customerEmail),
    index('orders_workspace_expires_idx').on(table.workspaceId, table.expiresAt),
    index('orders_subscription_idx').on(table.subscriptionId, table.cycleNumber),
    // Prevent the same (subscription, cycle) being materialised twice when
    // MP retries a webhook for the same authorized_payment event.
    uniqueIndex('orders_subscription_cycle_unique')
      .on(table.subscriptionId, table.cycleNumber)
      .where(sql`${table.subscriptionId} IS NOT NULL`),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    orderId: fk()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    offerId: fk().references(() => productOffers.id, { onDelete: 'set null' }),
    name: text().notNull(),
    quantity: integer().notNull().default(1),
    unitAmountCents: bigint({ mode: 'bigint' }).notNull(),
    totalCents: bigint({ mode: 'bigint' }).notNull(),
    metadata: jsonb().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [index('order_items_order_idx').on(table.orderId)],
);
