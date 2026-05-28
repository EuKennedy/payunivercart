import { createHash } from 'node:crypto';
import { schema } from '@payunivercart/db';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { publicProcedure, router, workspaceProcedure } from '../trpc';
import { emitMarketplaceListingEvent } from '../webhooks/emit-helpers';

/**
 * Pilar 4 — Marketplace.
 *
 * Two surfaces:
 *
 *   1. PUBLIC — `browse`, `bySlug`, `recordClick`. Drives the
 *      `/marketplace` page consumed by buyers. No tenant context.
 *
 *   2. PRODUCER — `listMine`, `upsert`, `publish`, `pause`,
 *      `remove`. Producer-facing CRUD under workspaceProcedure with
 *      strict workspaceId predicates.
 *
 * Sort buckets the public surface offers:
 *   - `popular`  → sortBoost desc, then cachedPurchases desc
 *   - `recent`   → publishedAt desc
 *   - `price_lo` → product.priceCents asc
 *   - `price_hi` → product.priceCents desc
 *
 * Categories enforce the enum from the schema; "search" matches
 * headline + pitch + searchKeywords[]; pagination is keyset (cursor =
 * encoded "publishedAt|id") so large catalogs don't trash the index.
 */

/* -------------------------------------------------------------------------- */
/* Migration 0020 resilience                                                  */
/*                                                                            */
/* `marketplace_listings.sales_page_url` ships in migration 0020. If the      */
/* deploy that pushes new app code lands BEFORE the migrate one-shot          */
/* succeeds in prod (Coolify pitfall: `restart: "no"` services don't always   */
/* recreate between deploys), every SELECT that references the column blows   */
/* up the whole tRPC call → the dashboard's "Meu Marketplace" + the public    */
/* `/afiliar` page both render empty. We probe `information_schema.columns`   */
/* once per process and memoise the result, so the per-call overhead is one   */
/* lookup at boot.                                                            */
/* -------------------------------------------------------------------------- */

let salesPageColPromise: Promise<boolean> | null = null;
// biome-ignore lint/suspicious/noExplicitAny: drizzle DatabaseClient generic is awkward to thread here; the helper only needs `.execute(sql)`.
async function hasSalesPageColumn(db: any): Promise<boolean> {
  if (salesPageColPromise) return salesPageColPromise;
  salesPageColPromise = (async () => {
    try {
      const probe = await db.execute(sql`
        SELECT 1
          FROM information_schema.columns
         WHERE table_name = 'marketplace_listings'
           AND column_name = 'sales_page_url'
         LIMIT 1
      `);
      // postgres-js + drizzle return the result as an array-like object.
      const len = (probe as { length?: number } | undefined)?.length ?? 0;
      return len > 0;
    } catch {
      // Defensive: assume missing so we don't take the dashboard down.
      // The next deploy after the migration applies clears the cache.
      return false;
    }
  })();
  return salesPageColPromise;
}

const Category = z.enum([
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

const Status = z.enum(['draft', 'pending_review', 'live', 'paused', 'rejected']);

const SortOrder = z.enum(['popular', 'recent', 'price_lo', 'price_hi']);

const PublicListing = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  productSlug: z.string(),
  workspaceName: z.string(),
  category: Category,
  headline: z.string(),
  pitch: z.string(),
  coverImageUrl: z.string().nullable(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string(),
  publishedAt: z.date().nullable(),
});

/**
 * Affiliate-facing variant. Extends the public listing with the
 * commission shape of the workspace's public + active program, so the
 * `/afiliar` shop can render commission previews and a one-click
 * "Afiliar" CTA without a second round-trip per card.
 *
 * `defaultProgramId` is the program that the "Afiliar" button targets
 * (`requestMembership`). Resolution order:
 *   1. product-specific public+active program for that productId, else
 *   2. workspace-wide public+active program (productId IS NULL).
 *
 * Only listings whose workspace exposes at least one such program are
 * surfaced — otherwise the user would land on a dead-end card.
 */
const AffiliateListing = PublicListing.extend({
  defaultProgramId: z.string().uuid(),
  approvalPolicy: z.enum(['automatic', 'manual', 'invite_only']),
  commissionType: z.enum(['percent', 'flat', 'recurring', 'lifetime']),
  commissionPercent: z.number().int().nullable(),
  commissionFlatCents: z.number().int().nullable(),
  recurringCycleLimit: z.number().int().nullable(),
  refundWindowDays: z.number().int().nonnegative(),
  attributionWindowDays: z.number().int().nonnegative(),
  /** Producer's custom landing/VSL URL. NULL → default `/c/<slug>`. */
  salesPageUrl: z.string().nullable(),
});

const CommissionType = z.enum(['percent', 'flat', 'recurring', 'lifetime']);
const ApprovalPolicy = z.enum(['automatic', 'manual', 'invite_only']);

const ProducerListing = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  status: Status,
  category: Category,
  headline: z.string(),
  pitch: z.string(),
  coverImageUrl: z.string().nullable(),
  searchKeywords: z.array(z.string()),
  salesPageUrl: z.string().nullable(),
  cachedClicks: z.number().int().nonnegative(),
  cachedPurchases: z.number().int().nonnegative(),
  publishedAt: z.date().nullable(),
  moderationNote: z.string().nullable(),
  /** Commission terms snapshot from the product-scoped affiliate
   *  program. NULL when no product-scoped program exists; the
   *  workspace-wide default applies on the public surface. */
  commission: z
    .object({
      programId: z.string().uuid(),
      approvalPolicy: ApprovalPolicy,
      commissionType: CommissionType,
      commissionPercent: z.number().int().nullable(),
      commissionFlatCents: z.number().int().nullable(),
      recurringCycleLimit: z.number().int().nullable(),
      refundWindowDays: z.number().int().nonnegative(),
      attributionWindowDays: z.number().int().nonnegative(),
    })
    .nullable(),
});

