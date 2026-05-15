import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, fk, id, updatedAt } from './common.js';
import { products } from './products.js';
import { workspaces } from './workspaces.js';

/**
 * A checkout binds branding, allowed payment methods, fields and pixels to one
 * (or many, via `productIds`) products. Configuration lives in JSONB so we can
 * iterate on the schema without migrations during early product evolution.
 */
export const checkouts = pgTable(
  'checkouts',
  {
    id: id(),
    workspaceId: fk().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    name: text().notNull(),
    primaryProductId: fk().references(() => products.id, { onDelete: 'set null' }),
    config: jsonb().notNull().default({}),
    fields: jsonb().notNull().default([]),
    enabledMethods: jsonb().notNull().default(['pix', 'credit_card', 'boleto']),
    pixels: jsonb().notNull().default([]),
    customDomain: text(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('checkouts_workspace_slug_unique').on(table.workspaceId, table.slug),
    uniqueIndex('checkouts_custom_domain_unique').on(table.customDomain),
    index('checkouts_workspace_idx').on(table.workspaceId),
  ],
);
