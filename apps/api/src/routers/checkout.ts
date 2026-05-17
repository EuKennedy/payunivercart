import { schema } from '@payunivercart/db';
import { normalizePhone, validateCnpj, validateCpf } from '@payunivercart/shared';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { publicProcedure, router } from '../trpc';

/**
 * Public checkout router — runs without auth, never returns rows from
 * outside the requested product's workspace.
 *
 * The tRPC procedures are PUBLIC because buyers are anonymous. Tenant
 * isolation is enforced by resolving the workspaceId from the product
 * row (the request only carries the public slug) and constraining every
 * subsequent insert (order, transaction) to that workspaceId.
 *
 * Block 21 scope: returns product data for the page and creates an
 * order + transaction in `pending` status with a deterministic public
 * reference. Real gateway calls land in Block 22; until then the
 * `createOrder` mutation returns the order id + reference so the buyer
 * sees a "processing" confirmation screen.
 */

const SlugSchema = z.string().min(3).max(80);

const ProductPublicShape = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.enum(['one_time', 'subscription', 'course', 'physical']),
  priceCents: z.number().int().nonnegative(),
  currency: z.enum(['BRL', 'USD', 'EUR']),
  maxInstallments: z.number().int().min(1).max(24),
});

const WorkspacePublicShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  brandLogoUrl: z.string().nullable(),
  brandPrimaryColor: z.string().nullable(),
});

const BuyerInput = z.object({
  name: z.string().trim().min(2, 'Informe seu nome completo.').max(120),
  email: z.string().email('Email inválido.').max(160),
  document: z.string().trim().min(11, 'CPF ou CNPJ obrigatório.').max(20),
  phone: z.string().trim().min(8, 'Telefone obrigatório.').max(20),
});

const PaymentMethod = z.enum(['pix', 'credit_card', 'boleto']);

