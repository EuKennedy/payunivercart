import { schema, withWorkspace } from '@payunivercart/db';
import {
  CHECKOUT_BANNER_TYPES,
  CHECKOUT_TIMER_DISCOUNT_TYPES,
  CHECKOUT_TIMER_EXPIRED_BEHAVIORS,
  mintProductSlug,
  slugify,
} from '@payunivercart/shared';
import type { CheckoutBannerType, CheckoutTimerDiscountType } from '@payunivercart/shared';
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
/**
 * Banners are wide but low-detail; 1 MiB of WEBP is generous at
 * 1600px. Deliberately BELOW the cover cap because a single
 * `products.update` can legitimately carry cover + desktop banner +
 * mobile banner in ONE JSON body, and base64 inflates ~33% — no
 * `bodyLimit` middleware is registered on the Hono app, so these
 * per-field caps are the only backstop on the parsed payload.
 */
const MAX_BANNER_BYTES = 1 * 1024 * 1024;
/**
 * Never widen this to `image/svg+xml`. The MIME is client-asserted
 * (we do no magic-byte sniff) and is echoed back verbatim as the
 * `Content-Type` of a public `/img/*` route, so an SVG upload is a
 * stored-XSS primitive on a payment page.
 */
const ACCEPTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

const CoverUploadInput = z.object({
  base64: z.string().min(1),
  mime: z.string(),
});

/**
 * Decode one base64 upload into bytes + a validated MIME. Shared by
 * all three image slots on a product (cover, desktop banner, mobile
 * banner), which differ only in their byte ceiling and in the noun
 * the producer sees when it fails — `update` can carry all three at
 * once, so a message that doesn't name the offending slot is useless.
 */
