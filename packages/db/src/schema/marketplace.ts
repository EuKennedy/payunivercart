import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, fk, id, timestampTzNullable, updatedAt } from './common';
import { products } from './products';
import { workspaces } from './workspaces';

/**
 * Pilar 4 — Marketplace.
 *
 * Producer opts an existing product INTO a public catalog. Buyers
 * browse the catalog at /marketplace, search/filter by category +
 * price + popularity, click into a listing, and check out through
 * the producer's own checkout (we never reroute the gateway leg —
 * money still lands in the producer's MP account; we just surface
 * the link).
 *
 * Why we keep the marketplace listing as a SEPARATE table (rather
 * than a flag on `products`):
 *   - Marketplace-only fields (cover image override, long pitch copy,
 *     category, search keywords) shouldn't bloat the products table
 *     that every checkout query reads.
 *   - We can later add marketplace-only fees (commissionBps) without
 *     touching the core product schema.
 *   - Producer can publish/unpublish without touching the source
 *     product's `is_active` (the checkout might still be live for
 *     direct buyers even when the marketplace listing is paused).
 *
 * Categories: open enum so producers can pick from a curated set
 * without us shipping a CMS. Future iterations may demote this to
 * a separate `marketplace_categories` table when slugs need URLs.
 */

export const marketplaceStatusEnum = pgEnum('marketplace_listing_status', [
  'draft',
  'pending_review',
  'live',
  'paused',
  'rejected',
]);

export const marketplaceCategoryEnum = pgEnum('marketplace_category', [
  'cursos',
  'mentorias',
  'comunidades',
  'software',
  'ebooks',
  'consultorias',
  'eventos',
  'servicos',
  'outros',
]);

/**
 * One row per (workspace, product) at most. Composite unique guards
 * against the producer accidentally double-publishing the same SKU.
 */
export const marketplaceListings = pgTable(
  'marketplace_listings',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** Producer-controlled lifecycle. `live` = visible on /marketplace.
     *  `pending_review` reserves space for a future manual moderation
     *  step; v1 auto-flips drafts to live when the producer hits
     *  publish, so `pending_review` is unused but the enum supports it. */
    status: marketplaceStatusEnum().notNull().default('draft'),
    category: marketplaceCategoryEnum().notNull().default('outros'),
    /** Headline shown on the listing card. Defaults to product.name on
     *  insert; producer can override with a more sales-y phrasing. */
    headline: text().notNull(),
    /** Long-form pitch copy. Plain text, soft-newline-aware. */
    pitch: text().notNull().default(''),
    /** Listing cover override (URL or null → fall back to product cover).
     *  URL not bytes — marketplace covers can be heavier than checkout
     *  thumbnails so we expect producers to host on R2 / S3 / similar. */
    coverImageUrl: text(),
    /** Search keywords producer tags for retrieval. Stored as
     *  `text[]` would be cleaner; jsonb keeps drizzle types simple. */
    searchKeywords: jsonb().$type<string[]>().notNull().default([]),
    /** Sort weight — operator can pin a launch to the top. Default 0;
     *  positive numbers bubble up, negatives sink. */
    sortBoost: integer().notNull().default(0),
    /** Cached snapshot of click-through count for the "Popular" sort
     *  bucket. Worker recomputes daily so a high-burst listing can't
     *  game the sort by repeatedly opening its own page. */
    cachedClicks: integer().notNull().default(0),
    /** Cached snapshot of completed purchases attributable to this
     *  listing. Same worker. */
    cachedPurchases: integer().notNull().default(0),
    /** Producer fields the moderator may need to contact about the
     *  listing — defaults to the workspace owner. */
    contactEmail: text(),
    /** Producer-facing notes (rejection reason, change-required hints).
     *  Visible to the producer in the publish UI. */
    moderationNote: text(),
    publishedAt: timestampTzNullable(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('marketplace_listings_workspace_product_unique').on(
      table.workspaceId,
      table.productId,
    ),
    index('marketplace_listings_status_idx').on(table.status),
    index('marketplace_listings_category_idx').on(table.category),
    index('marketplace_listings_sort_idx').on(table.sortBoost, table.cachedPurchases),
  ],
);

/**
 * Click-through ledger. Lets us recompute `cachedClicks` and rank
 * by "trending in last 7 days" without scanning a server-log file.
 * One row per (listing, day, ip-hash) so a single buyer hammering
 * the page only counts once per UTC day.
 */
export const marketplaceClicks = pgTable(
  'marketplace_clicks',
  {
    id: id(),
    listingId: fk()
      .notNull()
      .references(() => marketplaceListings.id, { onDelete: 'cascade' }),
    /** UTC date (YYYY-MM-DD) the click happened. */
    clickDate: text().notNull(),
    /** Hash of buyer IP — keep the raw IP off this table to avoid the
     *  data minimisation lecture from the LGPD team. */
    ipHash: text().notNull(),
    /** Referrer when present. Truncated to 240 chars. */
    referrer: text(),
    /** UTM source / medium / campaign — JSON so we don't migrate per param. */
    utm: jsonb().$type<Record<string, string>>().notNull().default({}),
    /** `true` when the click ended in a paid order. Worker flips this
     *  on the cart-recovery sweep, NOT inline. */
    convertedToOrder: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('marketplace_clicks_unique_per_day').on(
      table.listingId,
      table.clickDate,
      table.ipHash,
    ),
    index('marketplace_clicks_listing_idx').on(table.listingId),
  ],
);
