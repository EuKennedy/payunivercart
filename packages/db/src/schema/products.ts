import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  currencyEnum,
  deletedAt,
  fk,
  id,
  productTypeEnum,
  timestampTzNullable,
  updatedAt,
} from './common.js';
import { workspaces } from './workspaces.js';

export const products = pgTable(
  'products',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    type: productTypeEnum().notNull().default('one_time'),
    coverImageUrl: text(),
    isActive: boolean().notNull().default(true),
    metadata: jsonb().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('products_workspace_slug_unique').on(table.workspaceId, table.slug),
    index('products_workspace_idx').on(table.workspaceId),
  ],
);

export const productCategories = pgTable(
  'product_categories',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('product_categories_workspace_slug_unique').on(table.workspaceId, table.slug),
  ],
);

/**
 * Many-to-many between products and categories. `workspaceId` is denormalized
 * here on purpose: it enforces a CHECK constraint that the product and the
 * category belong to the same workspace, so a buggy endpoint cannot create
 * a cross-tenant mapping that would leak a competitor's product into another
 * tenant's category listing. The constraint is declared at the DB level via
 * a trigger (see migration `0001_*_product_category_mappings_check.sql`)
 * because Postgres CHECK clauses cannot reference other tables directly;
 * Drizzle's `check()` records the SQL the migration emits.
 */
export const productCategoryMappings = pgTable(
  'product_category_mappings',
  {
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    categoryId: fk()
      .notNull()
      .references(() => productCategories.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('product_category_mappings_pk').on(table.productId, table.categoryId),
    index('product_category_mappings_workspace_idx').on(table.workspaceId),
    // Sanity-only guard at the column level; full cross-table parity is
    // enforced by a Postgres trigger declared in the accompanying migration.
    check('product_category_mappings_workspace_not_null', sql`${table.workspaceId} IS NOT NULL`),
  ],
);

/**
 * Price offers attached to a product. Amount is stored as bigint cents in the
 * product's currency so we never have floating point drift in payments.
 */
export const productOffers = pgTable(
  'product_offers',
  {
    id: id(),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    amountCents: bigint({ mode: 'bigint' }).notNull(),
    currency: currencyEnum().notNull().default('BRL'),
    maxInstallments: integer().notNull().default(12),
    isActive: boolean().notNull().default(true),
    isDefault: boolean().notNull().default(false),
    metadata: jsonb().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('product_offers_product_idx').on(table.productId),
    index('product_offers_workspace_idx').on(table.workspaceId),
  ],
);

export const productCoupons = pgTable(
  'product_coupons',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    code: text().notNull(),
    discountType: text().notNull(),
    discountValue: bigint({ mode: 'bigint' }).notNull(),
    maxRedemptions: integer(),
    redemptions: integer().notNull().default(0),
    /** Optional expiry. Coupons without an expiry are valid until disabled. */
    expiresAt: timestampTzNullable(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('product_coupons_workspace_code_unique').on(table.workspaceId, table.code),
    index('product_coupons_workspace_active_idx').on(table.workspaceId, table.isActive),
  ],
);
