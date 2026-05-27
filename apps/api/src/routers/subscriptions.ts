import { schema } from '@payunivercart/db';
import { type CreateSubscriptionInput, getAdapter } from '@payunivercart/payments';
import {
  type GatewayId,
  type NormalizedPhone,
  normalizePhone,
  validateCnpj,
  validateCpf,
} from '@payunivercart/shared';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { resolveAttribution } from '../affiliates/tracker';
import { ConnectDispatcher } from '../connect/dispatcher';
import { publicProcedure, router, workspaceProcedure } from '../trpc';
import {
  dispatchSubscriptionActivatedFanOut,
  materializeSubscriptionOrder,
} from '../webhooks/gateways';

/**
 * Subscriptions — recurring-billing surface.
 *
 * Producer endpoints (workspaceProcedure):
 *   - listPlans(productId)   — plans attached to a product
 *   - createPlan(...)        — add a plan (Mensal/Anual)
 *   - updatePlan(...)        — rename / change price / highlight
 *   - deactivatePlan(id)     — soft-disable (open subs stay valid)
 *   - listSubscriptions(...) — workspace-wide
 *   - cancelSubscription(id) — talk to MP + flip local state
 *
 * Buyer endpoint (publicProcedure):
 *   - subscribe(slug, planId, buyer, card) — wires the MP recurring
 *     engine with a card_token from the browser SDK and writes the
 *     local mirror row.
 */

const BillingPeriod = z.enum(['monthly', 'yearly']);
const SubscriptionStatus = z.enum(['pending', 'active', 'paused', 'cancelled', 'expired']);
/**
 * Methods the producer accepts for this plan.
 *   - `card` — credit card only (legacy default, MP preapproval engine)
 *   - `pix`  — PIX-only recurring (cycle worker generates a new charge per period)
 *   - `both` — buyer picks at checkout
 */
const PlanPaymentMethod = z.enum(['card', 'pix', 'both']);

const PlanRow = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  name: z.string(),
  billingPeriod: BillingPeriod,
  amountCents: z.number().int().nonnegative(),
  currency: z.enum(['BRL', 'USD', 'EUR']),
  trialDays: z.number().int().nonnegative(),
  isActive: z.boolean(),
  isHighlighted: z.boolean(),
  paymentMethod: PlanPaymentMethod,
  sortOrder: z.number().int(),
  /** Univercart Connect — partner SaaS this plan provisions. */
  partnerAccountId: z.string().uuid().nullable(),
  /** Slug from `partner_roles.slug`. */
  partnerRoleSlug: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const SubscriptionRow = z.object({
  id: z.string().uuid(),
  publicReference: z.string(),
  productId: z.string().uuid(),
  productName: z.string(),
  planId: z.string().uuid(),
  planName: z.string(),
  billingPeriod: BillingPeriod,
  amountCents: z.number().int().nonnegative(),
  currency: z.enum(['BRL', 'USD', 'EUR']),
  customerName: z.string(),
  customerEmail: z.string(),
  status: SubscriptionStatus,
  nextChargeAt: z.date().nullable(),
  lastChargedAt: z.date().nullable(),
  startedAt: z.date().nullable(),
  cancelledAt: z.date().nullable(),
  createdAt: z.date(),
});

