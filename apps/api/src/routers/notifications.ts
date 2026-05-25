import { schema } from '@payunivercart/db';
import { and, desc, eq, gt, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc';

/**
 * Activity feed for the producer's notification bell. Synthesises
 * "recent business events" from the existing domain tables — paid
 * orders, subscription activations, subscription cancellations,
 * affiliate commission availability.
 *
 * No separate `notifications` table on purpose: the source-of-truth
 * is already in each domain row's timestamp. A dedicated table would
 * drift the moment a webhook re-fires or a producer manually flips a
 * status — the feed just queries the canonical timestamps each time
 * the bell opens.
 *
 * "Unread" math is producer-local: the UI persists
 * `localStorage.notifications.lastSeenAt` and counts items above it.
 * Backend never tracks read state per-user (LGPD-cheap + zero schema
 * churn when we add new event types).
 */

const FeedItem = z.object({
  id: z.string(),
  kind: z.enum([
    'order_paid',
    'subscription_active',
    'subscription_cancelled',
    'commission_available',
  ]),
  title: z.string(),
  subtitle: z.string(),
  href: z.string().nullable(),
  amountCents: z.number().int().nullable(),
  currency: z.string().nullable(),
  occurredAt: z.date(),
});

export const notificationsRouter = router({
  /**
   * Returns up to `limit` recent activity events sorted by occurredAt
   * desc. Default 30 entries covers the typical bell-panel viewport
   * without paginating.
   */
  feed: workspaceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }).default({ limit: 30 }))
    .output(z.array(FeedItem))
    .query(async ({ ctx, input }) => {
      const db = ctx.services.db.db;
      const limit = input.limit;

      // 1. Paid orders — the bread-and-butter notification.
      const paidOrders = await db
        .select({
          id: schema.orders.id,
          publicReference: schema.orders.publicReference,
          customerName: schema.orders.customerName,
          totalCents: schema.orders.totalCents,
          currency: schema.orders.currency,
          paidAt: schema.orders.paidAt,
        })
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.workspaceId, ctx.workspaceId),
            eq(schema.orders.status, 'paid'),
            isNotNull(schema.orders.paidAt),
          ),
        )
        .orderBy(desc(schema.orders.paidAt))
        .limit(limit);

      // 2. Subscription activations.
      const subActivations = await db
        .select({
          id: schema.subscriptions.id,
          customerName: schema.subscriptions.customerName,
          startedAt: schema.subscriptions.startedAt,
          planAmount: schema.subscriptionPlans.amountCents,
          currency: schema.subscriptionPlans.currency,
        })
        .from(schema.subscriptions)
        .innerJoin(
          schema.subscriptionPlans,
          eq(schema.subscriptionPlans.id, schema.subscriptions.planId),
        )
        .where(
          and(
            eq(schema.subscriptions.workspaceId, ctx.workspaceId),
            eq(schema.subscriptions.status, 'active'),
            isNotNull(schema.subscriptions.startedAt),
          ),
        )
        .orderBy(desc(schema.subscriptions.startedAt))
        .limit(limit);

      // 3. Subscription cancellations.
      const subCancellations = await db
        .select({
          id: schema.subscriptions.id,
          customerName: schema.subscriptions.customerName,
          cancelledAt: schema.subscriptions.cancelledAt,
        })
        .from(schema.subscriptions)
        .where(
          and(
            eq(schema.subscriptions.workspaceId, ctx.workspaceId),
            eq(schema.subscriptions.status, 'cancelled'),
            isNotNull(schema.subscriptions.cancelledAt),
          ),
        )
        .orderBy(desc(schema.subscriptions.cancelledAt))
        .limit(limit);

      // 4. Affiliate commissions newly available.
      const commissions = await db
        .select({
          id: schema.affiliateCommissions.id,
          affiliateName: schema.affiliates.displayName,
          commissionAmountCents: schema.affiliateCommissions.commissionAmountCents,
          availableAt: schema.affiliateCommissions.availableAt,
        })
        .from(schema.affiliateCommissions)
        .innerJoin(
          schema.affiliates,
          eq(schema.affiliates.id, schema.affiliateCommissions.affiliateId),
        )
        .where(
          and(
            eq(schema.affiliateCommissions.workspaceId, ctx.workspaceId),
            eq(schema.affiliateCommissions.status, 'available'),
            // Only show within the last 30 days so old commissions
            // don't drown the recent stuff.
            gt(
              schema.affiliateCommissions.availableAt,
              new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            ),
          ),
        )
        .orderBy(desc(schema.affiliateCommissions.availableAt))
        .limit(limit);

      // 5. Merge + sort desc + slice to limit. JS-side merge is fine
      //    because each source already returned ≤ limit rows.
      const items: z.infer<typeof FeedItem>[] = [
        ...paidOrders.map((o) => ({
          id: `order:${o.id}`,
          kind: 'order_paid' as const,
          title: `Pedido pago de ${o.customerName}`,
          subtitle: o.publicReference,
          href: `/pedidos/${o.id}`,
          amountCents: Number(o.totalCents),
          currency: o.currency,
          occurredAt: o.paidAt as Date,
        })),
        ...subActivations.map((s) => ({
          id: `sub-active:${s.id}`,
          kind: 'subscription_active' as const,
          title: `Nova assinatura: ${s.customerName}`,
          subtitle: 'Cobrança recorrente iniciada',
          href: '/assinaturas',
          amountCents: Number(s.planAmount),
          currency: s.currency,
          occurredAt: s.startedAt as Date,
        })),
        ...subCancellations.map((s) => ({
          id: `sub-cancel:${s.id}`,
          kind: 'subscription_cancelled' as const,
          title: `Cancelou: ${s.customerName}`,
          subtitle: 'Assinatura encerrada',
          href: '/assinaturas',
          amountCents: null,
          currency: null,
          occurredAt: s.cancelledAt as Date,
        })),
        ...commissions.map((c) => ({
          id: `commission:${c.id}`,
          kind: 'commission_available' as const,
          title: `Comissão liberada — ${c.affiliateName}`,
          subtitle: 'Disponível para saque',
          href: '/configuracoes',
          amountCents: Number(c.commissionAmountCents),
          currency: 'BRL',
          occurredAt: c.availableAt as Date,
        })),
      ];

      items.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
      return items.slice(0, limit);
    }),
});