export const marketplaceRouter = router({
  /* ============================= PUBLIC ============================== */

  /**
   * Browse the public catalog. Filters: category, search query, sort.
   * Pagination via cursor that encodes `${publishedAt.iso}|${id}` —
   * stable across replicas, no offset scans.
   */
  browse: publicProcedure
    .input(
      z
        .object({
          q: z.string().trim().min(1).max(80).optional(),
          category: Category.optional(),
          sort: SortOrder.default('popular'),
          limit: z.number().int().min(1).max(48).default(24),
          cursor: z.string().optional(),
        })
        .optional(),
    )
    .output(z.object({ items: z.array(PublicListing), nextCursor: z.string().nullable() }))
    .query(async ({ ctx, input }) => {
      const q = input?.q;
      const limit = input?.limit ?? 24;
      const sort = input?.sort ?? 'popular';
      const where = and(
        eq(schema.marketplaceListings.status, 'live'),
        input?.category ? eq(schema.marketplaceListings.category, input.category) : undefined,
        q
          ? or(
              ilike(schema.marketplaceListings.headline, `%${q}%`),
              ilike(schema.marketplaceListings.pitch, `%${q}%`),
              // Search keywords are JSON array; cast to text for ilike.
              sql`${schema.marketplaceListings.searchKeywords}::text ilike ${`%${q}%`}`,
            )
          : undefined,
      );

      // Price + currency come from either `product_offers` (one-time
      // products keep a default offer row) OR `subscription_plans`
      // (subscription products skip the legacy offer row entirely —
      // the picker on /c/<slug> reads from plans). COALESCE-ing across
      // both sources prevents the old `innerJoin productOffers` from
      // silently filtering every subscription listing out of the
      // marketplace.
      const priceCentsExpr = sql<string>`COALESCE(
        (SELECT po.amount_cents::text FROM ${schema.productOffers} po
          WHERE po.product_id = ${schema.products.id} AND po.is_default = true LIMIT 1),
        (SELECT sp.amount_cents::text FROM ${schema.subscriptionPlans} sp
          WHERE sp.product_id = ${schema.products.id} AND sp.is_active = true
          ORDER BY sp.amount_cents ASC, sp.id ASC LIMIT 1),
        '0'
      )`;
      const currencyExpr = sql<string>`COALESCE(
        (SELECT po.currency::text FROM ${schema.productOffers} po
          WHERE po.product_id = ${schema.products.id} AND po.is_default = true LIMIT 1),
        (SELECT sp.currency::text FROM ${schema.subscriptionPlans} sp
          WHERE sp.product_id = ${schema.products.id} AND sp.is_active = true
          ORDER BY sp.amount_cents ASC, sp.id ASC LIMIT 1),
        'BRL'
      )`;

      const baseQuery = ctx.services.db.db
        .select({
          id: schema.marketplaceListings.id,
          productId: schema.marketplaceListings.productId,
          productSlug: schema.products.slug,
          workspaceName: schema.workspaces.companyName,
          workspaceNameFallback: schema.workspaces.name,
          category: schema.marketplaceListings.category,
          headline: schema.marketplaceListings.headline,
          pitch: schema.marketplaceListings.pitch,
          coverImageUrl: schema.marketplaceListings.coverImageUrl,
          priceCents: priceCentsExpr,
          currency: currencyExpr,
          publishedAt: schema.marketplaceListings.publishedAt,
          sortBoost: schema.marketplaceListings.sortBoost,
          cachedPurchases: schema.marketplaceListings.cachedPurchases,
        })
        .from(schema.marketplaceListings)
        .innerJoin(schema.products, eq(schema.products.id, schema.marketplaceListings.productId))
        .innerJoin(
          schema.workspaces,
          eq(schema.workspaces.id, schema.marketplaceListings.workspaceId),
        )
        .where(where)
        .limit(limit + 1);

      // Add the order clause matching the sort bucket. Price sorts use
      // the same COALESCE expression as the SELECT so subscription
      // listings sort by their first plan amount.
      const sortedQuery = (() => {
        switch (sort) {
          case 'popular':
            return baseQuery.orderBy(
              desc(schema.marketplaceListings.sortBoost),
              desc(schema.marketplaceListings.cachedPurchases),
              desc(schema.marketplaceListings.id),
            );
          case 'recent':
            return baseQuery.orderBy(
              desc(schema.marketplaceListings.publishedAt),
              desc(schema.marketplaceListings.id),
            );
          case 'price_lo':
            return baseQuery.orderBy(
              sql`${priceCentsExpr}::bigint asc`,
              desc(schema.marketplaceListings.id),
            );
          case 'price_hi':
            return baseQuery.orderBy(
              sql`${priceCentsExpr}::bigint desc`,
              desc(schema.marketplaceListings.id),
            );
        }
      })();

      const rows = await sortedQuery;
      const slice = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const last = slice[slice.length - 1];
      const nextCursor =
        hasMore && last
          ? Buffer.from(`${last.publishedAt?.toISOString() ?? ''}|${last.id}`).toString('base64url')
          : null;
      return {
        items: slice.map((r) => ({
          id: r.id,
          productId: r.productId,
          productSlug: r.productSlug,
          workspaceName: (r.workspaceName ?? r.workspaceNameFallback) || 'Anônimo',
          category: r.category as z.infer<typeof Category>,
          headline: r.headline,
          pitch: r.pitch,
          coverImageUrl: r.coverImageUrl,
          priceCents: Number(r.priceCents ?? 0),
          currency: r.currency,
          publishedAt: r.publishedAt,
        })),
        nextCursor,
      };
    }),

  /**
   * Public lookup by listing id. The buyer clicks through to the
   * producer's own checkout from here.
   */
  bySlug: publicProcedure
    .input(z.object({ listingId: z.string().uuid() }))
    .output(PublicListing.nullable())
    .query(async ({ ctx, input }) => {
      // Same COALESCE strategy as browse — subscription products have
      // no `product_offers` row, the price/currency come from the
      // cheapest active `subscription_plans` row instead.
      const priceCentsExpr = sql<string>`COALESCE(
        (SELECT po.amount_cents::text FROM ${schema.productOffers} po
          WHERE po.product_id = ${schema.products.id} AND po.is_default = true LIMIT 1),
        (SELECT sp.amount_cents::text FROM ${schema.subscriptionPlans} sp
          WHERE sp.product_id = ${schema.products.id} AND sp.is_active = true
          ORDER BY sp.amount_cents ASC, sp.id ASC LIMIT 1),
        '0'
      )`;
      const currencyExpr = sql<string>`COALESCE(
        (SELECT po.currency::text FROM ${schema.productOffers} po
          WHERE po.product_id = ${schema.products.id} AND po.is_default = true LIMIT 1),
        (SELECT sp.currency::text FROM ${schema.subscriptionPlans} sp
          WHERE sp.product_id = ${schema.products.id} AND sp.is_active = true
          ORDER BY sp.amount_cents ASC, sp.id ASC LIMIT 1),
        'BRL'
      )`;
      const [row] = await ctx.services.db.db
        .select({
          id: schema.marketplaceListings.id,
          productId: schema.marketplaceListings.productId,
          productSlug: schema.products.slug,
          workspaceName: schema.workspaces.companyName,
          workspaceNameFallback: schema.workspaces.name,
          category: schema.marketplaceListings.category,
          headline: schema.marketplaceListings.headline,
          pitch: schema.marketplaceListings.pitch,
          coverImageUrl: schema.marketplaceListings.coverImageUrl,
          priceCents: priceCentsExpr,
          currency: currencyExpr,
          publishedAt: schema.marketplaceListings.publishedAt,
        })
        .from(schema.marketplaceListings)
        .innerJoin(schema.products, eq(schema.products.id, schema.marketplaceListings.productId))
        .innerJoin(
          schema.workspaces,
          eq(schema.workspaces.id, schema.marketplaceListings.workspaceId),
        )
        .where(
          and(
            eq(schema.marketplaceListings.id, input.listingId),
            eq(schema.marketplaceListings.status, 'live'),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        productId: row.productId,
        productSlug: row.productSlug,
        workspaceName: (row.workspaceName ?? row.workspaceNameFallback) || 'Anônimo',
        category: row.category as z.infer<typeof Category>,
        headline: row.headline,
        pitch: row.pitch,
        coverImageUrl: row.coverImageUrl,
        priceCents: Number(row.priceCents ?? 0),
        currency: row.currency,
        publishedAt: row.publishedAt,
      };
    }),

  /**
   * Affiliate-shop variant. Same filters / sort / cursor as `browse`,
   * but joins through `affiliate_programs` and only surfaces listings
   * whose workspace has an active+public program. Each row carries the
   * commission preview so cards render without extra round-trips.
   *
   * Performance: the program lookup is done with a single correlated
   * lateral that picks the most specific match (product-scoped first,
   * workspace-wide fallback). Each lateral is bounded by LIMIT 1 and
   * uses the existing `affiliate_programs_workspace_idx` /
   * `affiliate_programs_product_idx` — same hot path as the producer
   * dashboard already exercises.
   */
  browseForAffiliation: publicProcedure
    .input(
      z
        .object({
          q: z.string().trim().min(1).max(80).optional(),
          category: Category.optional(),
          sort: SortOrder.default('popular'),
          limit: z.number().int().min(1).max(48).default(24),
          cursor: z.string().optional(),
        })
        .optional(),
    )
    .output(z.object({ items: z.array(AffiliateListing), nextCursor: z.string().nullable() }))
    .query(async ({ ctx, input }) => {
      const q = input?.q;
      const limit = input?.limit ?? 24;
      const sort = input?.sort ?? 'popular';

      // Diagnostic: count live listings AND live listings with a
      // public+active program. When they diverge, the missing rows are
      // a sign the auto-provisioner / backfill didn't fire — visible
      // in the worker log without having to SSH into Postgres.
      try {
        const [totalRow] = await ctx.services.db.db
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.marketplaceListings)
          .where(eq(schema.marketplaceListings.status, 'live'));
        const totalLive = Number(totalRow?.n ?? 0);
        const [affRow] = await ctx.services.db.db
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.marketplaceListings)
          .where(
            and(
              eq(schema.marketplaceListings.status, 'live'),
              sql`EXISTS (
                SELECT 1 FROM ${schema.affiliatePrograms} ap
                WHERE ap.workspace_id = ${schema.marketplaceListings.workspaceId}
                  AND ap.is_active::text = 'true'
                  AND ap.is_public::text = 'true'
                  AND (ap.product_id = ${schema.marketplaceListings.productId} OR ap.product_id IS NULL)
              )`,
            ),
          );
        const affiliable = Number(affRow?.n ?? 0);
        if (totalLive !== affiliable) {
          process.stdout.write(
            `${JSON.stringify({
              level: 'warn',
              event: 'marketplace.browseForAffiliation.unaffiliable_listings',
              totalLive,
              affiliable,
              hiddenFromShop: totalLive - affiliable,
            })}\n`,
          );
        }
      } catch {
        // Diagnostic must never break the read path.
      }

      // EXISTS predicate: at least one active+public program for the
      // listing's workspace, either product-specific or workspace-wide.
      const programExists = sql`EXISTS (
        SELECT 1 FROM ${schema.affiliatePrograms} ap
        WHERE ap.workspace_id = ${schema.marketplaceListings.workspaceId}
          AND ap.is_active::text = 'true'
          AND ap.is_public::text = 'true'
          AND (ap.product_id = ${schema.marketplaceListings.productId} OR ap.product_id IS NULL)
      )`;

      const where = and(
        eq(schema.marketplaceListings.status, 'live'),
        input?.category ? eq(schema.marketplaceListings.category, input.category) : undefined,
        q
          ? or(
              ilike(schema.marketplaceListings.headline, `%${q}%`),
              ilike(schema.marketplaceListings.pitch, `%${q}%`),
              sql`${schema.marketplaceListings.searchKeywords}::text ilike ${`%${q}%`}`,
            )
          : undefined,
        programExists,
      );

      // Single correlated subquery per row — returns the chosen program
      // packed as JSON so we unpack exactly one field set in JS.
      // Product-specific (`product_id IS NOT NULL`) ranks first, then
      // workspace-wide fallback. Deterministic on (program.created_at,
      // program.id) for replay stability.
      const programJson = sql<{
        id: string;
        approval_policy: 'automatic' | 'manual' | 'invite_only';
        commission_type: 'percent' | 'flat' | 'recurring' | 'lifetime';
        commission_percent: number | null;
        commission_flat_cents: string | null;
        recurring_cycle_limit: number | null;
        refund_window_days: number;
        attribution_window_days: number;
      } | null>`(
        SELECT to_jsonb(t) FROM (
          SELECT
            id::text AS id,
            approval_policy,
            commission_type,
            commission_percent,
            commission_flat_cents::text AS commission_flat_cents,
            recurring_cycle_limit,
            refund_window_days,
            attribution_window_days
          FROM ${schema.affiliatePrograms} ap
          WHERE ap.workspace_id = ${schema.marketplaceListings.workspaceId}
            AND ap.is_active::text = 'true'
            AND ap.is_public::text = 'true'
            AND (ap.product_id = ${schema.marketplaceListings.productId} OR ap.product_id IS NULL)
          ORDER BY (ap.product_id IS NULL) ASC, ap.created_at ASC
          LIMIT 1
        ) t
      )`;

      // Same COALESCE strategy as `browse` — subscription products
      // skip `product_offers` (see products.create), so the price /
      // currency must fall back to the cheapest active subscription
      // plan. The old `innerJoin productOffers` silently filtered
      // every subscription listing out of /afiliar.
      const priceCentsExpr = sql<string>`COALESCE(
        (SELECT po.amount_cents::text FROM ${schema.productOffers} po
          WHERE po.product_id = ${schema.products.id} AND po.is_default = true LIMIT 1),
        (SELECT sp.amount_cents::text FROM ${schema.subscriptionPlans} sp
          WHERE sp.product_id = ${schema.products.id} AND sp.is_active = true
          ORDER BY sp.amount_cents ASC, sp.id ASC LIMIT 1),
        '0'
      )`;
      const currencyExpr = sql<string>`COALESCE(
        (SELECT po.currency::text FROM ${schema.productOffers} po
          WHERE po.product_id = ${schema.products.id} AND po.is_default = true LIMIT 1),
        (SELECT sp.currency::text FROM ${schema.subscriptionPlans} sp
          WHERE sp.product_id = ${schema.products.id} AND sp.is_active = true
          ORDER BY sp.amount_cents ASC, sp.id ASC LIMIT 1),
        'BRL'
      )`;

      // Same migration-0020 guard as listMine: drop the `sales_page_url`
      // column from the SELECT when prod hasn't applied the migration
      // yet so /afiliar keeps rendering instead of 500-ing.
      const salesPageColExists = await hasSalesPageColumn(ctx.services.db.db);
      const salesPageExpr = salesPageColExists
        ? sql<string | null>`${schema.marketplaceListings.salesPageUrl}`
        : sql<string | null>`NULL::text`;

      const baseQuery = ctx.services.db.db
        .select({
          id: schema.marketplaceListings.id,
          productId: schema.marketplaceListings.productId,
          productSlug: schema.products.slug,
          workspaceName: schema.workspaces.companyName,
          workspaceNameFallback: schema.workspaces.name,
          category: schema.marketplaceListings.category,
          headline: schema.marketplaceListings.headline,
          pitch: schema.marketplaceListings.pitch,
          coverImageUrl: schema.marketplaceListings.coverImageUrl,
          salesPageUrl: salesPageExpr,
          priceCents: priceCentsExpr,
          currency: currencyExpr,
          publishedAt: schema.marketplaceListings.publishedAt,
          program: programJson,
        })
        .from(schema.marketplaceListings)
        .innerJoin(schema.products, eq(schema.products.id, schema.marketplaceListings.productId))
        .innerJoin(
          schema.workspaces,
          eq(schema.workspaces.id, schema.marketplaceListings.workspaceId),
        )
        .where(where)
        .limit(limit + 1);

      const sortedQuery = (() => {
        switch (sort) {
          case 'popular':
            return baseQuery.orderBy(
              desc(schema.marketplaceListings.sortBoost),
              desc(schema.marketplaceListings.cachedPurchases),
              desc(schema.marketplaceListings.id),
            );
          case 'recent':
            return baseQuery.orderBy(
              desc(schema.marketplaceListings.publishedAt),
              desc(schema.marketplaceListings.id),
            );
          case 'price_lo':
            return baseQuery.orderBy(
              sql`${priceCentsExpr}::bigint asc`,
              desc(schema.marketplaceListings.id),
            );
          case 'price_hi':
            return baseQuery.orderBy(
              sql`${priceCentsExpr}::bigint desc`,
              desc(schema.marketplaceListings.id),
            );
        }
      })();

      const rows = await sortedQuery;
      const slice = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const last = slice[slice.length - 1];
      const nextCursor =
        hasMore && last
          ? Buffer.from(`${last.publishedAt?.toISOString() ?? ''}|${last.id}`).toString('base64url')
          : null;

      return {
        items: slice
          .filter((r) => r.program !== null)
          .map((r) => {
            // biome-ignore lint/style/noNonNullAssertion: guarded by .filter above.
            const prog = r.program!;
            return {
              id: r.id,
              productId: r.productId,
              productSlug: r.productSlug,
              workspaceName: (r.workspaceName ?? r.workspaceNameFallback) || 'Anônimo',
              category: r.category as z.infer<typeof Category>,
              headline: r.headline,
              pitch: r.pitch,
              coverImageUrl: r.coverImageUrl,
              salesPageUrl: r.salesPageUrl ?? null,
              priceCents: Number(r.priceCents ?? 0),
              currency: r.currency,
              publishedAt: r.publishedAt,
              defaultProgramId: prog.id,
              approvalPolicy: prog.approval_policy,
              commissionType: prog.commission_type,
              commissionPercent: prog.commission_percent,
              commissionFlatCents:
                prog.commission_flat_cents == null ? null : Number(prog.commission_flat_cents),
              recurringCycleLimit: prog.recurring_cycle_limit,
              refundWindowDays: prog.refund_window_days,
              attributionWindowDays: prog.attribution_window_days,
            };
          }),
        nextCursor,
      };
    }),

  /**
   * Detail page for a single affiliate-eligible listing. The producer's
   * pitch (long copy) lives on the listing row; the program info is
   * resolved with the same "product-scoped first, workspace-wide
   * fallback" rule used in `browseForAffiliation`. Returns NULL when
   * the listing is missing, not `live`, or its workspace has no public+
   * active program — same gates the grid applies so a bookmarked URL
   * never leaks an unaffiliable card.
   */
  detailForAffiliation: publicProcedure
    .input(z.object({ listingId: z.string().uuid() }))
    .output(AffiliateListing.nullable())
    .query(async ({ ctx, input }) => {
      const programJson = sql<{
        id: string;
        approval_policy: 'automatic' | 'manual' | 'invite_only';
        commission_type: 'percent' | 'flat' | 'recurring' | 'lifetime';
        commission_percent: number | null;
        commission_flat_cents: string | null;
        recurring_cycle_limit: number | null;
        refund_window_days: number;
        attribution_window_days: number;
      } | null>`(
        SELECT to_jsonb(t) FROM (
          SELECT
            id::text AS id,
            approval_policy,
            commission_type,
            commission_percent,
            commission_flat_cents::text AS commission_flat_cents,
            recurring_cycle_limit,
            refund_window_days,
            attribution_window_days
          FROM ${schema.affiliatePrograms} ap
          WHERE ap.workspace_id = ${schema.marketplaceListings.workspaceId}
            AND ap.is_active::text = 'true'
            AND ap.is_public::text = 'true'
            AND (ap.product_id = ${schema.marketplaceListings.productId} OR ap.product_id IS NULL)
          ORDER BY (ap.product_id IS NULL) ASC, ap.created_at ASC
          LIMIT 1
        ) t
      )`;

      const priceCentsExpr = sql<string>`COALESCE(
        (SELECT po.amount_cents::text FROM ${schema.productOffers} po
          WHERE po.product_id = ${schema.products.id} AND po.is_default = true LIMIT 1),
        (SELECT sp.amount_cents::text FROM ${schema.subscriptionPlans} sp
          WHERE sp.product_id = ${schema.products.id} AND sp.is_active = true
          ORDER BY sp.amount_cents ASC, sp.id ASC LIMIT 1),
        '0'
      )`;
      const currencyExpr = sql<string>`COALESCE(
        (SELECT po.currency::text FROM ${schema.productOffers} po
          WHERE po.product_id = ${schema.products.id} AND po.is_default = true LIMIT 1),
        (SELECT sp.currency::text FROM ${schema.subscriptionPlans} sp
          WHERE sp.product_id = ${schema.products.id} AND sp.is_active = true
          ORDER BY sp.amount_cents ASC, sp.id ASC LIMIT 1),
        'BRL'
      )`;
      // Same migration-0020 guard as listMine / browseForAffiliation.
      const salesPageColExists = await hasSalesPageColumn(ctx.services.db.db);
      const salesPageExpr = salesPageColExists
        ? sql<string | null>`${schema.marketplaceListings.salesPageUrl}`
        : sql<string | null>`NULL::text`;

      const [row] = await ctx.services.db.db
        .select({
          id: schema.marketplaceListings.id,
          productId: schema.marketplaceListings.productId,
          productSlug: schema.products.slug,
          workspaceName: schema.workspaces.companyName,
          workspaceNameFallback: schema.workspaces.name,
          category: schema.marketplaceListings.category,
          headline: schema.marketplaceListings.headline,
          pitch: schema.marketplaceListings.pitch,
          coverImageUrl: schema.marketplaceListings.coverImageUrl,
          salesPageUrl: salesPageExpr,
          priceCents: priceCentsExpr,
          currency: currencyExpr,
          publishedAt: schema.marketplaceListings.publishedAt,
          program: programJson,
        })
        .from(schema.marketplaceListings)
        .innerJoin(schema.products, eq(schema.products.id, schema.marketplaceListings.productId))
        .innerJoin(
          schema.workspaces,
          eq(schema.workspaces.id, schema.marketplaceListings.workspaceId),
        )
        .where(
          and(
            eq(schema.marketplaceListings.id, input.listingId),
            eq(schema.marketplaceListings.status, 'live'),
          ),
        )
        .limit(1);
      if (!row || !row.program) return null;
      const prog = row.program;
      return {
        id: row.id,
        productId: row.productId,
        productSlug: row.productSlug,
        workspaceName: (row.workspaceName ?? row.workspaceNameFallback) || 'Anônimo',
        category: row.category as z.infer<typeof Category>,
        headline: row.headline,
        pitch: row.pitch,
        coverImageUrl: row.coverImageUrl,
        salesPageUrl: row.salesPageUrl ?? null,
        priceCents: Number(row.priceCents ?? 0),
        currency: row.currency,
        publishedAt: row.publishedAt,
        defaultProgramId: prog.id,
        approvalPolicy: prog.approval_policy,
        commissionType: prog.commission_type,
        commissionPercent: prog.commission_percent,
        commissionFlatCents:
          prog.commission_flat_cents == null ? null : Number(prog.commission_flat_cents),
        recurringCycleLimit: prog.recurring_cycle_limit,
        refundWindowDays: prog.refund_window_days,
        attributionWindowDays: prog.attribution_window_days,
      };
    }),

  /**
   * Click tracker. Fires from the public listing card / detail page.
   * Idempotent by (listing, day, ip-hash) thanks to the unique
   * constraint — only the FIRST hit of the day per IP counts.
   */
  recordClick: publicProcedure
    .input(
      z.object({
        listingId: z.string().uuid(),
        referrer: z.string().max(240).optional(),
        utm: z.record(z.string(), z.string()).optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const ip =
        ctx.honoCtx.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
        ctx.honoCtx.req.header('x-real-ip')?.trim() ??
        'unknown';
      const ipHash = createHash('sha256')
        .update(`${ip}|${ctx.services.env.AUTH_SECRET}`)
        .digest('hex')
        .slice(0, 32);
      const today = new Date().toISOString().slice(0, 10);
      await ctx.services.db.db
        .insert(schema.marketplaceClicks)
        .values({
          listingId: input.listingId,
          clickDate: today,
          ipHash,
          referrer: input.referrer ?? null,
          utm: input.utm ?? {},
        })
        .onConflictDoNothing({
          target: [
            schema.marketplaceClicks.listingId,
            schema.marketplaceClicks.clickDate,
            schema.marketplaceClicks.ipHash,
          ],
        });
      return { ok: true as const };
    }),

  /* ============================= PRODUCER ============================ */

  listMine: workspaceProcedure.output(z.array(ProducerListing)).query(async ({ ctx }) => {
    // `salesPageUrl` was added by migration 0020. Production deploys
    // that ran the new app code BEFORE the migration applied would
    // crash the entire query with `column "sales_page_url" does not
    // exist`, wiping every listing from the producer dashboard. The
    // shared `hasSalesPageColumn` helper memoises a one-shot probe so
    // we skip the column from the SELECT when the migration hasn't
    // applied yet. The result schema still emits `salesPageUrl: null`
    // so the client contract holds.
    const salesPageColExists = await hasSalesPageColumn(ctx.services.db.db);

    const baseSelect = {
      id: schema.marketplaceListings.id,
      productId: schema.marketplaceListings.productId,
      status: schema.marketplaceListings.status,
      category: schema.marketplaceListings.category,
      headline: schema.marketplaceListings.headline,
      pitch: schema.marketplaceListings.pitch,
      coverImageUrl: schema.marketplaceListings.coverImageUrl,
      searchKeywords: schema.marketplaceListings.searchKeywords,
      cachedClicks: schema.marketplaceListings.cachedClicks,
      cachedPurchases: schema.marketplaceListings.cachedPurchases,
      publishedAt: schema.marketplaceListings.publishedAt,
      moderationNote: schema.marketplaceListings.moderationNote,
    } as const;
    const rows = salesPageColExists
      ? await ctx.services.db.db
          .select({ ...baseSelect, salesPageUrl: schema.marketplaceListings.salesPageUrl })
          .from(schema.marketplaceListings)
          .where(eq(schema.marketplaceListings.workspaceId, ctx.workspaceId))
          .orderBy(desc(schema.marketplaceListings.publishedAt))
      : (
          await ctx.services.db.db
            .select(baseSelect)
            .from(schema.marketplaceListings)
            .where(eq(schema.marketplaceListings.workspaceId, ctx.workspaceId))
            .orderBy(desc(schema.marketplaceListings.publishedAt))
        ).map((r) => ({ ...r, salesPageUrl: null as string | null }));
    // Self-heal: every dashboard visit to /marketplace ensures the
    // workspace has a default affiliate program so the producer's
    // listings remain discoverable in /afiliar. Idempotent — the
    // helper short-circuits when a program already exists, so this
    // is one indexed lookup per page load.
    if (rows.some((r) => r.status === 'live')) {
      await ensureDefaultAffiliateProgram(ctx.services.db.db, ctx.workspaceId);
    }
    // Pull product-scoped affiliate program for each listing in one
    // round-trip so the producer's listings table can show the actual
    // commission terms the affiliate sees on /afiliar.
    const productIds = rows.map((r) => r.productId);
    const programs = productIds.length
      ? await ctx.services.db.db
          .select({
            id: schema.affiliatePrograms.id,
            productId: schema.affiliatePrograms.productId,
            approvalPolicy: schema.affiliatePrograms.approvalPolicy,
            commissionType: schema.affiliatePrograms.commissionType,
            commissionPercent: schema.affiliatePrograms.commissionPercent,
            commissionFlatCents: schema.affiliatePrograms.commissionFlatCents,
            recurringCycleLimit: schema.affiliatePrograms.recurringCycleLimit,
            refundWindowDays: schema.affiliatePrograms.refundWindowDays,
            attributionWindowDays: schema.affiliatePrograms.attributionWindowDays,
          })
          .from(schema.affiliatePrograms)
          .where(
            and(
              eq(schema.affiliatePrograms.workspaceId, ctx.workspaceId),
              inArray(schema.affiliatePrograms.productId, productIds),
            ),
          )
      : [];
    const programByProduct = new Map(programs.map((p) => [p.productId, p]));

    return rows.map((r) => {
      const p = programByProduct.get(r.productId);
      return {
        ...r,
        status: r.status as z.infer<typeof Status>,
        category: r.category as z.infer<typeof Category>,
        searchKeywords: r.searchKeywords ?? [],
        salesPageUrl: r.salesPageUrl ?? null,
        commission: p
          ? {
              programId: p.id,
              approvalPolicy: p.approvalPolicy as z.infer<typeof ApprovalPolicy>,
              commissionType: p.commissionType as z.infer<typeof CommissionType>,
              commissionPercent: p.commissionPercent,
              commissionFlatCents:
                p.commissionFlatCents == null ? null : Number(p.commissionFlatCents),
              recurringCycleLimit: p.recurringCycleLimit,
              refundWindowDays: p.refundWindowDays,
              attributionWindowDays: p.attributionWindowDays,
            }
          : null,
      };
    });
  }),

  /**
   * Create / update a listing. Auto-flips to `live` on first publish
   * since v1 doesn't have a manual moderation queue yet.
   *
   * Commission terms (commission %, approval policy, refund/attribution
   * windows, sales-page URL) live on the input alongside the listing
   * fields. The mutation upserts a product-scoped `affiliate_programs`
   * row from those values, so the affiliate-shop card on /afiliar
   * shows the exact commission the producer chose — not the legacy
   * workspace-wide 30% fallback. Producer can later edit via Afiliados
   * → Programs without touching the listing.
   */
  upsert: workspaceProcedure
    .input(
      z
        .object({
          id: z.string().uuid().optional(),
          productId: z.string().uuid(),
          category: Category,
          headline: z.string().trim().min(2).max(160),
          pitch: z.string().trim().max(4000),
          coverImageUrl: z.string().url().nullable().optional(),
          searchKeywords: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
          salesPageUrl: z.string().url().max(500).nullable().optional(),
          commission: z
            .object({
              approvalPolicy: ApprovalPolicy.default('manual'),
              commissionType: CommissionType.default('percent'),
              commissionPercent: z.number().int().min(1).max(90).nullable().optional(),
              commissionFlatCents: z.number().int().min(1).nullable().optional(),
              recurringCycleLimit: z.number().int().min(1).max(60).nullable().optional(),
              refundWindowDays: z.number().int().min(0).max(365).default(30),
              attributionWindowDays: z.number().int().min(1).max(365).default(60),
            })
            .optional(),
        })
        .superRefine((value, ctx) => {
          if (!value.commission) return;
          const c = value.commission;
          if (c.commissionType === 'flat') {
            if (c.commissionFlatCents == null || c.commissionFlatCents <= 0) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['commission', 'commissionFlatCents'],
                message: 'Comissão fixa exige valor em centavos maior que zero.',
              });
            }
          } else if (c.commissionPercent == null) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['commission', 'commissionPercent'],
              message: 'Comissão percentual é obrigatória pra esse modelo.',
            });
          }
        }),
    )
    .output(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Verify the product belongs to this workspace — explicit
      // predicate, no RLS trust.
      const [product] = await ctx.services.db.db
        .select({ id: schema.products.id })
        .from(schema.products)
        .where(
          and(
            eq(schema.products.id, input.productId),
            eq(schema.products.workspaceId, ctx.workspaceId),
            isNull(schema.products.deletedAt),
          ),
        )
        .limit(1);
      if (!product) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Produto não encontrado nesta workspace.',
        });
      }

      let listingId: string;
      if (input.id) {
        await ctx.services.db.db
          .update(schema.marketplaceListings)
          .set({
            category: input.category,
            headline: input.headline,
            pitch: input.pitch,
            coverImageUrl: input.coverImageUrl ?? null,
            searchKeywords: input.searchKeywords,
            salesPageUrl: input.salesPageUrl?.trim() || null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.marketplaceListings.id, input.id),
              eq(schema.marketplaceListings.workspaceId, ctx.workspaceId),
            ),
          );
        listingId = input.id;
      } else {
        const [row] = await ctx.services.db.db
          .insert(schema.marketplaceListings)
          .values({
            workspaceId: ctx.workspaceId,
            productId: input.productId,
            status: 'draft',
            category: input.category,
            headline: input.headline,
            pitch: input.pitch,
            coverImageUrl: input.coverImageUrl ?? null,
            searchKeywords: input.searchKeywords,
            salesPageUrl: input.salesPageUrl?.trim() || null,
          })
          .returning({ id: schema.marketplaceListings.id });
        if (!row) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Falha ao criar listing.',
          });
        }
        listingId = row.id;
      }

      // Sync the product-scoped affiliate program with the commission
      // terms the producer just set. Falls back to a sensible default
      // when commission block is omitted so the workspace-wide
      // fallback still shows the listing on /afiliar.
      await upsertProductAffiliateProgram(ctx.services.db.db, {
        workspaceId: ctx.workspaceId,
        productId: input.productId,
        commission: input.commission ?? {
          approvalPolicy: 'manual',
          commissionType: 'percent',
          commissionPercent: 30,
          refundWindowDays: 30,
          attributionWindowDays: 60,
        },
      });
      // Belt-and-braces — workspace-wide default still gets provisioned
      // in case the producer later removes the product-scoped program.
      await ensureDefaultAffiliateProgram(ctx.services.db.db, ctx.workspaceId);
      return { id: listingId };
    }),

  publish: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.db.db
        .update(schema.marketplaceListings)
        .set({ status: 'live', publishedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(schema.marketplaceListings.id, input.id),
            eq(schema.marketplaceListings.workspaceId, ctx.workspaceId),
            // Only allowed from non-terminal states.
            inArray(schema.marketplaceListings.status, ['draft', 'paused', 'pending_review']),
          ),
        );
      // Auto-provision the workspace's default affiliate program so the
      // newly-live listing shows up in /afiliar (the EXISTS filter on
      // affiliate_programs would otherwise hide it). Idempotent — if the
      // producer already has a workspace-wide program we leave it alone.
      await ensureDefaultAffiliateProgram(ctx.services.db.db, ctx.workspaceId);
      // Outbound webhook: producer integrations subscribed to
      // `marketplace.listing.published` get a hook to sync the public
      // catalog with their own external systems.
      await emitMarketplaceListingEvent(ctx.services, input.id, 'marketplace.listing.published');
      return { ok: true as const };
    }),

  pause: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.db.db
        .update(schema.marketplaceListings)
        .set({ status: 'paused', updatedAt: new Date() })
        .where(
          and(
            eq(schema.marketplaceListings.id, input.id),
            eq(schema.marketplaceListings.workspaceId, ctx.workspaceId),
          ),
        );
      return { ok: true as const };
    }),

  remove: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.db.db
        .delete(schema.marketplaceListings)
        .where(
          and(
            eq(schema.marketplaceListings.id, input.id),
            eq(schema.marketplaceListings.workspaceId, ctx.workspaceId),
          ),
        );
      return { ok: true as const };
    }),
});

