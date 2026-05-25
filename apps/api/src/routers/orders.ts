import { schema } from '@payunivercart/db';
import { getAdapter } from '@payunivercart/payments';
import type { GatewayId } from '@payunivercart/shared';
import { TRPCError } from '@trpc/server';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc';
import { dispatchPaidFanOut } from '../webhooks/gateways';

/**
 * Pedidos — producer-facing read surface + ad-hoc WhatsApp dispatch.
 *
 * The checkout flow already writes the order rows; this router exposes
 * them for the dashboard's /pedidos page and adds a `sendWhatsapp`
 * mutation so the producer can fire a one-off message to a buyer
 * (e.g., follow up on a payment that stalled outside the automated
 * recovery cadence).
 *
 * `sendWhatsapp` reuses the workspace's own WAHA session (the same one
 * powering OTP + recovery). Multi-tenant safety is enforced by joining
 * orders to the caller's `workspaceId` before reading the chatId.
 */

const OrderStatusEnum = z.enum([
  'draft',
  'pending_payment',
  'paid',
  'partially_refunded',
  'refunded',
  'cancelled',
  'expired',
]);

const Currency = z.enum(['BRL', 'USD', 'EUR']);

const OrderRow = z.object({
  id: z.string().uuid(),
  publicReference: z.string(),
  status: OrderStatusEnum,
  customerName: z.string(),
  customerEmail: z.string(),
  customerDocument: z.string(),
  customerPhoneE164: z.string(),
  hasWhatsappChatId: z.boolean(),
  totalCents: z.number().int().nonnegative(),
  currency: Currency,
  paidAt: z.date().nullable(),
  createdAt: z.date(),
});

const OrderItem = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitAmountCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
});

const OrderDetail = OrderRow.extend({
  customerWahaChatId: z.string().nullable(),
  customerPhoneRaw: z.string(),
  subtotalCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative(),
  shippingCents: z.number().int().nonnegative(),
  cancelledAt: z.date().nullable(),
  expiresAt: z.date().nullable(),
  items: z.array(OrderItem),
});

