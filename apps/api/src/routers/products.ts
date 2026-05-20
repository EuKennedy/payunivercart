import { schema, withWorkspace } from '@payunivercart/db';
import { mintProductSlug, slugify } from '@payunivercart/shared';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc';

/**
 * Cover image caps mirror the workspace logo policy. 2 MB is plenty
 * for a 1:1 hero image at retina resolution once compressed; the
 * client UI enforces JPEG ≤ 90 quality before encoding to base64.
 */
const MAX_COVER_BYTES = 2 * 1024 * 1024;
const ACCEPTED_COVER_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

const CoverUploadInput = z.object({
  base64: z.string().min(1),
  mime: z.string(),
});

function decodeCover(input: z.infer<typeof CoverUploadInput>): {
  bytes: Uint8Array;
  mime: string;
} {
  if (!ACCEPTED_COVER_MIME.has(input.mime)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Capa deve ser PNG, JPEG ou WEBP.',
    });
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(input.base64, 'base64'));
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Não foi possível decodificar a capa enviada.',
    });
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_COVER_BYTES) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Capa deve ter entre 1 byte e ${MAX_COVER_BYTES / 1024 / 1024} MB.`,
    });
  }
  return { bytes, mime: input.mime };
}

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
  hasCover: z.boolean(),
  coverMime: z.string().nullable(),
  isActive: z.boolean(),
  priceCents: z.number().int().nonnegative(),
  currency: Currency,
  maxInstallments: z.number().int().min(1).max(24),
  deliveryUrl: z.string().nullable(),
  deliveryInstructions: z.string().nullable(),
  isSubscription: z.boolean(),
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
          coverImageMime: schema.products.coverImageMime,
          deliveryUrl: schema.products.deliveryUrl,
          deliveryInstructions: schema.products.deliveryInstructions,
          isSubscription: schema.products.isSubscription,
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
          and(eq(schema.products.workspaceId, ctx.workspaceId), isNull(schema.products.deletedAt)),
        )
        .orderBy(desc(schema.products.createdAt));

      return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        type: r.type,
        coverImageUrl: r.coverImageUrl,
        hasCover: r.coverImageMime != null,
        coverMime: r.coverImageMime,
        isActive: r.isActive,
        priceCents: r.priceCents != null ? Number(r.priceCents) : 0,
        currency: r.currency ?? 'BRL',
        maxInstallments: r.maxInstallments ?? 12,
        deliveryUrl: r.deliveryUrl,
        deliveryInstructions: r.deliveryInstructions,
        isSubscription: r.isSubscription,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    });
  }),

  /**
   * Fetch one product (by id) with its default offer + cover metadata.
   * Used by the edit page to pre-fill the form. The cover bytes are NOT
   * returned here — the UI references them via the public
   * `/api/img/product/:id/cover` route.
   */
  byId: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(ProductRow.nullable())
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.services.db.db
        .select({
          id: schema.products.id,
          slug: schema.products.slug,
          name: schema.products.name,
          description: schema.products.description,
          type: schema.products.type,
          coverImageUrl: schema.products.coverImageUrl,
          coverImageMime: schema.products.coverImageMime,
          deliveryUrl: schema.products.deliveryUrl,
          deliveryInstructions: schema.products.deliveryInstructions,
          isSubscription: schema.products.isSubscription,
          isActive: schema.products.isActive,
          createdAt: schema.products.createdAt,
          updatedAt: schema.products.updatedAt,
          deletedAt: schema.products.deletedAt,
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
          and(eq(schema.products.id, input.id), eq(schema.products.workspaceId, ctx.workspaceId)),
        )
        .limit(1);
      if (!row || row.deletedAt) return null;
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        type: row.type,
        coverImageUrl: row.coverImageUrl,
        hasCover: row.coverImageMime != null,
        coverMime: row.coverImageMime,
        isActive: row.isActive,
        priceCents: row.priceCents != null ? Number(row.priceCents) : 0,
        currency: row.currency ?? 'BRL',
        maxInstallments: row.maxInstallments ?? 12,
        deliveryUrl: row.deliveryUrl,
        deliveryInstructions: row.deliveryInstructions,
        isSubscription: row.isSubscription,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    }),

  /**
   * Create a product + default offer in a single transaction. Slug is
   * generated from the name; on the rare collision we retry with a
   * fresh 4-hex suffix up to MAX_SLUG_RETRIES times. The cover image
   * is required so the public checkout never has to render a missing
   * hero — producers see the upload field on the create form and the
   * tRPC input enforces the same invariant on the wire.
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
        cover: CoverUploadInput,
      }),
    )
    .output(z.object({ id: z.string().uuid(), slug: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { bytes: coverBytes, mime: coverMime } = decodeCover(input.cover);
      for (let attempt = 0; attempt < MAX_SLUG_RETRIES; attempt++) {
        const candidateSlug =
          attempt === 0
            ? `${slugify(input.name)}-${randomHexSuffix()}`
            : mintProductSlug(input.name);
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
                coverImage: coverBytes,
                coverImageMime: coverMime,
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
        /**
         * Cover image patch. `undefined` leaves the column untouched —
         * the dashboard edit form omits this field when the producer
         * didn't pick a new file. Pass an object to replace; the
         * mandatory-on-create rule means we never need a clear-cover
         * path (a product without a cover wouldn't be allowed to exist
         * in the first place).
         */
        cover: CoverUploadInput.optional(),
        /**
         * Post-purchase delivery. URL is the link the buyer receives by
         * email + WhatsApp the moment the gateway confirms payment;
         * instructions render alongside it. Pass `null` to clear the
         * column, `undefined` to leave it untouched.
         */
        deliveryUrl: z.string().trim().max(500).nullable().optional(),
        deliveryInstructions: z.string().trim().max(1000).nullable().optional(),
        /**
         * Flip the product between one-time purchase and recurring
         * subscription. Plans live in their own router (`subscriptions.*`)
         * — toggling here only sets the catalogue flag.
         */
        isSubscription: z.boolean().optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await withWorkspace(ctx.services.db.db, ctx.workspaceId, async (tx) => {
        const patch: Record<string, unknown> = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.description !== undefined) patch.description = input.description;
        if (input.isActive !== undefined) patch.isActive = input.isActive;
        if (input.deliveryUrl !== undefined) patch.deliveryUrl = input.deliveryUrl;
        if (input.deliveryInstructions !== undefined)
          patch.deliveryInstructions = input.deliveryInstructions;
        if (input.isSubscription !== undefined) patch.isSubscription = input.isSubscription;
        if (input.cover !== undefined) {
          const { bytes, mime } = decodeCover(input.cover);
          patch.coverImage = bytes;
          patch.coverImageMime = mime;
        }
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
          if (input.maxInstallments !== undefined)
            offerPatch.maxInstallments = input.maxInstallments;
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
            and(eq(schema.products.id, input.id), eq(schema.products.workspaceId, ctx.workspaceId)),
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