function decodeImage(
  input: z.infer<typeof CoverUploadInput>,
  opts: { maxBytes: number; label: string },
): { bytes: Uint8Array; mime: string } {
  if (!ACCEPTED_IMAGE_MIME.has(input.mime)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `${opts.label} deve ser PNG, JPEG ou WEBP.`,
    });
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(input.base64, 'base64'));
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Não foi possível decodificar o arquivo enviado (${opts.label}).`,
    });
  }
  if (bytes.byteLength === 0 || bytes.byteLength > opts.maxBytes) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `${opts.label} deve ter entre 1 byte e ${opts.maxBytes / 1024 / 1024} MB.`,
    });
  }
  return { bytes, mime: input.mime };
}

/** Cover slot. Thin wrapper so `create`'s mandatory-cover path reads
 *  exactly as it did before the banner slots existed. */
function decodeCover(input: z.infer<typeof CoverUploadInput>): {
  bytes: Uint8Array;
  mime: string;
} {
  return decodeImage(input, { maxBytes: MAX_COVER_BYTES, label: 'Capa' });
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
  // --- checkout appearance (per-product) ---
  // Mirrors the 18 `checkout_*` columns minus the two bytea slots: the
  // edit form only needs to know whether an image EXISTS, and the
  // public `/img/product/:id/banner*` routes serve the bytes. Selecting
  // a bytea into this projection would stream the full image through
  // Postgres and the tRPC JSON envelope on every product list.
  checkoutTimerEnabled: z.boolean(),
  checkoutTimerMinutes: z.number().int().min(1).max(1440),
  checkoutTimerMessage: z.string().nullable(),
  checkoutTimerExpiredBehavior: z.enum(CHECKOUT_TIMER_EXPIRED_BEHAVIORS),
  checkoutTimerExpiredMessage: z.string().nullable(),
  checkoutTimerDiscountType: z.enum(CHECKOUT_TIMER_DISCOUNT_TYPES).nullable(),
  checkoutTimerDiscountPercent: z.number().int().min(1).max(90).nullable(),
  checkoutTimerDiscountCents: z.number().int().nonnegative().nullable(),
  checkoutBannerEnabled: z.boolean(),
  checkoutBannerType: z.enum(CHECKOUT_BANNER_TYPES),
  hasBanner: z.boolean(),
  hasBannerMobile: z.boolean(),
  checkoutBannerText: z.string().nullable(),
  checkoutBannerBgColor: z.string().nullable(),
  checkoutBannerTextColor: z.string().nullable(),
  checkoutBannerLinkUrl: z.string().nullable(),
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
          checkoutTimerEnabled: schema.products.checkoutTimerEnabled,
          checkoutTimerMinutes: schema.products.checkoutTimerMinutes,
          checkoutTimerMessage: schema.products.checkoutTimerMessage,
          checkoutTimerExpiredBehavior: schema.products.checkoutTimerExpiredBehavior,
          checkoutTimerExpiredMessage: schema.products.checkoutTimerExpiredMessage,
          checkoutTimerDiscountType: schema.products.checkoutTimerDiscountType,
          checkoutTimerDiscountPercent: schema.products.checkoutTimerDiscountPercent,
          checkoutTimerDiscountCents: schema.products.checkoutTimerDiscountCents,
          checkoutBannerEnabled: schema.products.checkoutBannerEnabled,
          checkoutBannerType: schema.products.checkoutBannerType,
          // The MIME sentinels stand in for the bytea columns, which are
          // never selected here — same discipline as `coverImageMime`.
          checkoutBannerImageMime: schema.products.checkoutBannerImageMime,
          checkoutBannerImageMobileMime: schema.products.checkoutBannerImageMobileMime,
          checkoutBannerText: schema.products.checkoutBannerText,
          checkoutBannerBgColor: schema.products.checkoutBannerBgColor,
          checkoutBannerTextColor: schema.products.checkoutBannerTextColor,
          checkoutBannerLinkUrl: schema.products.checkoutBannerLinkUrl,
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
        checkoutTimerEnabled: r.checkoutTimerEnabled,
        checkoutTimerMinutes: r.checkoutTimerMinutes,
        checkoutTimerMessage: r.checkoutTimerMessage,
        // The three discriminants are `text()` + CHECK, not pgEnums, so
        // drizzle hands us a plain `string`. Narrow with an explicit
        // ternary instead of a cast: a row written before the CHECK
        // landed — or by a direct UPDATE that bypassed it — must fall
        // into the safe branch rather than smuggle an unknown literal
        // past zod's `.output()` and 500 the producer's product list.
        checkoutTimerExpiredBehavior:
          r.checkoutTimerExpiredBehavior === 'last_chance'
            ? ('last_chance' as const)
            : ('restart' as const),
        checkoutTimerExpiredMessage: r.checkoutTimerExpiredMessage,
        checkoutTimerDiscountType:
          r.checkoutTimerDiscountType === 'percent'
            ? ('percent' as const)
            : r.checkoutTimerDiscountType === 'fixed'
              ? ('fixed' as const)
              : null,
        checkoutTimerDiscountPercent: r.checkoutTimerDiscountPercent,
        // bigint at rest like every other money column; `Number()` only
        // here, at the tRPC boundary.
        checkoutTimerDiscountCents:
          r.checkoutTimerDiscountCents != null ? Number(r.checkoutTimerDiscountCents) : null,
        checkoutBannerEnabled: r.checkoutBannerEnabled,
        checkoutBannerType:
          r.checkoutBannerType === 'text' ? ('text' as const) : ('image' as const),
        hasBanner: r.checkoutBannerImageMime != null,
        hasBannerMobile: r.checkoutBannerImageMobileMime != null,
        checkoutBannerText: r.checkoutBannerText,
        checkoutBannerBgColor: r.checkoutBannerBgColor,
        checkoutBannerTextColor: r.checkoutBannerTextColor,
        checkoutBannerLinkUrl: r.checkoutBannerLinkUrl,
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
          checkoutTimerEnabled: schema.products.checkoutTimerEnabled,
          checkoutTimerMinutes: schema.products.checkoutTimerMinutes,
          checkoutTimerMessage: schema.products.checkoutTimerMessage,
          checkoutTimerExpiredBehavior: schema.products.checkoutTimerExpiredBehavior,
          checkoutTimerExpiredMessage: schema.products.checkoutTimerExpiredMessage,
          checkoutTimerDiscountType: schema.products.checkoutTimerDiscountType,
          checkoutTimerDiscountPercent: schema.products.checkoutTimerDiscountPercent,
          checkoutTimerDiscountCents: schema.products.checkoutTimerDiscountCents,
          checkoutBannerEnabled: schema.products.checkoutBannerEnabled,
          checkoutBannerType: schema.products.checkoutBannerType,
          // The MIME sentinels stand in for the bytea columns, which are
          // never selected here — same discipline as `coverImageMime`.
          checkoutBannerImageMime: schema.products.checkoutBannerImageMime,
          checkoutBannerImageMobileMime: schema.products.checkoutBannerImageMobileMime,
          checkoutBannerText: schema.products.checkoutBannerText,
          checkoutBannerBgColor: schema.products.checkoutBannerBgColor,
          checkoutBannerTextColor: schema.products.checkoutBannerTextColor,
          checkoutBannerLinkUrl: schema.products.checkoutBannerLinkUrl,
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
        // Same explicit-ternary narrowing as `list` — the rationale is
        // spelled out there.
        checkoutTimerEnabled: row.checkoutTimerEnabled,
        checkoutTimerMinutes: row.checkoutTimerMinutes,
        checkoutTimerMessage: row.checkoutTimerMessage,
        checkoutTimerExpiredBehavior:
          row.checkoutTimerExpiredBehavior === 'last_chance'
            ? ('last_chance' as const)
            : ('restart' as const),
        checkoutTimerExpiredMessage: row.checkoutTimerExpiredMessage,
        checkoutTimerDiscountType:
          row.checkoutTimerDiscountType === 'percent'
            ? ('percent' as const)
            : row.checkoutTimerDiscountType === 'fixed'
              ? ('fixed' as const)
              : null,
        checkoutTimerDiscountPercent: row.checkoutTimerDiscountPercent,
        checkoutTimerDiscountCents:
          row.checkoutTimerDiscountCents != null ? Number(row.checkoutTimerDiscountCents) : null,
        checkoutBannerEnabled: row.checkoutBannerEnabled,
        checkoutBannerType:
          row.checkoutBannerType === 'text' ? ('text' as const) : ('image' as const),
        hasBanner: row.checkoutBannerImageMime != null,
        hasBannerMobile: row.checkoutBannerImageMobileMime != null,
        checkoutBannerText: row.checkoutBannerText,
        checkoutBannerBgColor: row.checkoutBannerBgColor,
        checkoutBannerTextColor: row.checkoutBannerTextColor,
        checkoutBannerLinkUrl: row.checkoutBannerLinkUrl,
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
        /** Required for one-time products; ignored when isSubscription
         *  is true (plans own pricing in that case). */
        priceCents: z.number().int().nonnegative().max(10_000_000),
        currency: Currency.default('BRL'),
        maxInstallments: z.number().int().min(1).max(24).default(12),
        cover: CoverUploadInput,
        /** Post-purchase delivery info — wired into the receipt email +
         *  WhatsApp on the paid-event fan-out. Optional. */
        deliveryUrl: z.string().trim().max(500).optional(),
        deliveryInstructions: z.string().trim().max(1000).optional(),
        /** Flip into recurring billing mode. When true, `plans` MUST
         *  carry at least one row; the one-time offer is skipped. */
        isSubscription: z.boolean().default(false),
        plans: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(80),
              billingPeriod: z.enum(['monthly', 'yearly']),
              amountCents: z.number().int().min(100).max(10_000_000),
              trialDays: z.number().int().min(0).max(365).default(0),
              isHighlighted: z.boolean().default(false),
              sortOrder: z.number().int().min(0).max(999).default(0),
            }),
          )
          .optional(),
      }),
    )
    .output(z.object({ id: z.string().uuid(), slug: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (input.isSubscription && (!input.plans || input.plans.length === 0)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Assinatura precisa de pelo menos 1 plano.',
        });
      }
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
                deliveryUrl: input.deliveryUrl ?? null,
                deliveryInstructions: input.deliveryInstructions ?? null,
                isSubscription: input.isSubscription,
                isActive: true,
              })
              .returning({ id: schema.products.id, slug: schema.products.slug });
            if (!product) {
              throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'products insert returned no row',
              });
            }
            // Subscription products skip the legacy single-offer row —
            // the plan picker on /c/<slug> reads from subscription_plans
            // directly. One-time products keep the default offer so
            // existing checkout flows stay untouched.
            if (input.isSubscription && input.plans) {
              await tx.insert(schema.subscriptionPlans).values(
                input.plans.map((p) => ({
                  workspaceId: ctx.workspaceId,
                  productId: product.id,
                  name: p.name,
                  billingPeriod: p.billingPeriod,
                  amountCents: BigInt(p.amountCents),
                  currency: input.currency,
                  trialDays: p.trialDays,
                  isHighlighted: p.isHighlighted,
                  sortOrder: p.sortOrder,
                })),
              );
            } else {
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
            }
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
        /**
         * Checkout appearance — the evergreen scarcity countdown and
         * the promotional top banner. Same tri-state as `deliveryUrl`
         * above: `undefined` leaves the column untouched, `null`
         * clears it.
         *
         * The three discount fields are price-affecting, and they are
         * the ONLY place a number enters that calculation: the public
         * checkout never sends an amount, so whatever a producer saves
         * here is exactly what `createOrder` will subtract. Ranges are
         * mirrored by DB CHECKs — percent stops at 90, not 100,
         * because a full discount produces `amount: 0`, which every
         * gateway rejects AFTER the order row already exists.
         */
        checkoutTimerEnabled: z.boolean().optional(),
        checkoutTimerMinutes: z.number().int().min(1).max(1440).optional(),
        checkoutTimerMessage: z.string().trim().max(120).nullable().optional(),
        checkoutTimerExpiredBehavior: z.enum(CHECKOUT_TIMER_EXPIRED_BEHAVIORS).optional(),
        checkoutTimerExpiredMessage: z.string().trim().max(120).nullable().optional(),
        checkoutTimerDiscountType: z.enum(CHECKOUT_TIMER_DISCOUNT_TYPES).nullable().optional(),
        checkoutTimerDiscountPercent: z.number().int().min(1).max(90).nullable().optional(),
        checkoutTimerDiscountCents: z
          .number()
          .int()
          .nonnegative()
          .max(10_000_000)
          .nullable()
          .optional(),
        checkoutBannerEnabled: z.boolean().optional(),
        checkoutBannerType: z.enum(CHECKOUT_BANNER_TYPES).optional(),
        checkoutBannerImage: CoverUploadInput.nullable().optional(),
        checkoutBannerImageMobile: CoverUploadInput.nullable().optional(),
        checkoutBannerText: z.string().trim().max(200).nullable().optional(),
        checkoutBannerBgColor: z
          .string()
          .trim()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .nullable()
          .optional(),
        checkoutBannerTextColor: z
          .string()
          .trim()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .nullable()
          .optional(),
        /**
         * Deliberately NOT as permissive as `deliveryUrl`. That one is
         * mailed to a buyer who already paid, so its scheme is left to
         * the producer. This one is an anchor rendered on a public
         * payment page to strangers, and `z.string().url()` alone would
         * happily admit `data:` and friends — so https:// or nothing.
         */
        checkoutBannerLinkUrl: z
          .string()
          .trim()
          .max(500)
          .refine((v) => /^https:\/\//i.test(v), 'O link do banner precisa começar com https://')
          .nullable()
          .optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      assertCoherentAppearance(input);
      await withWorkspace(ctx.services.db.db, ctx.workspaceId, async (tx) => {
        const patch: Record<string, unknown> = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.description !== undefined) patch.description = input.description;
        if (input.isActive !== undefined) patch.isActive = input.isActive;
        if (input.deliveryUrl !== undefined) patch.deliveryUrl = input.deliveryUrl;
        if (input.deliveryInstructions !== undefined)
          patch.deliveryInstructions = input.deliveryInstructions;
        if (input.isSubscription !== undefined) patch.isSubscription = input.isSubscription;
        if (input.checkoutTimerEnabled !== undefined)
          patch.checkoutTimerEnabled = input.checkoutTimerEnabled;
        if (input.checkoutTimerMinutes !== undefined)
          patch.checkoutTimerMinutes = input.checkoutTimerMinutes;
        if (input.checkoutTimerMessage !== undefined)
          patch.checkoutTimerMessage = input.checkoutTimerMessage;
        if (input.checkoutTimerExpiredBehavior !== undefined)
          patch.checkoutTimerExpiredBehavior = input.checkoutTimerExpiredBehavior;
        if (input.checkoutTimerExpiredMessage !== undefined)
          patch.checkoutTimerExpiredMessage = input.checkoutTimerExpiredMessage;
        if (input.checkoutTimerDiscountType !== undefined)
          patch.checkoutTimerDiscountType = input.checkoutTimerDiscountType;
        if (input.checkoutTimerDiscountPercent !== undefined)
          patch.checkoutTimerDiscountPercent = input.checkoutTimerDiscountPercent;
        if (input.checkoutTimerDiscountCents !== undefined) {
          // The column is `bigint({ mode: 'bigint' })` like every other
          // money column, but the wire carries a plain number — convert
          // at the boundary, exactly as the offer price does below. A
          // raw number here would be written as-is and blow up the
          // first time `createOrder` does bigint arithmetic on it.
          patch.checkoutTimerDiscountCents =
            input.checkoutTimerDiscountCents === null
              ? null
              : BigInt(input.checkoutTimerDiscountCents);
        }
        if (input.checkoutBannerEnabled !== undefined)
          patch.checkoutBannerEnabled = input.checkoutBannerEnabled;
        if (input.checkoutBannerType !== undefined)
          patch.checkoutBannerType = input.checkoutBannerType;
        if (input.checkoutBannerText !== undefined)
          patch.checkoutBannerText = input.checkoutBannerText;
        if (input.checkoutBannerBgColor !== undefined)
          patch.checkoutBannerBgColor = input.checkoutBannerBgColor;
        if (input.checkoutBannerTextColor !== undefined)
          patch.checkoutBannerTextColor = input.checkoutBannerTextColor;
        if (input.checkoutBannerLinkUrl !== undefined)
          patch.checkoutBannerLinkUrl = input.checkoutBannerLinkUrl;
        if (input.cover !== undefined) {
          const { bytes, mime } = decodeCover(input.cover);
          patch.coverImage = bytes;
          patch.coverImageMime = mime;
        }
        // The banner is optional and removable, so unlike the cover it
        // needs a clear path — `null` wipes bytes AND mime together.
        // The bytes/mime pair is only ever assigned as a pair, which is
        // what keeps the "mime NULL iff bytes NULL" invariant that the
        // public checkout query relies on: it keys the banner URL off
        // the MIME sentinel precisely so it never has to select a bytea
        // on its hottest read path.
        if (input.checkoutBannerImage !== undefined) {
          if (input.checkoutBannerImage === null) {
            patch.checkoutBannerImage = null;
            patch.checkoutBannerImageMime = null;
          } else {
            const { bytes, mime } = decodeImage(input.checkoutBannerImage, {
              maxBytes: MAX_BANNER_BYTES,
              label: 'Banner',
            });
            patch.checkoutBannerImage = bytes;
            patch.checkoutBannerImageMime = mime;
          }
        }
        if (input.checkoutBannerImageMobile !== undefined) {
          if (input.checkoutBannerImageMobile === null) {
            patch.checkoutBannerImageMobile = null;
            patch.checkoutBannerImageMobileMime = null;
          } else {
            const { bytes, mime } = decodeImage(input.checkoutBannerImageMobile, {
              maxBytes: MAX_BANNER_BYTES,
              label: 'Banner mobile',
            });
            patch.checkoutBannerImageMobile = bytes;
            patch.checkoutBannerImageMobileMime = mime;
          }
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

/**
 * Cross-column coherence rules the DB CHECKs cannot express, because a
 * CHECK sees one row while these constraints span two columns that a
 * producer sets together.
 *
 * Judged strictly against THIS request, never against stored state: a
 * discount type and its magnitude must arrive in the same patch. The
 * alternative — reading the row first to fill in whichever half is
 * missing — buys a round-trip and a race for a rule the only caller
 * (the product edit form, which posts every scalar unconditionally)
 * already satisfies. And silently accepting a half-config is the worse
 * failure: `createOrder` would then read `type = 'percent'` with a NULL
 * percent and quietly charge full price while the producer's checkout
 * advertises a discount.
 *
 * A `null` type clears the discount entirely and needs no magnitude,
 * so only the two non-null discriminants are policed. A discount left
 * configured under `restart` is inert rather than incoherent — the
 * server only honours it under `last_chance` — so it is not rejected.
 *
 * Copy mirrors the client-side gate on the edit form; producers should
 * never see these unless something bypassed the UI.
 */
function assertCoherentAppearance(input: {
  checkoutTimerDiscountType?: CheckoutTimerDiscountType | null;
  checkoutTimerDiscountPercent?: number | null;
  checkoutTimerDiscountCents?: number | null;
  checkoutBannerEnabled?: boolean;
  checkoutBannerType?: CheckoutBannerType;
  checkoutBannerText?: string | null;
}): void {
  if (input.checkoutTimerDiscountType === 'percent' && input.checkoutTimerDiscountPercent == null) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Informe a porcentagem do desconto de última chance.',
    });
  }
  if (input.checkoutTimerDiscountType === 'fixed' && input.checkoutTimerDiscountCents == null) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Informe o valor do desconto de última chance.',
    });
  }
  // Only policed when the banner is being left enabled: a producer who
  // switches the type back to `text` on a disabled banner is drafting,
  // not shipping, and the edit form permits exactly that.
  if (
    input.checkoutBannerEnabled === true &&
    input.checkoutBannerType === 'text' &&
    !input.checkoutBannerText?.trim()
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Escreva o texto do banner.',
    });
  }
}

/** 4-char hex suffix from `crypto.randomUUID()`. Inline to avoid a
 * dependency cycle on @payunivercart/shared's randomSlugSuffix from
 * a server module that's already importing slugify.
 */
function randomHexSuffix(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 4);
}
