import {
  bigint,
  index,
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
  updatedAt,
} from './common.js';
import { workspaces } from './workspaces.js';

/**
 * Abandoned carts. Redis is the hot store; this table is the durable copy used
 * by recovery campaigns and analytics.
 */
export const carts = pgTable(
  'carts',
  {
    id: id(),
    workspaceId: fk().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    checkoutId: fk().references(() => checkouts.id, { onDelete: 'set null' }),
    customerEmail: text(),
    customerPhoneRaw: text(),
    customerPhoneE164: text(),
    customerWahaChatId: text(),
    customerName: text(),
    itemsSnapshot: jsonb().notNull().default([]),
    totalCents: bigint({ mode: 'bigint' }).notNull().default(0n),
    currency: currencyEnum().notNull().default('BRL'),
    abandonedAt: createdAt(),
    recoveredAt: createdAt(),
    metadata: jsonb().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('carts_workspace_idx').on(table.workspaceId),
    uniqueIndex('carts_workspace_email_unique').on(table.workspaceId, table.customerEmail, table.checkoutId),
  ],
);