export const checkoutRouter = router({
  /**
   * Public product lookup. Returns the product + its default offer +
   * workspace branding (logo, primary color, name) so the page can
   * render the producer's identity above the form.
   *
   * No auth, no tenant context — slug uniqueness is per-workspace but
   * we accept ambiguity is impossible in practice (4-hex suffix makes
   * collisions vanishingly rare; and the very first matching row wins).
   */
  getBySlug: publicProcedure
    .input(z.object({ slug: SlugSchema }))
    .output(
      z.object({
        product: ProductPublicShape,
        workspace: WorkspacePublicShape,
      }),
    )
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.services.db.db
        .select({
          productId: schema.products.id,
          slug: schema.products.slug,
          name: schema.products.name,
          description: schema.products.description,
          type: schema.products.type,
          isActive: schema.products.isActive,
          deletedAt: schema.products.deletedAt,
          workspaceId: schema.workspaces.id,
          workspaceName: schema.workspaces.name,
          workspaceLogo: schema.workspaces.brandLogoUrl,
          workspaceColor: schema.workspaces.brandPrimaryColor,
          priceCents: schema.productOffers.amountCents,
          currency: schema.productOffers.currency,
          maxInstallments: schema.productOffers.maxInstallments,
        })
        .from(schema.products)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.products.workspaceId))
        .leftJoin(
          schema.productOffers,
          and(
            eq(schema.productOffers.productId, schema.products.id),
            eq(schema.productOffers.isDefault, true),
          ),
        )
        .where(and(eq(schema.products.slug, input.slug), isNull(schema.products.deletedAt)))
        .limit(1);

      if (!row || !row.isActive) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Produto indisponível.',
        });
      }
      if (row.priceCents == null) {
        // Default offer missing — defensively reject; the dashboard form
        // always creates one alongside the product so this would only
        // happen for accounts created outside the public flow.
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Produto indisponível.',
        });
      }

      return {
        product: {
          id: row.productId,
          slug: row.slug,
          name: row.name,
          description: row.description,
          type: row.type,
          priceCents: Number(row.priceCents),
          currency: row.currency ?? 'BRL',
          maxInstallments: row.maxInstallments ?? 12,
        },
        workspace: {
          id: row.workspaceId,
          name: row.workspaceName,
          brandLogoUrl: row.workspaceLogo,
          brandPrimaryColor: row.workspaceColor,
        },
      };
    }),

  /**
   * Place an order. Creates an `orders` row + `transactions` row in a
   * single transaction. The transaction starts in `pending` status; a
   * real gateway integration (Block 22) will later populate
   * `gatewayChargeId`, `pixQrCode`, `pixCopyPaste`, `boletoUrl`, etc.
   * For now we return the order's public reference so the buyer sees
   * a "compra recebida" confirmation.
   */
  createOrder: publicProcedure
    .input(
      z.object({
        slug: SlugSchema,
        buyer: BuyerInput,
        method: PaymentMethod,
        installments: z.number().int().min(1).max(24).optional(),
      }),
    )
    .output(
      z.object({
        orderId: z.string().uuid(),
        publicReference: z.string(),
        status: z.string(),
        method: PaymentMethod,
        amountCents: z.number().int().nonnegative(),
        currency: z.enum(['BRL', 'USD', 'EUR']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // 1. Validate document (CPF or CNPJ — accept either).
      const docDigits = validateCpf(input.buyer.document) ?? validateCnpj(input.buyer.document);
      if (!docDigits) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'CPF ou CNPJ inválido.',
        });
      }

      // 2. Validate phone (BR-default; international DDI honored if provided).
      let phone;
      try {
        phone = normalizePhone(input.buyer.phone);
      } catch (cause) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Telefone inválido.',
          cause,
        });
      }
      if (!phone.valid) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Telefone inválido.',
        });
      }

      // 3. Resolve product + offer + workspace.
      const [productRow] = await ctx.services.db.db
        .select({
          productId: schema.products.id,
          name: schema.products.name,
          workspaceId: schema.workspaces.id,
          priceCents: schema.productOffers.amountCents,
          offerId: schema.productOffers.id,
          currency: schema.productOffers.currency,
          maxInstallments: schema.productOffers.maxInstallments,
          isActive: schema.products.isActive,
          deletedAt: schema.products.deletedAt,
        })
        .from(schema.products)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.products.workspaceId))
        .leftJoin(
          schema.productOffers,
          and(
            eq(schema.productOffers.productId, schema.products.id),
            eq(schema.productOffers.isDefault, true),
          ),
        )
        .where(and(eq(schema.products.slug, input.slug), isNull(schema.products.deletedAt)))
        .limit(1);

      if (!productRow || !productRow.isActive || productRow.priceCents == null) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Produto indisponível.',
        });
      }

      const totalCents = productRow.priceCents;
      const currency = productRow.currency ?? 'BRL';
      const installments =
        input.method === 'credit_card' ? Math.min(input.installments ?? 1, productRow.maxInstallments ?? 1) : 1;

      // 4. Insert order + transaction atomically. Defensive workspaceId
      // predicate is implicit here since we only write rows for this
      // exact workspace; on rollback the tx undoes everything.
      const publicReference = mintOrderReference();
      const idempotencyKey = globalThis.crypto.randomUUID();

      const result = await ctx.services.db.db.transaction(async (tx) => {
        const [order] = await tx
          .insert(schema.orders)
          .values({
            workspaceId: productRow.workspaceId,
            publicReference,
            status: 'pending_payment',
            customerName: input.buyer.name,
            customerEmail: input.buyer.email.toLowerCase(),
            customerDocument: docDigits,
            customerPhoneRaw: phone.raw,
            customerPhoneE164: phone.e164,
            customerWahaChatId: phone.guessedWahaChatId,
            subtotalCents: totalCents,
            totalCents,
            currency,
          })
          .returning({ id: schema.orders.id });

        if (!order) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'orders insert returned no row',
          });
        }

        await tx.insert(schema.orderItems).values({
          orderId: order.id,
          productId: productRow.productId,
          offerId: productRow.offerId,
          name: productRow.name,
          quantity: 1,
          unitAmountCents: totalCents,
          totalCents,
        });

        await tx.insert(schema.transactions).values({
          workspaceId: productRow.workspaceId,
          orderId: order.id,
          // Stub gateway choice — Block 22 selects per-workspace from
          // gateway_credentials. mercadopago is the placeholder so the
          // transactions row satisfies the NOT-NULL constraint.
          gatewayId: 'mercadopago',
          method: input.method,
          status: 'pending',
          amountCents: totalCents,
          currency,
          installments: input.method === 'credit_card' ? installments : null,
          idempotencyKey,
        });

        return { orderId: order.id };
      });

      return {
        orderId: result.orderId,
        publicReference,
        status: 'pending_payment',
        method: input.method,
        amountCents: Number(totalCents),
        currency,
      };
    }),
});

/**
 * Mint a human-friendly public reference: `UNV-<8 uppercase chars>`.
 * Long enough that brute-force lookups are infeasible at the buyer's
 * support-ticket scale; short enough to dictate by phone.
 */
function mintOrderReference(): string {
  const random = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return `UNV-${random}`;
}
