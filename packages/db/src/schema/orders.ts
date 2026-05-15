import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { checkouts } from './checkouts.js';
import {
  createdAt,
  currencyEnum,
  fk,
  id,
  orderStatusEnum,
  updatedAt,
} from './common.js';
import { productOffers, products } from './products.js';
import { workspaces } from './workspaces.js';

export const orders = pgTable(
  'orders',
  {
    id: id(),
    workspaceId: fk().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    checkoutId: fk().references(() => checkouts.id, { onDelete: 'set null' }),
    publicReference: text().notNull(),
    status: orderStatusEnum().notNull().default('draft'),
    customerName: text().notNull(),
    customerEmail: text().notNull(),
    customerDocument: text().notNull(),
    customerPhoneRaw: text().notNull(),
    customerPhoneE164: text().notNull(),
    customerWahaChatId: text(),
    shippingAddress: jsonb(),
    subtotalCents: bigint({ mode: 'bigint' }).notNull().default(0n),
    discountCents: bigint({ mode: 'bigint' }).notNull().default(0n),
    shippingCents: bigint({ mode: 'bigint' }).notNull().default(0n),
    totalCents: bigint({ mode: 'bigint' }).notNull(),
    currency: currencyEnum().notNull().default('BRL'),
    ipAddress: text(),
    userAgent: text(),
    metadata: jsonb().notNull().default({}),
    paidAt: createdAt(),
    cancelledAt: createdAt(),
    expiresAt: createdAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('orders_workspace_reference_unique').on(table.workspaceId, table.publicReference),
    index('orders_workspace_idx').on(table.workspaceId),
    index('orders_status_idx').on(table.workspaceId, table.status),
    index('orders_email_idx').on(table.workspaceId, table.customerEmail),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    orderId: fk().notNull().references(() => orders.id, { onDelete: 'cascade' }),
    productId: fk().notNull().references(() => products.id, { onDelete: 'restrict' }),
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
