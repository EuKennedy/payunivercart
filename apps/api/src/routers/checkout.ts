import { schema } from '@payunivercart/db';
import {
  type MercadoPagoAdapter,
  type MercadoPagoCredentials,
  type PaymentResult,
  getAdapter,
} from '@payunivercart/payments';
import {
  type NormalizedPhone,
  normalizePhone,
  validateCnpj,
  validateCpf,
} from '@payunivercart/shared';
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
  /**
   * Best-available cover URL for the checkout hero. The query returns
   * either the API-served bytea endpoint (when the producer uploaded a
   * cover) or the legacy `coverImageUrl` external URL. NULL only when
   * neither exists — a transition state for products created before
   * Block-26's mandatory-cover rule.
   */
  coverImageUrl: z.string().nullable(),
  type: z.enum(['one_time', 'subscription', 'course', 'physical']),
  priceCents: z.number().int().nonnegative(),
  currency: z.enum(['BRL', 'USD', 'EUR']),
  maxInstallments: z.number().int().min(1).max(24),
});

const WorkspacePublicShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /**
   * Brand-name shown to buyers on the checkout. Falls back to the
   * internal `workspaces.name` when the producer hasn't set a
   * company-facing name in Configurações → Marca yet.
   */
  displayName: z.string(),
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
          coverImageUrl: schema.products.coverImageUrl,
          coverImageMime: schema.products.coverImageMime,
          type: schema.products.type,
          isActive: schema.products.isActive,
          deletedAt: schema.products.deletedAt,
          workspaceId: schema.workspaces.id,
          workspaceName: schema.workspaces.name,
          workspaceCompanyName: schema.workspaces.companyName,
          workspaceLogoUrl: schema.workspaces.brandLogoUrl,
          workspaceLogoMime: schema.workspaces.brandLogoMime,
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

      // Prefer the API-served uploaded image; fall back to the legacy
      // external URL the producer may have pasted before the upload
      // pipeline existed. The api host is `API_PUBLIC_URL`; the
      // browser hits `/img/...` directly there.
      const apiBase = (ctx.services.env.API_PUBLIC_URL ?? '').replace(/\/$/, '');
      const productCoverUrl = row.coverImageMime
        ? `${apiBase}/img/product/${row.productId}/cover`
        : (row.coverImageUrl ?? null);
      const workspaceLogoUrl = row.workspaceLogoMime
        ? `${apiBase}/img/workspace/${row.workspaceId}/logo`
        : (row.workspaceLogoUrl ?? null);

      return {
        product: {
          id: row.productId,
          slug: row.slug,
          name: row.name,
          description: row.description,
          coverImageUrl: productCoverUrl,
          type: row.type,
          priceCents: Number(row.priceCents),
          currency: row.currency ?? 'BRL',
          maxInstallments: row.maxInstallments ?? 12,
        },
        workspace: {
          id: row.workspaceId,
          name: row.workspaceName,
          displayName: row.workspaceCompanyName?.trim() || row.workspaceName,
          brandLogoUrl: workspaceLogoUrl,
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
        /**
         * Required when method=credit_card. PCI-DSS note: production
         * deploys MUST switch to client-side tokenization via the MP
         * browser SDK so raw PANs never reach our servers. This
         * inline-card path is for sandbox + single-merchant setups
         * only and is documented as such on the adapter.
         */
        card: z
          .object({
            number: z.string().min(13).max(19),
            expiry: z.string().regex(/^\d{2}\/\d{2,4}$/, 'Validade no formato MM/AA'),
            cvc: z.string().min(3).max(4),
            holderName: z.string().trim().min(1).max(60),
          })
          .optional(),
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
      let phone: NormalizedPhone;
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

      // 7. Call the gateway. PIX + Cartão wired in Block 22; boleto
      //    needs a full billing address the form doesn't yet collect.
      if (input.method === 'boleto') {
        await failTransactionAndOrder(
          ctx.services.db.db,
          created.transactionId,
          created.orderId,
          'METHOD_NOT_YET_SUPPORTED',
          'Boleto entra no próximo bloco. Use Pix ou cartão por enquanto.',
        );
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Boleto entra no próximo bloco. Use Pix ou cartão por enquanto.',
        });
      }
      if (input.method === 'credit_card' && !input.card) {
        await failTransactionAndOrder(
          ctx.services.db.db,
          created.transactionId,
          created.orderId,
          'CARD_MISSING',
          'Dados do cartão obrigatórios.',
        );
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Dados do cartão obrigatórios.',
        });
      }

      const adapter = getAdapter('mercadopago') as unknown as MercadoPagoAdapter;
      const credentials = adapter.parseCredentials(
        ctx.services.crypto.unsealJson<MercadoPagoCredentials>(gatewayRow.credentialsEncrypted),
      );

      let charge: PaymentResult;
      try {
        if (input.method === 'pix') {
          charge = await adapter.createPix(credentials, {
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
        } else {
          // Server-side tokenization (sandbox path — see adapter docblock).
          const card = input.card;
          if (!card) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Dados do cartão são obrigatórios para pagamento com cartão.',
            });
          }
          const [mm, yyRawPart] = card.expiry.split('/');
          if (!mm || !yyRawPart) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Validade do cartão inválida (use MM/AA ou MM/AAAA).',
            });
          }
          const yy = yyRawPart.length === 2 ? `20${yyRawPart}` : yyRawPart;
          const token = await adapter.tokenizeCard(credentials, {
            cardNumber: card.number,
            expirationMonth: Number(mm),
            expirationYear: Number(yy),
            securityCode: card.cvc,
            holderName: card.holderName,
            holderDocument: docDigits,
          });
          charge = await adapter.createCard(credentials, {
            workspaceId: productRow.workspaceId,
            orderId: created.orderId,
            amount: { amount: Number(totalCents), currency },
            customer: {
              name: input.buyer.name,
              email: input.buyer.email.toLowerCase(),
              document: docDigits,
              phoneE164: phone.e164,
            },
            card: { token, holderName: card.holderName },
            installments,
            description: productRow.description ?? productRow.name,
            idempotencyKey,
            metadata: {
              public_reference: publicReference,
              product_slug: input.slug,
            },
          });
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        await failTransactionAndOrder(
          ctx.services.db.db,
          created.transactionId,
          created.orderId,
          'GATEWAY_REJECT',
          message,
        );
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message: `Gateway recusou a cobrança: ${message}`,
          cause,
        });
      }

      // 8. Persist gateway result on the transaction; bump order.expiresAt
      //    when the gateway gave us a deadline.
      const nowDate = new Date();
      await ctx.services.db.db
        .update(schema.transactions)
        .set({
          gatewayChargeId: charge.gatewayChargeId,
          gatewayRequestId: charge.gatewayRequestId,
          status: charge.status,
          pixQrCode: charge.pixQrCode,
          pixQrCodeImage: charge.pixQrCodeImage,
          pixCopyPaste: charge.pixCopyPaste,
          boletoUrl: charge.boletoUrl,
          boletoBarcode: charge.boletoBarcode,
          cardBrand: charge.cardBrand,
          cardLast4: charge.cardLast4,
          expiresAt: charge.pixExpiresAt ?? charge.boletoDueDate,
          paidAt: charge.status === 'paid' ? nowDate : undefined,
          authorizedAt: charge.status === 'authorized' ? nowDate : undefined,
          rawResponse: charge.raw as object,
        })
        .where(eq(schema.transactions.id, created.transactionId));
      if (charge.pixExpiresAt) {
        await ctx.services.db.db
          .update(schema.orders)
          .set({ expiresAt: charge.pixExpiresAt })
          .where(eq(schema.orders.id, created.orderId));
      }
      if (charge.status === 'paid') {
        await ctx.services.db.db
          .update(schema.orders)
          .set({ status: 'paid', paidAt: nowDate })
          .where(eq(schema.orders.id, created.orderId));
      } else if (phone.guessedWahaChatId) {
        // Order is in pending_payment AND we have a WhatsApp chatId
        // for the buyer. Schedule cart-recovery touches per the
        // workspace's active campaign. We tolerate "no active
        // campaign" silently — the producer might've paused it.
        await scheduleRecoveryAttempts(ctx.services.db.db, {
          workspaceId: productRow.workspaceId,
          orderId: created.orderId,
          chatId: phone.guessedWahaChatId,
        });
      }

      return {
        orderId: created.orderId,
        publicReference,
        status: charge.status === 'paid' ? 'paid' : 'pending_payment',
        method: input.method,
        amountCents: Number(totalCents),
        currency,
        pixQrCode: charge.pixQrCode ?? null,
        pixQrCodeImage: charge.pixQrCodeImage ?? null,
        pixCopyPaste: charge.pixCopyPaste ?? null,
        pixExpiresAt: charge.pixExpiresAt ?? null,
        boletoUrl: charge.boletoUrl ?? null,
        boletoBarcode: charge.boletoBarcode ?? null,
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

interface RecoveryStepShape {
  delayMinutes: number;
  channel: 'whatsapp' | 'email';
  template: string;
}

/**
 * Insert `recovery_attempts` rows for the workspace's active campaign.
 * Each step is a separate row scheduled at the campaign-defined delay
 * from now. The sweeper worker picks them up when `scheduled_for <=
 * now()` and dispatches via WAHA.
 *
 * No-op when the workspace has no active campaign, when the campaign
 * has no whatsapp steps, or when the buyer's phone didn't resolve to
 * a WAHA chatId.
 */
async function scheduleRecoveryAttempts(
  db: import('@payunivercart/db').WorkspaceDb,
  input: { workspaceId: string; orderId: string; chatId: string },
): Promise<void> {
  const [campaign] = await db
    .select({
      id: schema.recoveryCampaigns.id,
      steps: schema.recoveryCampaigns.steps,
    })
    .from(schema.recoveryCampaigns)
    .where(
      and(
        eq(schema.recoveryCampaigns.workspaceId, input.workspaceId),
        eq(schema.recoveryCampaigns.isActive, true),
      ),
    )
    .limit(1);
  if (!campaign) return;

  const steps = (campaign.steps as unknown as RecoveryStepShape[] | null) ?? [];
  const whatsappSteps = steps
    .map((step, idx) => ({ step, idx }))
    .filter(({ step }) => step.channel === 'whatsapp');
  if (whatsappSteps.length === 0) return;

  const now = Date.now();
  await db.insert(schema.recoveryAttempts).values(
    whatsappSteps.map(({ step, idx }) => ({
      workspaceId: input.workspaceId,
      orderId: input.orderId,
      campaignId: campaign.id,
      stepIndex: idx,
      channel: step.channel,
      targetIdentifier: input.chatId,
      status: 'queued',
      scheduledFor: new Date(now + step.delayMinutes * 60_000),
    })),
  );
}

/**
 * Mark a freshly-inserted transaction + order as failed/cancelled. Used
 * when the gateway rejects the charge or the input fails a method-
 * specific precondition (boleto without address, card without token).
 */
async function failTransactionAndOrder(
  db: import('@payunivercart/db').WorkspaceDb,
  transactionId: string,
  orderId: string,
  failureCode: string,
  failureMessage: string,
): Promise<void> {
  await db
    .update(schema.transactions)
    .set({
      status: 'failed',
      failureCode,
      failureMessage,
      rawResponse: { error: failureMessage },
    })
    .where(eq(schema.transactions.id, transactionId));
  await db
    .update(schema.orders)
    .set({ status: 'cancelled', cancelledAt: new Date() })
    .where(eq(schema.orders.id, orderId));
}