export const subscriptionsRouter = router({
  /* ===================== Producer-facing: plans ====================== */

  listPlans: workspaceProcedure
    .input(z.object({ productId: z.string().uuid() }))
    .output(z.array(PlanRow))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.services.db.db
        .select({
          id: schema.subscriptionPlans.id,
          productId: schema.subscriptionPlans.productId,
          name: schema.subscriptionPlans.name,
          billingPeriod: schema.subscriptionPlans.billingPeriod,
          amountCents: schema.subscriptionPlans.amountCents,
          currency: schema.subscriptionPlans.currency,
          trialDays: schema.subscriptionPlans.trialDays,
          isActive: schema.subscriptionPlans.isActive,
          isHighlighted: schema.subscriptionPlans.isHighlighted,
          paymentMethod: schema.subscriptionPlans.paymentMethod,
          sortOrder: schema.subscriptionPlans.sortOrder,
          partnerAccountId: schema.subscriptionPlans.partnerAccountId,
          partnerRoleSlug: schema.subscriptionPlans.partnerRoleSlug,
          createdAt: schema.subscriptionPlans.createdAt,
          updatedAt: schema.subscriptionPlans.updatedAt,
        })
        .from(schema.subscriptionPlans)
        .where(
          and(
            eq(schema.subscriptionPlans.workspaceId, ctx.workspaceId),
            eq(schema.subscriptionPlans.productId, input.productId),
          ),
        )
        .orderBy(schema.subscriptionPlans.sortOrder, schema.subscriptionPlans.amountCents);

      return rows.map((r) => ({
        ...r,
        amountCents: Number(r.amountCents),
        billingPeriod: r.billingPeriod === 'yearly' ? ('yearly' as const) : ('monthly' as const),
        currency: r.currency,
        paymentMethod: narrowPlanPaymentMethod(r.paymentMethod),
      }));
    }),

  createPlan: workspaceProcedure
    .input(
      z.object({
        productId: z.string().uuid(),
        name: z.string().trim().min(1).max(80),
        billingPeriod: BillingPeriod,
        amountCents: z.number().int().min(100).max(10_000_000),
        trialDays: z.number().int().min(0).max(365).default(0),
        isHighlighted: z.boolean().default(false),
        /** Default 'card' keeps every existing producer flow intact. */
        paymentMethod: PlanPaymentMethod.default('card'),
        sortOrder: z.number().int().min(0).max(999).default(0),
        /** Univercart Connect: partner this plan provisions to. */
        partnerAccountId: z.string().uuid().nullable().default(null),
        partnerRoleSlug: z.string().trim().min(1).max(40).nullable().default(null),
      }),
    )
    .output(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Tenant-scope check: product must belong to the workspace.
      const [product] = await ctx.services.db.db
        .select({ id: schema.products.id })
        .from(schema.products)
        .where(
          and(
            eq(schema.products.id, input.productId),
            eq(schema.products.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1);
      if (!product) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Produto inexistente.' });
      }
      // partnerAccountId + partnerRoleSlug travel together — either both
      // set or both null. Producer flipping one without the other is a
      // misconfiguration that breaks entitlement dispatch silently.
      if ((input.partnerAccountId == null) !== (input.partnerRoleSlug == null)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Para integrar com um SaaS parceiro, escolha o parceiro E o papel.',
        });
      }
      const [row] = await ctx.services.db.db
        .insert(schema.subscriptionPlans)
        .values({
          workspaceId: ctx.workspaceId,
          productId: input.productId,
          name: input.name,
          billingPeriod: input.billingPeriod,
          amountCents: BigInt(input.amountCents),
          currency: 'BRL',
          trialDays: input.trialDays,
          isHighlighted: input.isHighlighted,
          paymentMethod: input.paymentMethod,
          sortOrder: input.sortOrder,
          partnerAccountId: input.partnerAccountId,
          partnerRoleSlug: input.partnerRoleSlug,
        })
        .returning({ id: schema.subscriptionPlans.id });
      if (!row) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Não conseguimos criar o plano.',
        });
      }
      return { id: row.id };
    }),

  updatePlan: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(80).optional(),
        amountCents: z.number().int().min(100).max(10_000_000).optional(),
        trialDays: z.number().int().min(0).max(365).optional(),
        isActive: z.boolean().optional(),
        isHighlighted: z.boolean().optional(),
        paymentMethod: PlanPaymentMethod.optional(),
        sortOrder: z.number().int().min(0).max(999).optional(),
        partnerAccountId: z.string().uuid().nullable().optional(),
        partnerRoleSlug: z.string().trim().min(1).max(40).nullable().optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.amountCents !== undefined) patch.amountCents = BigInt(input.amountCents);
      if (input.trialDays !== undefined) patch.trialDays = input.trialDays;
      if (input.isActive !== undefined) patch.isActive = input.isActive;
      if (input.isHighlighted !== undefined) patch.isHighlighted = input.isHighlighted;
      if (input.paymentMethod !== undefined) patch.paymentMethod = input.paymentMethod;
      if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
      if (input.partnerAccountId !== undefined) patch.partnerAccountId = input.partnerAccountId;
      if (input.partnerRoleSlug !== undefined) patch.partnerRoleSlug = input.partnerRoleSlug;
      // If either partner field is being touched, both must end up
      // either both set or both null. We resolve the post-patch state
      // for validation.
      if (input.partnerAccountId !== undefined || input.partnerRoleSlug !== undefined) {
        const [existing] = await ctx.services.db.db
          .select({
            partnerAccountId: schema.subscriptionPlans.partnerAccountId,
            partnerRoleSlug: schema.subscriptionPlans.partnerRoleSlug,
          })
          .from(schema.subscriptionPlans)
          .where(eq(schema.subscriptionPlans.id, input.id))
          .limit(1);
        const nextPartnerId =
          input.partnerAccountId !== undefined
            ? input.partnerAccountId
            : (existing?.partnerAccountId ?? null);
        const nextRoleSlug =
          input.partnerRoleSlug !== undefined
            ? input.partnerRoleSlug
            : (existing?.partnerRoleSlug ?? null);
        if ((nextPartnerId == null) !== (nextRoleSlug == null)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Para integrar com um SaaS parceiro, escolha o parceiro E o papel.',
          });
        }
      }
      await ctx.services.db.db
        .update(schema.subscriptionPlans)
        .set(patch)
        .where(
          and(
            eq(schema.subscriptionPlans.id, input.id),
            eq(schema.subscriptionPlans.workspaceId, ctx.workspaceId),
          ),
        );
      return { ok: true as const };
    }),

  deletePlan: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      // Refuse delete when there's an active subscription on the
      // plan — the FK uses ON DELETE RESTRICT, so we surface a clean
      // error instead of letting Postgres throw.
      // Both filters are required: planId narrows the lookup, but the
      // workspaceId predicate makes the timing of the response opaque
      // to a producer probing UUIDs of other workspaces. Without it,
      // a tenant could differentiate "plan exists in other workspace
      // with subscriptions" vs "plan does not exist".
      const [linked] = await ctx.services.db.db
        .select({ id: schema.subscriptions.id })
        .from(schema.subscriptions)
        .where(
          and(
            eq(schema.subscriptions.planId, input.id),
            eq(schema.subscriptions.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1);
      if (linked) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Existem assinaturas vinculadas a este plano. Desative em vez de apagar.',
        });
      }
      await ctx.services.db.db
        .delete(schema.subscriptionPlans)
        .where(
          and(
            eq(schema.subscriptionPlans.id, input.id),
            eq(schema.subscriptionPlans.workspaceId, ctx.workspaceId),
          ),
        );
      return { ok: true as const };
    }),

  /* ===================== Producer-facing: subscriptions ===================== */

  listSubscriptions: workspaceProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(50),
          status: SubscriptionStatus.optional(),
        })
        .default({ limit: 50 }),
    )
    .output(z.array(SubscriptionRow))
    .query(async ({ ctx, input }) => {
      const conditions = [eq(schema.subscriptions.workspaceId, ctx.workspaceId)];
      if (input.status) conditions.push(eq(schema.subscriptions.status, input.status));
      const rows = await ctx.services.db.db
        .select({
          id: schema.subscriptions.id,
          publicReference: schema.subscriptions.publicReference,
          productId: schema.subscriptions.productId,
          productName: schema.products.name,
          planId: schema.subscriptions.planId,
          planName: schema.subscriptionPlans.name,
          billingPeriod: schema.subscriptionPlans.billingPeriod,
          amountCents: schema.subscriptionPlans.amountCents,
          currency: schema.subscriptionPlans.currency,
          customerName: schema.subscriptions.customerName,
          customerEmail: schema.subscriptions.customerEmail,
          status: schema.subscriptions.status,
          nextChargeAt: schema.subscriptions.nextChargeAt,
          lastChargedAt: schema.subscriptions.lastChargedAt,
          startedAt: schema.subscriptions.startedAt,
          cancelledAt: schema.subscriptions.cancelledAt,
          createdAt: schema.subscriptions.createdAt,
        })
        .from(schema.subscriptions)
        .innerJoin(schema.products, eq(schema.products.id, schema.subscriptions.productId))
        .innerJoin(
          schema.subscriptionPlans,
          eq(schema.subscriptionPlans.id, schema.subscriptions.planId),
        )
        .where(and(...conditions))
        .orderBy(desc(schema.subscriptions.createdAt))
        .limit(input.limit);

      return rows.map((r) => ({
        id: r.id,
        publicReference: r.publicReference,
        productId: r.productId,
        productName: r.productName,
        planId: r.planId,
        planName: r.planName,
        billingPeriod: r.billingPeriod === 'yearly' ? ('yearly' as const) : ('monthly' as const),
        amountCents: Number(r.amountCents),
        currency: r.currency,
        customerName: r.customerName,
        customerEmail: r.customerEmail,
        status: narrowSubscriptionStatus(r.status),
        nextChargeAt: r.nextChargeAt,
        lastChargedAt: r.lastChargedAt,
        startedAt: r.startedAt,
        cancelledAt: r.cancelledAt,
        createdAt: r.createdAt,
      }));
    }),

  cancelSubscription: workspaceProcedure
    .input(z.object({ id: z.string().uuid(), reason: z.string().max(500).optional() }))
    .output(z.object({ ok: z.literal(true), status: SubscriptionStatus }))
    .mutation(async ({ ctx, input }) => {
      const [sub] = await ctx.services.db.db
        .select({
          id: schema.subscriptions.id,
          gatewayId: schema.subscriptions.gatewayId,
          gatewaySubscriptionId: schema.subscriptions.gatewaySubscriptionId,
          status: schema.subscriptions.status,
        })
        .from(schema.subscriptions)
        .where(
          and(
            eq(schema.subscriptions.id, input.id),
            eq(schema.subscriptions.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1);
      if (!sub) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Assinatura inexistente.' });
      }
      if (sub.status === 'cancelled' || sub.status === 'expired') {
        return { ok: true as const, status: narrowSubscriptionStatus(sub.status) };
      }

      const [credRow] = await ctx.services.db.db
        .select({ credentialsEncrypted: schema.gatewayCredentials.credentialsEncrypted })
        .from(schema.gatewayCredentials)
        .where(
          and(
            eq(schema.gatewayCredentials.workspaceId, ctx.workspaceId),
            eq(schema.gatewayCredentials.gatewayId, sub.gatewayId),
            eq(schema.gatewayCredentials.isDefault, true),
          ),
        )
        .limit(1);
      if (!credRow) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Credenciais do gateway removidas — reconecte em Integrações.',
        });
      }

      const adapter = getAdapter(sub.gatewayId);
      if (!adapter.cancelSubscription) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Gateway ${sub.gatewayId} não suporta cancelamento de assinatura via API.`,
        });
      }
      const credentials = adapter.parseCredentials(
        ctx.services.crypto.unsealJson<Record<string, unknown>>(credRow.credentialsEncrypted),
      );
      try {
        await adapter.cancelSubscription(credentials as never, {
          gatewaySubscriptionId: sub.gatewaySubscriptionId,
          reason: input.reason,
        });
      } catch (cause) {
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message: `Gateway recusou o cancelamento: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        });
      }

      const now = new Date();
      await ctx.services.db.db
        .update(schema.subscriptions)
        .set({
          status: 'cancelled',
          cancelledAt: now,
          cancelReason: input.reason ?? null,
          nextChargeAt: null,
          updatedAt: now,
        })
        .where(eq(schema.subscriptions.id, sub.id));
      return { ok: true as const, status: 'cancelled' as const };
    }),

  /* ===================== Buyer-facing: subscribe ===================== */

  subscribe: publicProcedure
    .input(
      z.object({
        slug: z.string().min(3).max(80),
        planId: z.string().uuid(),
        buyer: z.object({
          name: z.string().trim().min(2).max(120),
          email: z.string().email().max(160),
          document: z.string().trim().min(11).max(20),
          phone: z.string().trim().min(8).max(20),
        }),
        /** Card token from the MP browser SDK. Raw PAN is NEVER
         *  accepted on the recurring path — PCI scope is non-negotiable. */
        cardToken: z.string().min(8).max(200),
        cardHolderName: z.string().trim().min(2).max(60),
        /** Affiliate slug from the `payuniv_aff` cookie (forwarded by
         *  the checkout). Same attribution flow as one-time orders. */
        affiliateRef: z.string().trim().min(1).max(80).optional(),
        clientFingerprint: z.string().trim().max(128).optional(),
      }),
    )
    .output(
      z.object({
        subscriptionId: z.string().uuid(),
        publicReference: z.string(),
        status: SubscriptionStatus,
        gatewaySubscriptionId: z.string(),
        nextChargeAt: z.date().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const docDigits = validateCpf(input.buyer.document) ?? validateCnpj(input.buyer.document);
      if (!docDigits) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'CPF ou CNPJ inválido.' });
      }
      let phone: NormalizedPhone;
      try {
        phone = normalizePhone(input.buyer.phone);
      } catch (cause) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Telefone inválido.', cause });
      }
      if (!phone.valid) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Telefone inválido.' });
      }

      // Resolve product + plan + workspace in one go. Tenant scope
      // is enforced by `product.slug → workspace_id` chain — we never
      // trust client-supplied workspaceId.
      const [row] = await ctx.services.db.db
        .select({
          productId: schema.products.id,
          productName: schema.products.name,
          productSlug: schema.products.slug,
          productIsSubscription: schema.products.isSubscription,
          productIsActive: schema.products.isActive,
          productDeletedAt: schema.products.deletedAt,
          workspaceId: schema.workspaces.id,
          planId: schema.subscriptionPlans.id,
          planProductId: schema.subscriptionPlans.productId,
          planName: schema.subscriptionPlans.name,
          planBillingPeriod: schema.subscriptionPlans.billingPeriod,
          planAmount: schema.subscriptionPlans.amountCents,
          planCurrency: schema.subscriptionPlans.currency,
          planTrialDays: schema.subscriptionPlans.trialDays,
          planIsActive: schema.subscriptionPlans.isActive,
        })
        .from(schema.products)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.products.workspaceId))
        .innerJoin(schema.subscriptionPlans, eq(schema.subscriptionPlans.id, input.planId))
        .where(and(eq(schema.products.slug, input.slug), isNull(schema.products.deletedAt)))
        .limit(1);

      if (!row || !row.productIsActive || row.productDeletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Produto indisponível.' });
      }
      if (!row.productIsSubscription) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Este produto não está configurado como assinatura.',
        });
      }
      if (row.planProductId !== row.productId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Plano não pertence ao produto.',
        });
      }
      if (!row.planIsActive) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Plano desativado pelo produtor.',
        });
      }

      // Resolve workspace default gateway. Only MP supports recurring
      // today; we keep the lookup generic so adding Pagar.me Recurrence
      // later is one branch.
      const [credRow] = await ctx.services.db.db
        .select({
          id: schema.gatewayCredentials.id,
          gatewayId: schema.gatewayCredentials.gatewayId,
          credentialsEncrypted: schema.gatewayCredentials.credentialsEncrypted,
        })
        .from(schema.gatewayCredentials)
        .where(
          and(
            eq(schema.gatewayCredentials.workspaceId, row.workspaceId),
            eq(schema.gatewayCredentials.isDefault, true),
          ),
        )
        .limit(1);
      if (!credRow) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Produtor ainda não conectou um gateway de pagamento.',
        });
      }
      const adapter = getAdapter(credRow.gatewayId as GatewayId);
      if (!adapter.createSubscription) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Gateway ${credRow.gatewayId} ainda não suporta assinatura recorrente.`,
        });
      }
      const credentials = adapter.parseCredentials(
        ctx.services.crypto.unsealJson<Record<string, unknown>>(credRow.credentialsEncrypted),
      );

      const publicReference = mintSubscriptionReference();
      const subscriptionId = globalThis.crypto.randomUUID();
      const webhookUrl = ctx.services.env.API_PUBLIC_URL
        ? `${ctx.services.env.API_PUBLIC_URL.replace(/\/$/, '')}/webhooks/gateway/${credRow.gatewayId}`
        : undefined;

      // The browser may forward either:
      //  (a) a real MP card_token_id (preferred — tokenized via MP.js v2)
      //  (b) a legacy placeholder `RAW:<pan>:<mm>:<yy>:<cvv>` produced
      //      by the bootstrap checkout. We tokenize server-side via
      //      MercadoPagoAdapter.tokenizeCard so the `/preapproval`
      //      call below receives a real token id.
      let cardToken = input.cardToken;
      if (cardToken.startsWith('RAW:') && credRow.gatewayId === 'mercadopago') {
        const parts = cardToken.slice(4).split(':');
        if (parts.length !== 4) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cartão em formato inválido. Recarregue a página e tente novamente.',
          });
        }
        const [pan, mm, yyyy, cvv] = parts as [string, string, string, string];
        // Call the adapter method on `adapter` directly so `this`
        // binds to the MercadoPagoAdapter instance — otherwise the
        // private `this.request` call inside tokenizeCard explodes
        // with "Cannot read properties of undefined (reading 'request')".
        const adapterWithToken = adapter as unknown as {
          tokenizeCard?: (
            creds: unknown,
            card: {
              cardNumber: string;
              expirationMonth: number;
              expirationYear: number;
              securityCode: string;
              holderName: string;
              holderDocument: string;
            },
          ) => Promise<string>;
        };
        if (typeof adapterWithToken.tokenizeCard !== 'function') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Tokenização server-side não suportada por este gateway.',
          });
        }
        try {
          cardToken = await adapterWithToken.tokenizeCard(credentials, {
            cardNumber: pan,
            expirationMonth: Number(mm),
            expirationYear: Number(yyyy),
            securityCode: cvv,
            holderName: input.cardHolderName,
            holderDocument: docDigits,
          });
        } catch (cause) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Cartão recusado pelo gateway: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          });
        }
      }

      const frequency = row.planBillingPeriod === 'yearly' ? 12 : 1;
      // MP /preapproval and /preapproval_plan REQUIRE back_url even
      // when we pre-authorize the subscription via card_token_id
      // (which skips the MP-hosted approval flow). Without it MP
      // returns 404 "Card token service not found" — misleading
      // error that is really "missing required field back_url".
      const checkoutBase = (
        ctx.services.env.CHECKOUT_PUBLIC_URL ??
        ctx.services.env.API_PUBLIC_URL ??
        'https://pay.univercart.com'
      ).replace(/\/$/, '');
      const backUrl = `${checkoutBase}/c/${row.productSlug}?subscription=ok`;
      const subscriptionInput: CreateSubscriptionInput = {
        workspaceId: row.workspaceId,
        subscriptionId,
        productId: row.productId,
        planId: row.planId,
        reason: `${row.productName} — ${row.planName}`,
        amount: { amount: Number(row.planAmount), currency: row.planCurrency },
        customer: {
          name: input.buyer.name,
          email: input.buyer.email.toLowerCase(),
          document: docDigits,
          phoneE164: phone.e164,
        },
        cardToken,
        frequency,
        frequencyType: 'months',
        trialDays: row.planTrialDays > 0 ? row.planTrialDays : undefined,
        // Without start_date, MP schedules the first charge for
        // `now + frequency` (i.e. ~1 month from now) and only does a
        // card auth on creation. Buyer would see ZERO charge today and
        // think the integration is broken. Forcing start_date=now (with
        // 1 min buffer for MP's processing window) charges the first
        // installment immediately when status=authorized + card_token_id.
        startDate: row.planTrialDays > 0 ? undefined : new Date(Date.now() + 60_000),
        webhookUrl,
        backUrl,
        metadata: {
          public_reference: publicReference,
          product_slug: row.productSlug,
          plan_name: row.planName,
        },
      };

      let charge: Awaited<ReturnType<NonNullable<typeof adapter.createSubscription>>>;
      try {
        charge = await adapter.createSubscription(credentials as never, subscriptionInput);
      } catch (cause) {
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message: `Gateway recusou a assinatura: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        });
      }

      const now = new Date();
      const [inserted] = await ctx.services.db.db
        .insert(schema.subscriptions)
        .values({
          id: subscriptionId,
          workspaceId: row.workspaceId,
          productId: row.productId,
          planId: row.planId,
          publicReference,
          customerName: input.buyer.name,
          customerEmail: input.buyer.email.toLowerCase(),
          customerDocument: docDigits,
          customerPhoneRaw: phone.raw,
          customerPhoneE164: phone.e164,
          customerWahaChatId: phone.guessedWahaChatId,
          gatewayId: credRow.gatewayId,
          gatewaySubscriptionId: charge.gatewaySubscriptionId,
          status: charge.status,
          nextChargeAt: charge.nextChargeAt ?? null,
          startedAt: charge.status === 'active' ? now : null,
          gatewayCredentialId: credRow.id,
        })
        .returning({ id: schema.subscriptions.id });

      // Activation fan-out (email + WhatsApp + Connect entitlement).
      // The MP webhook handler ALSO has logic to fire this on the
      // pending → active transition, but because we insert with the
      // MP-returned status (already "active" 99% of the time), that
      // transition never fires and the buyer gets nothing. Fire here
      // unconditionally when status='active'. Idempotency on Connect
      // events is handled by the dispatcher's dedupe on entitlement
      // token table; email/WhatsApp are best-effort and harmless if
      // duplicated (worst case: buyer gets two welcome messages).
      const finalSubId = inserted?.id ?? subscriptionId;
      if (charge.status === 'active') {
        // Materialise the activation charge as an `orders` row so
        // analytics + the Pedidos UI surface the sale immediately.
        // Without this the producer sees nothing in their dashboard
        // even though MP cobrou na hora.
        try {
          await materializeSubscriptionOrder(ctx.services, {
            subscriptionId: finalSubId,
            cycleNumber: 1,
            gatewayChargeId: charge.gatewaySubscriptionId,
          });
        } catch (cause) {
          process.stdout.write(
            `${JSON.stringify({
              level: 'warn',
              event: 'subscribe.order.materialize.failed',
              subscriptionId: finalSubId,
              error: cause instanceof Error ? cause.message : String(cause),
            })}\n`,
          );
        }

        try {
          await dispatchSubscriptionActivatedFanOut(ctx.services, finalSubId);
        } catch (cause) {
          // Don't fail the subscribe request if notifications fall over.
          process.stdout.write(
            `${JSON.stringify({
              level: 'warn',
              event: 'subscribe.fanout.failed',
              subscriptionId: finalSubId,
              error: cause instanceof Error ? cause.message : String(cause),
            })}\n`,
          );
        }

        // Univercart Connect — provision partner entitlement + magic link
        // when the plan is wired to a SaaS partner. Skipped silently for
        // non-Connect plans.
        try {
          const dispatcher = new ConnectDispatcher(ctx.services);
          await dispatcher.dispatch({
            type: 'entitlement.granted',
            subscriptionId: finalSubId,
          });
        } catch (cause) {
          process.stdout.write(
            `${JSON.stringify({
              level: 'warn',
              event: 'subscribe.connect.failed',
              subscriptionId: finalSubId,
              error: cause instanceof Error ? cause.message : String(cause),
            })}\n`,
          );
        }

        // Affiliate attribution — same shape as the one-time checkout
        // flow. Best-effort: a failure here must NEVER bubble up and
        // strand the buyer mid-subscription. IP from the request
        // headers (Hono context); fingerprint from the input.
        if (input.affiliateRef) {
          const ip =
            ctx.honoCtx.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
            ctx.honoCtx.req.header('x-real-ip')?.trim() ??
            'unknown';
          try {
            await resolveAttribution({
              services: ctx.services,
              affiliateSlug: input.affiliateRef,
              workspaceId: row.workspaceId,
              productId: row.productId,
              subscriptionId: finalSubId,
              ip,
              fingerprint: input.clientFingerprint ?? null,
              saltSecret:
                ctx.services.env.AUDIT_KEYS.split(',')[0]?.split(':')[1] ??
                ctx.services.env.AUTH_SECRET,
            });
          } catch (cause) {
            process.stdout.write(
              `${JSON.stringify({
                level: 'warn',
                event: 'subscribe.affiliate.attribution.failed',
                subscriptionId: finalSubId,
                error: cause instanceof Error ? cause.message : String(cause),
              })}\n`,
            );
          }
        }
      }

      return {
        subscriptionId: finalSubId,
        publicReference,
        status: narrowSubscriptionStatus(charge.status),
        gatewaySubscriptionId: charge.gatewaySubscriptionId,
        nextChargeAt: charge.nextChargeAt ?? null,
      };
    }),

  /**
   * Buyer-facing PIX-recurring subscribe. Used when the producer set
   * `plan.paymentMethod IN ('pix','both')` and the buyer picked PIX at
   * checkout.
   *
   * Flow (single transaction-style sequence — explicit ordering, no
   * nested tx because we want partial-failure observability per step):
   *
   *   1. Validate buyer + slug + plan.
   *   2. Resolve workspace default gateway (only MP today).
   *   3. Insert `subscriptions` row in `pending` status, currentCycleStatus
   *      `pending_pix`, paymentMethod `pix`, no nextChargeAt yet.
   *   4. Materialise the cycle-1 `orders` row in `pending` status (gives
   *      the producer's Pedidos UI a record from minute zero).
   *   5. Call `adapter.createPix` with orderId.
   *   6. Insert `transactions` row with QR + expiresAt.
   *   7. Link `subscriptions.pixCurrentChargeId = transactions.id`.
   *   8. Return QR payload to the buyer.
   *
   * The buyer polls `subscriptions.status` (or the same `payment.status`
   * endpoint the one-time PIX flow uses) until MP fires the `pix.paid`
   * webhook, which then flips order→paid + sub→active +
   * currentCycleStatus→paid + nextChargeAt → today + 1 period via the
   * existing gateways webhook handler (orders.subscriptionId is already
   * threaded through).
   */
  subscribePix: publicProcedure
    .input(
      z.object({
        slug: z.string().min(3).max(80),
        planId: z.string().uuid(),
        buyer: z.object({
          name: z.string().trim().min(2).max(120),
          email: z.string().email().max(160),
          document: z.string().trim().min(11).max(20),
          phone: z.string().trim().min(8).max(20),
        }),
        affiliateRef: z.string().trim().min(1).max(80).optional(),
        clientFingerprint: z.string().trim().max(128).optional(),
      }),
    )
    .output(
      z.object({
        subscriptionId: z.string().uuid(),
        publicReference: z.string(),
        orderId: z.string().uuid(),
        transactionId: z.string().uuid(),
        pixQrCodeImage: z.string().nullable(),
        pixCopyPaste: z.string().nullable(),
        pixExpiresAt: z.date().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const docDigits = validateCpf(input.buyer.document) ?? validateCnpj(input.buyer.document);
      if (!docDigits) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'CPF ou CNPJ inválido.' });
      }
      let phone: NormalizedPhone;
      try {
        phone = normalizePhone(input.buyer.phone);
      } catch (cause) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Telefone inválido.', cause });
      }
      if (!phone.valid) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Telefone inválido.' });
      }

      const [row] = await ctx.services.db.db
        .select({
          productId: schema.products.id,
          productName: schema.products.name,
          productSlug: schema.products.slug,
          productIsSubscription: schema.products.isSubscription,
          productIsActive: schema.products.isActive,
          productDeletedAt: schema.products.deletedAt,
          productDescription: schema.products.description,
          workspaceId: schema.workspaces.id,
          planId: schema.subscriptionPlans.id,
          planProductId: schema.subscriptionPlans.productId,
          planName: schema.subscriptionPlans.name,
          planBillingPeriod: schema.subscriptionPlans.billingPeriod,
          planAmount: schema.subscriptionPlans.amountCents,
          planCurrency: schema.subscriptionPlans.currency,
          planIsActive: schema.subscriptionPlans.isActive,
          planPaymentMethod: schema.subscriptionPlans.paymentMethod,
        })
        .from(schema.products)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.products.workspaceId))
        .innerJoin(schema.subscriptionPlans, eq(schema.subscriptionPlans.id, input.planId))
        .where(and(eq(schema.products.slug, input.slug), isNull(schema.products.deletedAt)))
        .limit(1);
      if (!row || !row.productIsActive || row.productDeletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Produto indisponível.' });
      }
      if (!row.productIsSubscription) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Este produto não está configurado como assinatura.',
        });
      }
      if (row.planProductId !== row.productId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Plano não pertence ao produto.' });
      }
      if (!row.planIsActive) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Plano desativado pelo produtor.' });
      }
      if (row.planPaymentMethod !== 'pix' && row.planPaymentMethod !== 'both') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Este plano não aceita PIX. Use cartão.',
        });
      }

      const [credRow] = await ctx.services.db.db
        .select({
          id: schema.gatewayCredentials.id,
          gatewayId: schema.gatewayCredentials.gatewayId,
          credentialsEncrypted: schema.gatewayCredentials.credentialsEncrypted,
        })
        .from(schema.gatewayCredentials)
        .where(
          and(
            eq(schema.gatewayCredentials.workspaceId, row.workspaceId),
            eq(schema.gatewayCredentials.isDefault, true),
          ),
        )
        .limit(1);
      if (!credRow) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Produtor ainda não conectou um gateway de pagamento.',
        });
      }
      const adapter = getAdapter(credRow.gatewayId as GatewayId);
      if (!adapter.createPix) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Gateway ${credRow.gatewayId} não suporta PIX.`,
        });
      }
      const credentials = adapter.parseCredentials(
        ctx.services.crypto.unsealJson<Record<string, unknown>>(credRow.credentialsEncrypted),
      );

      const publicReference = mintSubscriptionReference();
      const subscriptionId = globalThis.crypto.randomUUID();
      const now = new Date();
      const pixExpiresInSeconds = 30 * 60; // 30 minutes, MP default

      // 1. Insert subscription stub in pending state.
      await ctx.services.db.db.insert(schema.subscriptions).values({
        id: subscriptionId,
        workspaceId: row.workspaceId,
        productId: row.productId,
        planId: row.planId,
        publicReference,
        customerName: input.buyer.name,
        customerEmail: input.buyer.email.toLowerCase(),
        customerDocument: docDigits,
        customerPhoneRaw: phone.raw,
        customerPhoneE164: phone.e164,
        customerWahaChatId: phone.guessedWahaChatId,
        gatewayId: credRow.gatewayId,
        gatewaySubscriptionId: subscriptionId, // PIX recurring has no MP-side preapproval id
        status: 'pending',
        paymentMethod: 'pix',
        currentCycleStatus: 'pending_pix',
        nextChargeAt: null,
        startedAt: null,
        gatewayCredentialId: credRow.id,
      });

      // 2. Insert cycle-1 order in pending state.
      const [orderRow] = await ctx.services.db.db
        .insert(schema.orders)
        .values({
          workspaceId: row.workspaceId,
          subscriptionId,
          cycleNumber: 1,
          publicReference,
          status: 'pending_payment',
          customerName: input.buyer.name,
          customerEmail: input.buyer.email.toLowerCase(),
          customerDocument: docDigits,
          customerPhoneRaw: phone.raw,
          customerPhoneE164: phone.e164,
          customerWahaChatId: phone.guessedWahaChatId,
          subtotalCents: BigInt(row.planAmount),
          totalCents: BigInt(row.planAmount),
          currency: row.planCurrency,
          metadata: { cycle: 1, paymentMethod: 'pix' },
        })
        .returning({ id: schema.orders.id });
      if (!orderRow) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Não conseguimos registrar a cobrança da assinatura.',
        });
      }
      const orderId = orderRow.id;
      await ctx.services.db.db.insert(schema.orderItems).values({
        orderId,
        productId: row.productId,
        name: row.productName,
        quantity: 1,
        unitAmountCents: BigInt(row.planAmount),
        totalCents: BigInt(row.planAmount),
      });

      // 3. Call MP createPix.
      const webhookUrl = ctx.services.env.API_PUBLIC_URL
        ? `${ctx.services.env.API_PUBLIC_URL.replace(/\/$/, '')}/webhooks/gateway/${credRow.gatewayId}`
        : undefined;
      let charge: import('@payunivercart/payments').PaymentResult;
      try {
        charge = await adapter.createPix(credentials as never, {
          workspaceId: row.workspaceId,
          orderId,
          amount: { amount: Number(row.planAmount), currency: row.planCurrency },
          customer: {
            name: input.buyer.name,
            email: input.buyer.email.toLowerCase(),
            document: docDigits,
            phoneE164: phone.e164,
          },
          description: `${row.productName} — ${row.planName}`,
          expiresInSeconds: pixExpiresInSeconds,
          idempotencyKey: `sub:${subscriptionId}:c1`,
          metadata: {
            public_reference: publicReference,
            product_slug: row.productSlug,
            subscription_id: subscriptionId,
            cycle: 1,
          },
          webhookUrl,
        });
      } catch (cause) {
        // Roll back the pending records so the producer's UI doesn't
        // collect ghost subscriptions when the gateway is down. Best-
        // effort; the gateways webhook + reconcile sweep will clean any
        // surviving rows on the next tick anyway.
        await ctx.services.db.db
          .delete(schema.orderItems)
          .where(eq(schema.orderItems.orderId, orderId));
        await ctx.services.db.db.delete(schema.orders).where(eq(schema.orders.id, orderId));
        await ctx.services.db.db
          .delete(schema.subscriptions)
          .where(eq(schema.subscriptions.id, subscriptionId));
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message: `Falha ao gerar PIX no gateway: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        });
      }

      // 4. Insert transactions row tying the QR back to the order.
      const expiresAt = charge.pixExpiresAt ?? new Date(now.getTime() + pixExpiresInSeconds * 1000);
      const [txRow] = await ctx.services.db.db
        .insert(schema.transactions)
        .values({
          workspaceId: row.workspaceId,
          orderId,
          gatewayId: credRow.gatewayId,
          gatewayChargeId: charge.gatewayChargeId,
          method: 'pix',
          status: charge.status === 'paid' ? 'paid' : 'pending',
          amountCents: BigInt(row.planAmount),
          currency: row.planCurrency,
          idempotencyKey: `sub:${subscriptionId}:c1:pix`,
          pixQrCodeImage: charge.pixQrCodeImage ?? null,
          pixCopyPaste: charge.pixCopyPaste ?? null,
          expiresAt,
          rawResponse: { gatewayChargeId: charge.gatewayChargeId, cycle: 1 },
        })
        .returning({ id: schema.transactions.id });
      if (!txRow) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Não conseguimos registrar a transação PIX.',
        });
      }
      const transactionId = txRow.id;

      // 5. Link the active PIX charge back onto the subscription so the
      //    reminder worker + the dashboard can surface the open invoice.
      await ctx.services.db.db
        .update(schema.subscriptions)
        .set({ pixCurrentChargeId: transactionId, updatedAt: now })
        .where(eq(schema.subscriptions.id, subscriptionId));

      return {
        subscriptionId,
        publicReference,
        orderId,
        transactionId,
        pixQrCodeImage: charge.pixQrCodeImage ?? null,
        pixCopyPaste: charge.pixCopyPaste ?? null,
        pixExpiresAt: expiresAt,
      };
    }),

  /* ===================== Buyer-facing: poll status ===================== */

  status: publicProcedure
    .input(z.object({ subscriptionId: z.string().uuid() }))
    .output(
      z.object({
        status: SubscriptionStatus,
        publicReference: z.string(),
        productName: z.string(),
        planName: z.string(),
        nextChargeAt: z.date().nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.services.db.db
        .select({
          status: schema.subscriptions.status,
          publicReference: schema.subscriptions.publicReference,
          productName: schema.products.name,
          planName: schema.subscriptionPlans.name,
          nextChargeAt: schema.subscriptions.nextChargeAt,
        })
        .from(schema.subscriptions)
        .innerJoin(schema.products, eq(schema.products.id, schema.subscriptions.productId))
        .innerJoin(
          schema.subscriptionPlans,
          eq(schema.subscriptionPlans.id, schema.subscriptions.planId),
        )
        .where(eq(schema.subscriptions.id, input.subscriptionId))
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Assinatura não encontrada.' });
      }
      return {
        status: narrowSubscriptionStatus(row.status),
        publicReference: row.publicReference,
        productName: row.productName,
        planName: row.planName,
        nextChargeAt: row.nextChargeAt,
      };
    }),
});

function mintSubscriptionReference(): string {
  const random = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return `SUB-${random}`;
}

function narrowSubscriptionStatus(
  raw: string,
): 'pending' | 'active' | 'paused' | 'cancelled' | 'expired' {
  switch (raw) {
    case 'active':
      return 'active';
    case 'paused':
      return 'paused';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    default:
      return 'pending';
  }
}

function narrowPlanPaymentMethod(raw: string): 'card' | 'pix' | 'both' {
  switch (raw) {
    case 'pix':
      return 'pix';
    case 'both':
      return 'both';
    default:
      return 'card';
  }
}