/**
 * Idempotent provisioner for the workspace-wide default affiliate
 * program. Called every time a marketplace listing flips to `live`
 * so the EXISTS filter in `browseForAffiliation` finds at least one
 * public+active program for the workspace.
 *
 * Why opt-in defaults (and not workspace-creation hook): the program
 * is only meaningful once the producer has a product worth promoting.
 * Auto-creating on every signup would pollute the catalogue with
 * empty programs from accounts that never publish anything.
 *
 * Concurrency: a partial unique index protects
 * `(workspace_id WHERE product_id IS NULL)`. If two `publish`
 * mutations race, the second insert raises `23505` and we swallow it
 * — the program already exists, which is exactly what we wanted.
 */
async function ensureDefaultAffiliateProgram(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle's typed builder collapses to any once stripped of generics.
  db: any,
  workspaceId: string,
): Promise<void> {
  // 1. Look up the existing workspace-wide program (if any) AND its
  //    public+active state. The browseForAffiliation EXISTS filter
  //    requires both flags true; a program that drifted to private/
  //    inactive would still be skipped, leaving the producer stuck.
  const [existing] = await db
    .select({
      id: schema.affiliatePrograms.id,
      isPublic: schema.affiliatePrograms.isPublic,
      isActive: schema.affiliatePrograms.isActive,
    })
    .from(schema.affiliatePrograms)
    .where(
      and(
        eq(schema.affiliatePrograms.workspaceId, workspaceId),
        isNull(schema.affiliatePrograms.productId),
      ),
    )
    .limit(1);
  if (existing) {
    // 2a. Heal in place: a program that exists but isn't public+active
    //     is treated as drift and flipped on. Producer can later disable
    //     deliberately via the affiliate programs UI; until then, the
    //     marketplace surface depends on this being on.
    const isPublic = existing.isPublic === true;
    const isActive = existing.isActive === true;
    if (!isPublic || !isActive) {
      await db
        .update(schema.affiliatePrograms)
        .set({ isPublic: true, isActive: true, updatedAt: new Date() })
        .where(eq(schema.affiliatePrograms.id, existing.id));
      process.stdout.write(
        `${JSON.stringify({
          level: 'info',
          event: 'affiliate.program.healed',
          workspaceId,
          programId: existing.id,
          wasPublic: isPublic,
          wasActive: isActive,
        })}\n`,
      );
    }
    return;
  }
  // 2b. No program at all — insert the default. Tolerates the race
  //     where two concurrent calls each insert; the partial unique
  //     index catches the second and we swallow the 23505.
  try {
    await db.insert(schema.affiliatePrograms).values({
      workspaceId,
      productId: null,
      name: 'Programa padrão',
      description:
        'Criado automaticamente quando você publicou no marketplace. Edite as regras em Afiliados → Programas.',
      approvalPolicy: 'manual',
      isPublic: true,
      isActive: true,
      commissionType: 'percent',
      commissionPercent: 30,
      refundWindowDays: 30,
      attributionWindowDays: 60,
    });
    process.stdout.write(
      `${JSON.stringify({
        level: 'info',
        event: 'affiliate.program.provisioned',
        workspaceId,
      })}\n`,
    );
  } catch (cause) {
    if ((cause as { code?: string })?.code !== '23505') throw cause;
  }
}

