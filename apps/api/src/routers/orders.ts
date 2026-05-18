import { schema } from '@payunivercart/db';
import { TRPCError } from '@trpc/server';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc';

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
