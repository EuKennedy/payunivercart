import { createHash } from 'node:crypto';
import { schema } from '@payunivercart/db';
import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { publicProcedure, router, workspaceProcedure } from '../trpc';

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

const ProducerListing = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  status: Status,
  category: Category,
  headline: z.string(),
  pitch: z.string(),
  coverImageUrl: z.string().nullable(),
  searchKeywords: z.array(z.string()),
  cachedClicks: z.number().int().nonnegative(),
  cachedPurchases: z.number().int().nonnegative(),
  publishedAt: z.date().nullable(),
  moderationNote: z.string().nullable(),
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
          priceCents: schema.productOffers.amountCents,
          currency: schema.productOffers.currency,
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
        // Default offer of the product — gives us price + currency
        // without joining all offers. `isDefault` is guaranteed unique
        // per product by the products router.
        .innerJoin(
          schema.productOffers,
          and(
            eq(schema.productOffers.productId, schema.products.id),
            eq(schema.productOffers.isDefault, true),
          ),
        )
        .where(where)
        .limit(limit + 1);

      // Add the order clause matching the sort bucket.
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
              asc(schema.productOffers.amountCents),
              desc(schema.marketplaceListings.id),
            );
          case 'price_hi':
            return baseQuery.orderBy(
              desc(schema.productOffers.amountCents),
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
          priceCents: schema.productOffers.amountCents,
          currency: schema.productOffers.currency,
          publishedAt: schema.marketplaceListings.publishedAt,
        })
        .from(schema.marketplaceListings)
        .innerJoin(schema.products, eq(schema.products.id, schema.marketplaceListings.productId))
        .innerJoin(
          schema.workspaces,
          eq(schema.workspaces.id, schema.marketplaceListings.workspaceId),
        )
        .innerJoin(
          schema.productOffers,
          and(
            eq(schema.productOffers.productId, schema.products.id),
            eq(schema.productOffers.isDefault, true),
          ),
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
    const rows = await ctx.services.db.db
      .select({
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
      })
      .from(schema.marketplaceListings)
      .where(eq(schema.marketplaceListings.workspaceId, ctx.workspaceId))
      .orderBy(desc(schema.marketplaceListings.publishedAt));
    return rows.map((r) => ({
      ...r,
      status: r.status as z.infer<typeof Status>,
      category: r.category as z.infer<typeof Category>,
      searchKeywords: r.searchKeywords ?? [],
    }));
  }),

  /**
   * Create / update a listing. Auto-flips to `live` on first publish
   * since v1 doesn't have a manual moderation queue yet.
   */
  upsert: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid().optional(),
        productId: z.string().uuid(),
        category: Category,
        headline: z.string().trim().min(2).max(160),
        pitch: z.string().trim().max(4000),
        coverImageUrl: z.string().url().nullable().optional(),
        searchKeywords: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
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

      if (input.id) {
        await ctx.services.db.db
          .update(schema.marketplaceListings)
          .set({
            category: input.category,
            headline: input.headline,
            pitch: input.pitch,
            coverImageUrl: input.coverImageUrl ?? null,
            searchKeywords: input.searchKeywords,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.marketplaceListings.id, input.id),
              eq(schema.marketplaceListings.workspaceId, ctx.workspaceId),
            ),
          );
        return { id: input.id };
      }

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
        })
        .returning({ id: schema.marketplaceListings.id });
      if (!row) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Falha ao criar listing.',
        });
      }
      return { id: row.id };
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