/**
 * Sync the product-scoped affiliate program with the commission terms
 * the producer set on a marketplace listing. UPSERT semantics:
 *   - If a program already exists for (workspace, product), patch it
 *     in place (producer is just adjusting their published terms).
 *   - Otherwise insert a fresh program.
 *
 * `is_public = true` + `is_active = true` always — the producer made
 * a deliberate publish move; they can toggle off later via Afiliados →
 * Programs without losing the row.
 */
interface UpsertCommissionInput {
  approvalPolicy: 'automatic' | 'manual' | 'invite_only';
  commissionType: 'percent' | 'flat' | 'recurring' | 'lifetime';
  commissionPercent?: number | null;
  commissionFlatCents?: number | null;
  recurringCycleLimit?: number | null;
  refundWindowDays: number;
  attributionWindowDays: number;
}

async function upsertProductAffiliateProgram(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle's typed builder collapses to any once stripped of generics.
  db: any,
  args: {
    workspaceId: string;
    productId: string;
    commission: UpsertCommissionInput;
  },
): Promise<void> {
  const c = args.commission;
  const [existing] = await db
    .select({ id: schema.affiliatePrograms.id })
    .from(schema.affiliatePrograms)
    .where(
      and(
        eq(schema.affiliatePrograms.workspaceId, args.workspaceId),
        eq(schema.affiliatePrograms.productId, args.productId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(schema.affiliatePrograms)
      .set({
        approvalPolicy: c.approvalPolicy,
        commissionType: c.commissionType,
        commissionPercent: c.commissionPercent ?? null,
        commissionFlatCents: c.commissionFlatCents != null ? BigInt(c.commissionFlatCents) : null,
        recurringCycleLimit: c.recurringCycleLimit ?? null,
        refundWindowDays: c.refundWindowDays,
        attributionWindowDays: c.attributionWindowDays,
        isPublic: true,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(schema.affiliatePrograms.id, existing.id));
    return;
  }

  await db.insert(schema.affiliatePrograms).values({
    workspaceId: args.workspaceId,
    productId: args.productId,
    name: 'Programa do produto',
    description: 'Termos de afiliação configurados pelo produtor no marketplace.',
    approvalPolicy: c.approvalPolicy,
    isPublic: true,
    isActive: true,
    commissionType: c.commissionType,
    commissionPercent: c.commissionPercent ?? null,
    commissionFlatCents: c.commissionFlatCents != null ? BigInt(c.commissionFlatCents) : null,
    recurringCycleLimit: c.recurringCycleLimit ?? null,
    refundWindowDays: c.refundWindowDays,
    attributionWindowDays: c.attributionWindowDays,
  });
}
