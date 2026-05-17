import { schema, withWorkspace } from '@payunivercart/db';
import { mintProductSlug, slugify } from '@payunivercart/shared';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc';

/**
 * Product catalog router. Multi-tenant by construction: every read and
 * write runs inside `withWorkspace(...)` so the RLS policy on
 * `products` / `product_offers` filters to the caller's workspace.
 *
 * Block 20 scope: a single default offer per product. Multiple offers,
 * categories, and coupons land in dedicated procedures later — the
 * tables already exist; only the surface is intentionally narrow here
 * to keep the producer's first "create product" experience under 30
 * seconds.
 */

const ProductType = z.enum(['one_time', 'subscription', 'course', 'physical']);
const Currency = z.enum(['BRL', 'USD', 'EUR']);

const ProductRow = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  type: ProductType,
  coverImageUrl: z.string().nullable(),
  isActive: z.boolean(),
  priceCents: z.number().int().nonnegative(),
  currency: Currency,
  maxInstallments: z.number().int().min(1).max(24),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const POSTGRES_UNIQUE_VIOLATION = '23505';
const MAX_SLUG_RETRIES = 3;

export const productsRouter = router({
  /**
   * Active (non-archived) products in the workspace, newest first.
   * The default offer is joined inline so the dashboard can render a
   * price column without a second round-trip.
   */
  list: workspaceProcedure.output(z.array(ProductRow)).query(async ({ ctx }) => {
    return withWorkspace(ctx.services.db.db, ctx.workspaceId, async (tx) => {
      // Defense-in-depth: we filter by `workspaceId` in the query itself
      // even though `withWorkspace` already set the RLS context. The api
      // process currently connects as a Postgres role that bypasses RLS
      // (the bundled docker-compose Postgres uses POSTGRES_USER as a
      // superuser), so the policy is dormant. An explicit predicate keeps
      // every query tenant-scoped regardless of role privileges. The
      // role-hardening block will switch to a non-BYPASSRLS role and
      // RLS becomes the second wall; until then it's the only wall.
      const rows = await tx
        .select({
          id: schema.products.id,
          slug: schema.products.slug,
          name: schema.products.name,
          description: schema.products.description,
          type: schema.products.type,
          coverImageUrl: schema.products.coverImageUrl,
          isActive: schema.products.isActive,
          createdAt: schema.products.createdAt,
          updatedAt: schema.products.updatedAt,
          priceCents: schema.productOffers.amountCents,
          currency: schema.productOffers.currency,
          maxInstallments: schema.productOffers.maxInstallments,
        })
        .from(schema.products)
        .leftJoin(
          schema.productOffers,
          and(
            eq(schema.productOffers.productId, schema.products.id),
            eq(schema.productOffers.isDefault, true),
          ),
        )
        .where(
          and(
            eq(schema.products.workspaceId, ctx.workspaceId),
            isNull(schema.products.deletedAt),
          ),
        )
        .orderBy(desc(schema.products.createdAt));

      return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        type: r.type,
        coverImageUrl: r.coverImageUrl,
        isActive: r.isActive,
        priceCents: r.priceCents != null ? Number(r.priceCents) : 0,
        currency: r.currency ?? 'BRL',
        maxInstallments: r.maxInstallments ?? 12,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    });
  }),

  /**
   * Create a product + default offer in a single transaction. Slug is
   * generated from the name; on the rare collision we retry with a
   * fresh 4-hex suffix up to MAX_SLUG_RETRIES times.
   */
  create: workspaceProcedure
    .input(
      z.object({
        name: z.string().trim().min(1, 'Nome obrigatório').max(120),
        description: z.string().trim().max(2000).optional(),
        type: ProductType.default('one_time'),
        priceCents: z.number().int().nonnegative().max(10_000_000),
        currency: Currency.default('BRL'),
        maxInstallments: z.number().int().min(1).max(24).default(12),
      }),
    )
    .output(z.object({ id: z.string().uuid(), slug: z.string() }))
    .mutation(async ({ ctx, input }) => {
      for (let attempt = 0; attempt < MAX_SLUG_RETRIES; attempt++) {
        const candidateSlug = attempt === 0 ? slugify(input.name) + '-' + randomHexSuffix() : mintProductSlug(input.name);
        try {
          return await withWorkspace(ctx.services.db.db, ctx.workspaceId, async (tx) => {
            const [product] = await tx
              .insert(schema.products)
              .values({
                workspaceId: ctx.workspaceId,
                slug: candidateSlug,
                name: input.name,
                description: input.description ?? null,
                type: input.type,
                isActive: true,
              })
              .returning({ id: schema.products.id, slug: schema.products.slug });
            if (!product) {
              throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'products insert returned no row',
              });
            }
            await tx.insert(schema.productOffers).values({
              productId: product.id,
              workspaceId: ctx.workspaceId,
              name: 'Padrão',
              amountCents: BigInt(input.priceCents),
              currency: input.currency,
              maxInstallments: input.maxInstallments,
              isActive: true,
              isDefault: true,
            });
            return { id: product.id, slug: product.slug };
          });
        } catch (cause) {
          const pgCode = (cause as { code?: string })?.code;
          if (pgCode === POSTGRES_UNIQUE_VIOLATION && attempt < MAX_SLUG_RETRIES - 1) {
            continue;
          }
          throw cause;
        }
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'product slug retries exhausted',
      });
    }),

  /**
   * Patch a product's editable fields. Slug is immutable here so any
   * existing checkout link the producer already shared keeps working;
   * a rename does NOT silently break their funnel.
   */
  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(2000).nullable().optional(),
        isActive: z.boolean().optional(),
        priceCents: z.number().int().nonnegative().max(10_000_000).optional(),
        maxInstallments: z.number().int().min(1).max(24).optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await withWorkspace(ctx.services.db.db, ctx.workspaceId, async (tx) => {
        const patch: Record<string, unknown> = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.description !== undefined) patch.description = input.description;
        if (input.isActive !== undefined) patch.isActive = input.isActive;
        // Tenant-scoped predicates on every write — defense-in-depth on
        // top of withWorkspace's RLS context (see list-query comment).
        if (Object.keys(patch).length > 0) {
          await tx
            .update(schema.products)
            .set(patch)
            .where(
              and(
                eq(schema.products.id, input.id),
                eq(schema.products.workspaceId, ctx.workspaceId),
              ),
            );
        }
        if (input.priceCents !== undefined || input.maxInstallments !== undefined) {
          const offerPatch: Record<string, unknown> = {};
          if (input.priceCents !== undefined) offerPatch.amountCents = BigInt(input.priceCents);
          if (input.maxInstallments !== undefined) offerPatch.maxInstallments = input.maxInstallments;
          await tx
            .update(schema.productOffers)
            .set(offerPatch)
            .where(
              and(
                eq(schema.productOffers.productId, input.id),
                eq(schema.productOffers.workspaceId, ctx.workspaceId),
                eq(schema.productOffers.isDefault, true),
              ),
            );
        }
      });
      return { ok: true as const };
    }),

  /**
   * Soft-delete via `deleted_at` timestamp. Keeps order history
   * referentially valid (orders point at products that may have been
   * archived).
   */
  archive: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await withWorkspace(ctx.services.db.db, ctx.workspaceId, async (tx) => {
        await tx
          .update(schema.products)
          .set({ deletedAt: new Date(), isActive: false })
          .where(
            and(
              eq(schema.products.id, input.id),
              eq(schema.products.workspaceId, ctx.workspaceId),
            ),
          );
      });
      return { ok: true as const };
    }),
});

/** 4-char hex suffix from `crypto.randomUUID()`. Inline to avoid a
 * dependency cycle on @payunivercart/shared's randomSlugSuffix from
 * a server module that's already importing slugify.
 */
function randomHexSuffix(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 4);
}
