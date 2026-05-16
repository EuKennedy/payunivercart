import { sql } from 'drizzle-orm';
import { bigint, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { checkouts } from './checkouts';
import { createdAt, currencyEnum, fk, id, timestampTzNullable, updatedAt } from './common';
import { workspaces } from './workspaces';

/**
 * Abandoned carts. Redis is the hot store; this table is the durable copy used
 * by recovery campaigns and analytics.
 */
export const carts = pgTable(
  'carts',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    checkoutId: fk().references(() => checkouts.id, { onDelete: 'set null' }),
    customerEmail: text(),
    customerPhoneRaw: text(),
    customerPhoneE164: text(),
    customerWahaChatId: text(),
    customerName: text(),
    itemsSnapshot: jsonb().notNull().default([]),
    totalCents: bigint({ mode: 'bigint' }).notNull().default(sql`0`),
    currency: currencyEnum().notNull().default('BRL'),
    /** Set when the cart is detected as abandoned by the worker. */
    abandonedAt: timestampTzNullable(),
    /** Set when the cart converts via a recovery flow. */
    recoveredAt: timestampTzNullable(),
    metadata: jsonb().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('carts_workspace_idx').on(table.workspaceId),
    // Partial unique: only enforce dedupe when we know the customer's email.
    // Nullable columns in a regular UNIQUE do not block duplicates — multiple
    // anonymous carts would all share `(workspace, NULL, checkout)`.
    uniqueIndex('carts_workspace_email_unique')
      .on(table.workspaceId, table.customerEmail, table.checkoutId)
      .where(sql`customer_email IS NOT NULL`),
    index('carts_workspace_abandoned_idx').on(table.workspaceId, table.abandonedAt),
  ],
);
