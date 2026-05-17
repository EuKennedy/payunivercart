import { schema } from '@payunivercart/db';
import { type MercadoPagoCredentials, getAdapter } from '@payunivercart/payments';
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
 * Block 22 wires the real Mercado Pago PIX flow:
 *   - When the workspace has a default mercadopago gateway saved, we
 *     decrypt the credentials and call `createPix`. The returned
 *     `pixQrCode` / `pixCopyPaste` / `pixExpiresAt` are persisted on
 *     the transactions row and returned to the buyer in one round-trip.
 *   - When no gateway is configured, the order + transaction are still
 *     created (in `pending`) so the producer's UX exercises the full
 *     path; the buyer just sees an "estamos gerando" confirmation.
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

const PIX_EXPIRY_SECONDS = 60 * 60; // 1 hour — better conversion than MP's 30-day default.

export const checkoutRouter = router({
  /**
   * Public product lookup. Returns product + default offer + workspace
   * branding so the page can render the producer's identity above the
   * form.
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
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Produto indisponível.' });
      }
      if (row.priceCents == null) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Produto indisponível.' });
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
   * Place an order + open a transaction. Calls the configured gateway
   * inline so the buyer's "Gerar QR-code" click returns the real PIX
   * payload in a single round-trip.
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
        pixQrCode: z.string().nullable(),
        pixQrCodeImage: z.string().nullable(),
        pixCopyPaste: z.string().nullable(),
        pixExpiresAt: z.date().nullable(),
        boletoUrl: z.string().nullable(),
        boletoBarcode: z.string().nullable(),
        gatewayConfigured: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // 1. Validate document (CPF or CNPJ).
      const docDigits = validateCpf(input.buyer.document) ?? validateCnpj(input.buyer.document);
      if (!docDigits) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'CPF ou CNPJ inválido.' });
      }

      // 2. Validate phone.
      let phone;
      try {
        phone = normalizePhone(input.buyer.phone);
      } catch (cause) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Telefone inválido.', cause });
      }
      if (!phone.valid) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Telefone inválido.' });
      }

      // 3. Resolve product + offer + workspace.
      const [productRow] = await ctx.services.db.db
        .select({
          productId: schema.products.id,
          name: schema.products.name,
          description: schema.products.description,
          workspaceId: schema.workspaces.id,
          workspaceName: schema.workspaces.name,
          priceCents: schema.productOffers.amountCents,
          offerId: schema.productOffers.id,
          currency: schema.productOffers.currency,
          maxInstallments: schema.productOffers.maxInstallments,
          isActive: schema.products.isActive,
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
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Produto indisponível.' });
      }

      const totalCents = productRow.priceCents;
      const currency = productRow.currency ?? 'BRL';
      const installments =
        input.method === 'credit_card'
          ? Math.min(input.installments ?? 1, productRow.maxInstallments ?? 1)
          : 1;

      // 4. Look up the workspace's default gateway for this method.
      //    PIX is supported by every adapter — we hard-code mercadopago for
      //    Block 22's MVP and add provider selection in a follow-up block.
      const desiredGatewayId = 'mercadopago';
      const [gatewayRow] = await ctx.services.db.db
        .select({
          id: schema.gatewayCredentials.id,
          gatewayId: schema.gatewayCredentials.gatewayId,
          credentialsEncrypted: schema.gatewayCredentials.credentialsEncrypted,
        })
        .from(schema.gatewayCredentials)
        .where(
          and(
            eq(schema.gatewayCredentials.workspaceId, productRow.workspaceId),
            eq(schema.gatewayCredentials.gatewayId, desiredGatewayId),
            eq(schema.gatewayCredentials.isDefault, true),
          ),
        )
        .limit(1);

      // 5. Create order + items + transaction in pending state. Done
      //    BEFORE the gateway call so we have a stable orderId to pass
      //    as `external_reference` (correlation key on webhook).
      const publicReference = mintOrderReference();
      const idempotencyKey = globalThis.crypto.randomUUID();

      const created = await ctx.services.db.db.transaction(async (tx) => {
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

        const [transaction] = await tx
          .insert(schema.transactions)
          .values({
            workspaceId: productRow.workspaceId,
            orderId: order.id,
            gatewayId: desiredGatewayId,
            method: input.method,
            status: 'pending',
            amountCents: totalCents,
            currency,
            installments: input.method === 'credit_card' ? installments : null,
            idempotencyKey,
          })
          .returning({ id: schema.transactions.id });
        if (!transaction) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'transactions insert returned no row',
          });
        }

        return { orderId: order.id, transactionId: transaction.id };
      });

      // 6. If no gateway configured, return the pending order so the UX
      //    still completes. Producer sees pending_payment in dashboard;
      //    buyer sees "estamos gerando" stub.
      if (!gatewayRow) {
        return {
          orderId: created.orderId,
          publicReference,
          status: 'pending_payment',
          method: input.method,
          amountCents: Number(totalCents),
          currency,
          pixQrCode: null,
          pixQrCodeImage: null,
          pixCopyPaste: null,
          pixExpiresAt: null,
          boletoUrl: null,
          boletoBarcode: null,
          gatewayConfigured: false,
        };
      }

      // 7. Call the gateway. Only PIX is wired in Block 22 — card needs
      //    a tokenization round-trip (browser SDK) and boleto needs a
      //    full address that the current form doesn't collect.
      if (input.method !== 'pix') {
        // Mark the freshly-inserted transaction as failed so the producer
        // sees the attempt; buyer gets a clear error.
        await ctx.services.db.db
          .update(schema.transactions)
          .set({
            status: 'failed',
            failureCode: 'METHOD_NOT_YET_SUPPORTED',
            failureMessage: 'Cartão e boleto entram no próximo bloco.',
          })
          .where(eq(schema.transactions.id, created.transactionId));
        await ctx.services.db.db
          .update(schema.orders)
          .set({ status: 'cancelled', cancelledAt: new Date() })
          .where(eq(schema.orders.id, created.orderId));
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cartão e boleto entram no próximo bloco. Use Pix por enquanto.',
        });
      }

      const adapter = getAdapter('mercadopago');
      const credentials = ctx.services.crypto.unsealJson<MercadoPagoCredentials>(
        gatewayRow.credentialsEncrypted,
      );

      let pix;
      try {
        pix = await adapter.createPix!(adapter.parseCredentials(credentials) as MercadoPagoCredentials, {
          workspaceId: productRow.workspaceId,
          orderId: created.orderId,
          amount: { amount: Number(totalCents), currency },
          customer: {
            name: input.buyer.name,
            email: input.buyer.email.toLowerCase(),
            document: docDigits,
            phoneE164: phone.e164,
          },
          description: productRow.description ?? productRow.name,
          expiresInSeconds: PIX_EXPIRY_SECONDS,
          idempotencyKey,
          metadata: {
            public_reference: publicReference,
            product_slug: input.slug,
          },
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        await ctx.services.db.db
          .update(schema.transactions)
          .set({
            status: 'failed',
            failureCode: 'GATEWAY_REJECT',
            failureMessage: message,
            rawResponse: { error: message },
          })
          .where(eq(schema.transactions.id, created.transactionId));
        await ctx.services.db.db
          .update(schema.orders)
          .set({ status: 'cancelled', cancelledAt: new Date() })
          .where(eq(schema.orders.id, created.orderId));
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message: `Gateway recusou a cobrança: ${message}`,
          cause,
        });
      }

      // 8. Persist gateway result on the transaction and surface a
      //    matching order.expires_at so the dashboard can timer-decrement.
      await ctx.services.db.db
        .update(schema.transactions)
        .set({
          gatewayChargeId: pix.gatewayChargeId,
          gatewayRequestId: pix.gatewayRequestId,
          status: pix.status,
          pixQrCode: pix.pixQrCode,
          pixQrCodeImage: pix.pixQrCodeImage,
          pixCopyPaste: pix.pixCopyPaste,
          expiresAt: pix.pixExpiresAt,
          rawResponse: pix.raw as object,
        })
        .where(eq(schema.transactions.id, created.transactionId));
      if (pix.pixExpiresAt) {
        await ctx.services.db.db
          .update(schema.orders)
          .set({ expiresAt: pix.pixExpiresAt })
          .where(eq(schema.orders.id, created.orderId));
      }

      return {
        orderId: created.orderId,
        publicReference,
        status: 'pending_payment',
        method: input.method,
        amountCents: Number(totalCents),
        currency,
        pixQrCode: pix.pixQrCode ?? null,
        pixQrCodeImage: pix.pixQrCodeImage ?? null,
        pixCopyPaste: pix.pixCopyPaste ?? null,
        pixExpiresAt: pix.pixExpiresAt ?? null,
        boletoUrl: pix.boletoUrl ?? null,
        boletoBarcode: pix.boletoBarcode ?? null,
        gatewayConfigured: true,
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