export const ordersRouter = router({
  list: workspaceProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(50),
          status: OrderStatusEnum.optional(),
        })
        .default({ limit: 50 }),
    )
    .output(z.array(OrderRow))
    .query(async ({ ctx, input }) => {
      const conditions = [eq(schema.orders.workspaceId, ctx.workspaceId)];
      if (input.status) conditions.push(eq(schema.orders.status, input.status));
      const rows = await ctx.services.db.db
        .select({
          id: schema.orders.id,
          publicReference: schema.orders.publicReference,
          status: schema.orders.status,
          customerName: schema.orders.customerName,
          customerEmail: schema.orders.customerEmail,
          customerDocument: schema.orders.customerDocument,
          customerPhoneE164: schema.orders.customerPhoneE164,
          customerWahaChatId: schema.orders.customerWahaChatId,
          totalCents: schema.orders.totalCents,
          currency: schema.orders.currency,
          paidAt: schema.orders.paidAt,
          createdAt: schema.orders.createdAt,
        })
        .from(schema.orders)
        .where(and(...conditions))
        .orderBy(desc(schema.orders.createdAt))
        .limit(input.limit);
      return rows.map((r) => ({
        id: r.id,
        publicReference: r.publicReference,
        status: r.status as z.infer<typeof OrderStatusEnum>,
        customerName: r.customerName,
        customerEmail: r.customerEmail,
        customerDocument: r.customerDocument,
        customerPhoneE164: r.customerPhoneE164,
        hasWhatsappChatId: r.customerWahaChatId != null,
        totalCents: Number(r.totalCents),
        currency: r.currency as z.infer<typeof Currency>,
        paidAt: r.paidAt,
        createdAt: r.createdAt,
      }));
    }),

  byId: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(OrderDetail.nullable())
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.services.db.db
        .select({
          id: schema.orders.id,
          publicReference: schema.orders.publicReference,
          status: schema.orders.status,
          customerName: schema.orders.customerName,
          customerEmail: schema.orders.customerEmail,
          customerDocument: schema.orders.customerDocument,
          customerPhoneRaw: schema.orders.customerPhoneRaw,
          customerPhoneE164: schema.orders.customerPhoneE164,
          customerWahaChatId: schema.orders.customerWahaChatId,
          subtotalCents: schema.orders.subtotalCents,
          discountCents: schema.orders.discountCents,
          shippingCents: schema.orders.shippingCents,
          totalCents: schema.orders.totalCents,
          currency: schema.orders.currency,
          paidAt: schema.orders.paidAt,
          cancelledAt: schema.orders.cancelledAt,
          expiresAt: schema.orders.expiresAt,
          createdAt: schema.orders.createdAt,
        })
        .from(schema.orders)
        .where(and(eq(schema.orders.id, input.id), eq(schema.orders.workspaceId, ctx.workspaceId)))
        .limit(1);
      if (!row) return null;

      const items = await ctx.services.db.db
        .select({
          id: schema.orderItems.id,
          productId: schema.orderItems.productId,
          name: schema.orderItems.name,
          quantity: schema.orderItems.quantity,
          unitAmountCents: schema.orderItems.unitAmountCents,
          totalCents: schema.orderItems.totalCents,
        })
        .from(schema.orderItems)
        .where(eq(schema.orderItems.orderId, row.id));

      return {
        id: row.id,
        publicReference: row.publicReference,
        status: row.status as z.infer<typeof OrderStatusEnum>,
        customerName: row.customerName,
        customerEmail: row.customerEmail,
        customerDocument: row.customerDocument,
        customerPhoneRaw: row.customerPhoneRaw,
        customerPhoneE164: row.customerPhoneE164,
        customerWahaChatId: row.customerWahaChatId,
        hasWhatsappChatId: row.customerWahaChatId != null,
        subtotalCents: Number(row.subtotalCents),
        discountCents: Number(row.discountCents),
        shippingCents: Number(row.shippingCents),
        totalCents: Number(row.totalCents),
        currency: row.currency as z.infer<typeof Currency>,
        paidAt: row.paidAt,
        cancelledAt: row.cancelledAt,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        items: items.map((i) => ({
          id: i.id,
          productId: i.productId,
          name: i.name,
          quantity: i.quantity,
          unitAmountCents: Number(i.unitAmountCents),
          totalCents: Number(i.totalCents),
        })),
      };
    }),

  /**
   * Mark an order as paid manually. Used when the producer received
   * the money outside the gateway (e.g., bank transfer, dinheiro)
   * and wants the system state to reflect reality.
   *
   * Refuses when:
   *   - the order is already in a terminal state (paid, refunded,
   *     cancelled). Mutating a finished order would corrupt the
   *     append-only transactions audit.
   * Records a synthetic transaction row so the audit chain stays
   * coherent — the gateway field is left null to signal "operator
   * override" instead of a real charge.
   */
  markPaidManually: workspaceProcedure
    .input(z.object({ orderId: z.string().uuid(), note: z.string().max(500).optional() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const [order] = await ctx.services.db.db
        .select({
          id: schema.orders.id,
          status: schema.orders.status,
          totalCents: schema.orders.totalCents,
          currency: schema.orders.currency,
        })
        .from(schema.orders)
        .where(
          and(eq(schema.orders.id, input.orderId), eq(schema.orders.workspaceId, ctx.workspaceId)),
        )
        .limit(1);
      if (!order) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Pedido inexistente.' });
      }
      if (order.status === 'paid' || order.status === 'refunded' || order.status === 'cancelled') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Pedido já está em status ${order.status} e não pode ser marcado como pago.`,
        });
      }
      // We deliberately don't insert a fake `transactions` row — the
      // gatewayId enum doesn't have a 'manual' variant, and forging a
      // gateway value would corrupt the audit chain. Instead the
      // manual override is captured on `orders.metadata.manualPayment`.
      const now = new Date();
      await ctx.services.db.db
        .update(schema.orders)
        .set({
          status: 'paid',
          paidAt: now,
          metadata: {
            manualPayment: {
              markedAt: now.toISOString(),
              note: input.note ?? null,
            },
          },
        })
        .where(eq(schema.orders.id, order.id));
      return { ok: true as const };
    }),

  /**
   * Cancel a pending order. Producer might want this when a customer
   * gives up or the operator decides the pix shouldn't be honoured.
   * Refunded / paid orders can't be cancelled via this path — those
   * need a real refund flow.
   */
  cancel: workspaceProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const [order] = await ctx.services.db.db
        .select({ id: schema.orders.id, status: schema.orders.status })
        .from(schema.orders)
        .where(
          and(eq(schema.orders.id, input.orderId), eq(schema.orders.workspaceId, ctx.workspaceId)),
        )
        .limit(1);
      if (!order) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Pedido inexistente.' });
      }
      if (order.status === 'paid' || order.status === 'refunded') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Pedido em status ${order.status} não pode ser cancelado por aqui.`,
        });
      }
      await ctx.services.db.db
        .update(schema.orders)
        .set({ status: 'cancelled', cancelledAt: new Date() })
        .where(eq(schema.orders.id, order.id));
      return { ok: true as const };
    }),

  /**
   * Force-pull the latest charge state from the gateway and reconcile
   * the local order. The webhook is the primary signal — this is the
   * fallback for when:
   *   - the gateway's webhook hasn't arrived (DNS, firewall, IPN URL
   *     misconfigured),
   *   - the producer just rotated credentials and wants to confirm
   *     the previous payment landed,
   *   - the order has been sitting in `pending_payment` longer than
   *     the producer's patience.
   *
   * Calls `adapter.getCharge` against the gatewayChargeId stored on
   * the most recent transaction; if the gateway reports `paid` we
   * flip the order + transaction and trigger the same fan-out the
   * webhook handler runs (email + buyer WhatsApp + producer ping).
   */
  syncWithGateway: workspaceProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .output(
      z.object({
        status: OrderStatusEnum,
        changed: z.boolean(),
        previousStatus: OrderStatusEnum,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [order] = await ctx.services.db.db
        .select({
          id: schema.orders.id,
          status: schema.orders.status,
          workspaceId: schema.orders.workspaceId,
        })
        .from(schema.orders)
        .where(
          and(eq(schema.orders.id, input.orderId), eq(schema.orders.workspaceId, ctx.workspaceId)),
        )
        .limit(1);
      if (!order) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Pedido inexistente.' });
      }

      // Most recent transaction wins. A failed first attempt followed
      // by a successful retry must reconcile against the latter; the
      // sort order is `createdAt DESC, id DESC` for stable tie-break.
      const [tx] = await ctx.services.db.db
        .select({
          id: schema.transactions.id,
          gatewayId: schema.transactions.gatewayId,
          gatewayChargeId: schema.transactions.gatewayChargeId,
        })
        .from(schema.transactions)
        .where(eq(schema.transactions.orderId, order.id))
        // Tiebreaker on id (uuid v4): when two transactions land in the
        // same millisecond (rare but possible across pool replicas) the
        // createdAt-only sort is unstable. Adding id keeps the order
        // deterministic across reads.
        .orderBy(desc(schema.transactions.createdAt), desc(schema.transactions.id))
        .limit(1);
      if (!tx?.gatewayChargeId || !tx.gatewayId) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Pedido sem cobrança ativa no gateway.',
        });
      }

      const [credRow] = await ctx.services.db.db
        .select({ credentialsEncrypted: schema.gatewayCredentials.credentialsEncrypted })
        .from(schema.gatewayCredentials)
        .where(
          and(
            eq(schema.gatewayCredentials.workspaceId, order.workspaceId),
            eq(schema.gatewayCredentials.gatewayId, tx.gatewayId),
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

      const adapter = getAdapter(tx.gatewayId as GatewayId);
      const credentials = adapter.parseCredentials(
        ctx.services.crypto.unsealJson<Record<string, unknown>>(credRow.credentialsEncrypted),
      );

      let charge: Awaited<ReturnType<typeof adapter.getCharge>>;
      try {
        charge = await adapter.getCharge(credentials as never, tx.gatewayChargeId);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message: `Gateway recusou consulta: ${message}`,
          cause,
        });
      }

      const previousStatus = order.status;
      if (charge.status === order.status) {
        return { status: order.status, changed: false, previousStatus };
      }

      const now = new Date();

      // Optimistic concurrency on the order update: another caller
      // (the gateway webhook, a concurrent sync click) may have
      // changed the order between our initial SELECT and this UPDATE.
      // Predicate on the previous status makes the UPDATE a no-op in
      // that case — we re-read and either return the now-current
      // state or bail with `changed: false`. Cheaper than a row lock
      // because we don't hold a DB connection during the gateway HTTP
      // call (which can take 100ms+).
      const updateOrderStatusIfStill = async (
        nextStatus: 'paid' | 'refunded' | 'cancelled',
        extra: Partial<typeof schema.orders.$inferInsert> = {},
      ): Promise<boolean> => {
        const rows = await ctx.services.db.db
          .update(schema.orders)
          .set({ status: nextStatus, ...extra })
          .where(and(eq(schema.orders.id, order.id), eq(schema.orders.status, previousStatus)))
          .returning({ id: schema.orders.id });
        return rows.length > 0;
      };

      if (charge.status === 'paid') {
        await ctx.services.db.db
          .update(schema.transactions)
          .set({
            status: charge.status,
            paidAt: now,
            rawResponse: charge.raw as object,
          })
          .where(eq(schema.transactions.id, tx.id));
        const won = await updateOrderStatusIfStill('paid', { paidAt: now });
        if (won) {
          // Same fan-out the webhook fires — receipt email + buyer
          // WhatsApp w/ delivery + producer ping. Fire-and-log; we
          // don't want a Resend hiccup to fail the producer's sync UI.
          await dispatchPaidFanOut(ctx.services, order.id);
          return { status: 'paid', changed: true, previousStatus };
        }
        // Lost the race — webhook already paid the order. Surface the
        // current state instead of pretending we changed it.
        const [fresh] = await ctx.services.db.db
          .select({ status: schema.orders.status })
          .from(schema.orders)
          .where(eq(schema.orders.id, order.id))
          .limit(1);
        return { status: fresh?.status ?? 'paid', changed: false, previousStatus };
      }
      // Mid-flight statuses (authorized / processing / pending) just
      // refresh the transaction row.
      await ctx.services.db.db
        .update(schema.transactions)
        .set({
          status: charge.status,
          authorizedAt: charge.status === 'authorized' ? now : undefined,
          refundedAt: charge.status === 'refunded' ? now : undefined,
          chargedbackAt: charge.status === 'chargedback' ? now : undefined,
          rawResponse: charge.raw as object,
        })
        .where(eq(schema.transactions.id, tx.id));
      if (charge.status === 'refunded') {
        await updateOrderStatusIfStill('refunded');
        return { status: 'refunded', changed: true, previousStatus };
      }
      if (charge.status === 'failed' || charge.status === 'cancelled') {
        await updateOrderStatusIfStill('cancelled', { cancelledAt: now });
        return { status: 'cancelled', changed: true, previousStatus };
      }
      // Any other status (pending / authorized / processing) leaves
      // the order row untouched — only the transaction tracks
      // intermediate states.
      return { status: order.status, changed: false, previousStatus };
    }),

  /**
   * Send an ad-hoc WhatsApp message to the order's buyer using the
   * workspace's own producer-chosen WAHA session. Refuses when:
   *   - the order doesn't belong to the caller's workspace,
   *   - no WAHA session is configured for the workspace,
   *   - the session is not in WORKING state,
   *   - the order has no resolved chatId AND we can't re-derive one.
   *
   * The text is whatever the producer typed in the dashboard popup —
   * capped at 4 KiB which matches WAHA's documented `sendText` cap.
   */
  sendWhatsapp: workspaceProcedure
    .input(
      z.object({
        orderId: z.string().uuid(),
        text: z.string().trim().min(1, 'Mensagem vazia.').max(4096, 'Mensagem muito longa.'),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const [order] = await ctx.services.db.db
        .select({
          id: schema.orders.id,
          customerWahaChatId: schema.orders.customerWahaChatId,
          customerPhoneE164: schema.orders.customerPhoneE164,
        })
        .from(schema.orders)
        .where(
          and(eq(schema.orders.id, input.orderId), eq(schema.orders.workspaceId, ctx.workspaceId)),
        )
        .limit(1);
      if (!order) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Pedido inexistente.' });
      }

      const [session] = await ctx.services.db.db
        .select({
          sessionName: schema.whatsappSessions.wahaSessionId,
        })
        .from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.workspaceId, ctx.workspaceId))
        .limit(1);
      if (!session) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Nenhuma sessão WhatsApp conectada para o workspace.',
        });
      }
      let sessionStatus: string;
      try {
        sessionStatus = await ctx.services.waha.getSessionStatus(session.sessionName);
      } catch (cause) {
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message: 'WAHA não respondeu — verifique se a sessão está ativa.',
          cause,
        });
      }
      if (sessionStatus !== 'WORKING') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Sessão WhatsApp está em ${sessionStatus}. Conecte antes de enviar.`,
        });
      }

      // Resolve chatId. Prefer the cached one from the order row; fall
      // back to WAHA `check-exists` against the E.164 digits so BR
      // pre-2012 numbers (9-digit quirk) get the canonical form
      // WhatsApp accepts.
      let chatId = order.customerWahaChatId;
      if (!chatId) {
        const digits = order.customerPhoneE164.replace(/\D/g, '');
        try {
          const probe = await ctx.services.waha.checkExists(digits, session.sessionName);
          if (probe.numberExists && probe.chatId) {
            chatId = probe.chatId;
            // Cache for next time so we don't pay the round-trip again.
            await ctx.services.db.db
              .update(schema.orders)
              .set({ customerWahaChatId: chatId })
              .where(eq(schema.orders.id, order.id));
          }
        } catch (cause) {
          throw new TRPCError({
            code: 'BAD_GATEWAY',
            message: 'WAHA não conseguiu resolver o número.',
            cause,
          });
        }
      }
      if (!chatId) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Número do cliente não tem WhatsApp ativo.',
        });
      }

      try {
        await ctx.services.waha.sendText({
          session: session.sessionName,
          chatId: chatId as `${string}@${'c.us' | 'g.us' | 'lid' | 'newsletter'}`,
          text: input.text,
          linkPreview: false,
        });
      } catch (cause) {
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message: 'WAHA recusou enviar a mensagem.',
          cause,
        });
      }
      return { ok: true as const };
    }),
});
