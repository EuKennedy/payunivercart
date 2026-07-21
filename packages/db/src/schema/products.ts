import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
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
} from './common';
import { workspaces } from './workspaces';

/** See `workspaces.ts` for the rationale on bytea-in-row image storage. */
const bytea = customType<{ data: Uint8Array; default: false }>({
  dataType() {
    return 'bytea';
  },
});

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
    /** Legacy external-URL cover. Kept for backwards-compat; the new
     * upload pipeline stores bytes in `coverImage`/`coverImageMime`. */
    coverImageUrl: text(),
    /** Cover image bytes (1:1 ratio enforced client-side, ≤2MB).
     * Served by `GET /api/img/product/:id/cover`. */
    coverImage: bytea(),
    /** MIME of `coverImage` (e.g. `image/jpeg`). NULL iff bytes NULL. */
    coverImageMime: text(),
    /**
     * Optional post-purchase delivery link. Producer sets this on the
     * product edit page; the buyer receives it by email AND WhatsApp
     * the moment the gateway flips the transaction to `paid`.
     *
     * Use cases: course platform login URL, Drive/Notion link, signed
     * download URL, Discord invite, etc. We don't validate the scheme
     * beyond "looks like a URL" so producers can ship unusual links
     * (`mailto:`, `tel:`, custom-protocol app URIs) without us
     * gatekeeping their delivery.
     */
    deliveryUrl: text(),
    /**
     * Optional free-text instructions rendered alongside `deliveryUrl`
     * on the buyer's confirmation. Markdown is NOT parsed; newlines
     * preserved on render. Keep short — the receipt has limited room.
     */
    deliveryInstructions: text(),
    /**
     * When true, the public checkout renders a plan picker (from
     * `subscription_plans`) and posts to `checkout.createSubscription`
     * instead of `createOrder`. One-time products keep the legacy
     * single-price flow.
     */
    isSubscription: boolean().notNull().default(false),
    /**
     * Evergreen scarcity countdown on the public checkout. The clock is
     * per-visitor: it starts when THIS buyer first opens the page and is
     * persisted in their localStorage, not against a shared wall-clock
     * deadline — which is why there is no server-side `expires_at`
     * column here to keep in sync. Defaults false so a product created
     * in under 30 seconds renders exactly what its producer expects,
     * which is nothing.
     */
    checkoutTimerEnabled: boolean().notNull().default(false),
    /**
     * How long that per-visitor countdown runs. 15 minutes is long
     * enough to fill a card form without panic and short enough to
     * still read as scarcity. The 1–1440 range is a CHECK below: a 0
     * would expire the timer before the page finished painting.
     */
    checkoutTimerMinutes: integer().notNull().default(15),
    /** Copy shown next to the ticking clock. NULL ⇒ the checkout falls
     *  back to its own default string, so a producer who flips the
     *  toggle and writes nothing still gets sensible Portuguese instead
     *  of an empty bar. */
    checkoutTimerMessage: text(),
    /**
     * What happens at 00:00. `restart` loops the cycle; `last_chance`
     * freezes the counter, swaps in the last-chance copy and applies
     * the optional discount below. There is deliberately no "disappear"
     * option — a timer that silently vanishes reads as a bug to the
     * buyer. Default `restart` because it is the branch with no price
     * consequences. Plain text() + CHECK rather than a pgEnum, matching
     * `workspaces.checkoutTemplate`: Postgres has no
     * `CREATE TYPE IF NOT EXISTS`, and an idempotent migration is worth
     * more here than a native type.
     */
    checkoutTimerExpiredBehavior: text().notNull().default('restart'),
    /** Copy that replaces `checkoutTimerMessage` once `last_chance`
     *  kicks in. NULL ⇒ app default. Ignored under `restart`. */
    checkoutTimerExpiredMessage: text(),
    /**
     * Discriminant for the OPTIONAL last-chance discount, mirroring
     * `affiliate_programs.commissionType`: `percent` reads
     * `checkoutTimerDiscountPercent`, `fixed` reads
     * `checkoutTimerDiscountCents`. NULL ⇒ no discount at all, and NULL
     * is what a producer gets until they explicitly opt in. The public
     * checkout never sends an amount over the wire, so whatever lands
     * in these three columns is the only number the server will ever
     * subtract from the price.
     */
    checkoutTimerDiscountType: text(),
    /** Used when type = `percent`. Capped at 90, not 100, by CHECK: a
     *  full discount produces `amount: 0`, which every gateway rejects
     *  AFTER the order row already exists. NULL otherwise. */
    checkoutTimerDiscountPercent: integer(),
    /** Used when type = `fixed`. Cents as bigint like every other money
     *  column, so no path through this feature touches a float. NULL
     *  otherwise. */
    checkoutTimerDiscountCents: bigint({ mode: 'bigint' }),
    /**
     * Full-width promotional banner rendered ABOVE the producer brand
     * bar on the public checkout. Defaults false for the same reason
     * the timer does: a freshly created product renders neither.
     */
    checkoutBannerEnabled: boolean().notNull().default(false),
    /** `image` renders the uploaded bytes, `text` renders
     *  `checkoutBannerText` on the configured colours. text() + CHECK,
     *  same rationale as `checkoutTimerExpiredBehavior`. */
    checkoutBannerType: text().notNull().default('image'),
    /** Desktop banner bytes (wide, ≤1MB). Served by
     *  `GET /api/img/product/:id/banner`. */
    checkoutBannerImage: bytea(),
    /** MIME of `checkoutBannerImage`. NULL iff bytes NULL — the public
     *  checkout query keys the image URL off this sentinel so it never
     *  has to select the bytea on its hottest read path. */
    checkoutBannerImageMime: text(),
    /** Optional portrait variant for narrow viewports. NULL ⇒ the
     *  desktop image is used at every width. */
    checkoutBannerImageMobile: bytea(),
    /** MIME of `checkoutBannerImageMobile`. NULL iff bytes NULL. */
    checkoutBannerImageMobileMime: text(),
    /** Banner copy when type = `text`. NULL ⇒ nothing to paint, so the
     *  banner is suppressed even with `checkoutBannerEnabled` true. */
    checkoutBannerText: text(),
    /** Banner background as `#rrggbb`. Plain text() like
     *  `workspaces.brandPrimaryColor`. NULL ⇒ checkout default. */
    checkoutBannerBgColor: text(),
    /** Banner foreground as `#rrggbb`. NULL ⇒ checkout default. */
    checkoutBannerTextColor: text(),
    /**
     * Optional click-through for the banner. Unlike `deliveryUrl`
     * above, the scheme IS gatekept (https:// only) at the API
     * boundary: this is an anchor rendered on a public payment page to
     * strangers, not a link mailed to a buyer who already paid. NULL ⇒
     * the banner is not clickable.
     */
    checkoutBannerLinkUrl: text(),
    isActive: boolean().notNull().default(true),
    metadata: jsonb().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('products_workspace_slug_unique').on(table.workspaceId, table.slug),
    index('products_workspace_idx').on(table.workspaceId),
    check('products_checkout_timer_minutes_range', sql`checkout_timer_minutes BETWEEN 1 AND 1440`),
    check(
      'products_checkout_timer_expired_behavior_valid',
      sql`checkout_timer_expired_behavior IN ('restart', 'last_chance')`,
    ),
    check(
      'products_checkout_timer_discount_type_valid',
      sql`checkout_timer_discount_type IS NULL OR checkout_timer_discount_type IN ('percent', 'fixed')`,
    ),
    check(
      'products_checkout_timer_discount_percent_range',
      sql`checkout_timer_discount_percent IS NULL OR checkout_timer_discount_percent BETWEEN 1 AND 90`,
    ),
    check(
      'products_checkout_timer_discount_cents_nonneg',
      sql`checkout_timer_discount_cents IS NULL OR checkout_timer_discount_cents >= 0`,
    ),
    check('products_checkout_banner_type_valid', sql`checkout_banner_type IN ('image', 'text')`),
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
