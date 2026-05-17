import { schema } from '@payunivercart/db';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc';

/**
 * Producer-facing metrics for the dashboard hero + activity feed.
 *
 * Block 23 scope:
 *   - overview: GMV + orders today vs yesterday, conversion rate.
 *   - recentOrders: latest N orders with status + customer + amount.
 *
 * Conversion is computed against the producer's OWN funnel:
 *   created → paid. A real visitor counter (PostHog/Plausible) lands
 *   with Block 30 observability. Until then this gives an honest
 *   read of "what % of started checkouts converted into payment".
 *
 * Every query is tenant-scoped via an explicit `workspaceId` predicate
 * (defense-in-depth on top of RLS, see the route comments in B20).
 */

const OrderStatus = z.enum([
  'draft',
  'pending_payment',
  'paid',
  'partially_refunded',
  'refunded',
  'cancelled',
  'expired',
]);

export const metricsRouter = router({
  /**
   * Today + yesterday rollups, plus all-time totals so the producer
   * always has SOMETHING on screen even on a slow day.
   */
  overview: workspaceProcedure
    .output(
      z.object({
        today: z.object({
          gmvCents: z.number().int().nonnegative(),
          orderCount: z.number().int().nonnegative(),
          paidCount: z.number().int().nonnegative(),
        }),
        yesterday: z.object({
          gmvCents: z.number().int().nonnegative(),
          orderCount: z.number().int().nonnegative(),
          paidCount: z.number().int().nonnegative(),
        }),
        allTime: z.object({
          gmvCents: z.number().int().nonnegative(),
          paidCount: z.number().int().nonnegative(),
        }),
        conversionRateLast30d: z.number().min(0).max(1),
      }),
    )
    .query(async ({ ctx }) => {
      const { db } = ctx.services.db;

      // Window expressions kept inside the SQL so we evaluate them on
      // the DB clock — avoids client/server clock-skew flicker.
      const todayStart = sql<Date>`date_trunc('day', now() at time zone 'America/Sao_Paulo')`;
      const yesterdayStart = sql<Date>`date_trunc('day', now() at time zone 'America/Sao_Paulo') - interval '1 day'`;
      const todayEnd = sql<Date>`date_trunc('day', now() at time zone 'America/Sao_Paulo') + interval '1 day'`;
      const thirtyDaysAgo = sql<Date>`now() - interval '30 days'`;

      const [todayRow] = await db
        .select({
          gmv: sql<string>`coalesce(sum(${schema.orders.totalCents}) filter (where ${schema.orders.status} = 'paid'), 0)`,
          orders: sql<string>`count(*)`,
          paid: sql<string>`count(*) filter (where ${schema.orders.status} = 'paid')`,
        })
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.workspaceId, ctx.workspaceId),
            gte(schema.orders.createdAt, todayStart),
            lt(schema.orders.createdAt, todayEnd),
          ),
        );

      const [yesterdayRow] = await db
        .select({
          gmv: sql<string>`coalesce(sum(${schema.orders.totalCents}) filter (where ${schema.orders.status} = 'paid'), 0)`,
          orders: sql<string>`count(*)`,
          paid: sql<string>`count(*) filter (where ${schema.orders.status} = 'paid')`,
        })
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.workspaceId, ctx.workspaceId),
            gte(schema.orders.createdAt, yesterdayStart),
            lt(schema.orders.createdAt, todayStart),
          ),
        );

      const [allTimeRow] = await db
        .select({
          gmv: sql<string>`coalesce(sum(${schema.orders.totalCents}) filter (where ${schema.orders.status} = 'paid'), 0)`,
          paid: sql<string>`count(*) filter (where ${schema.orders.status} = 'paid')`,
        })
        .from(schema.orders)
        .where(eq(schema.orders.workspaceId, ctx.workspaceId));

      const [convRow] = await db
        .select({
          total: sql<string>`count(*)`,
          paid: sql<string>`count(*) filter (where ${schema.orders.status} = 'paid')`,
        })
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.workspaceId, ctx.workspaceId),
            gte(schema.orders.createdAt, thirtyDaysAgo),
          ),
        );

      const total30 = Number(convRow?.total ?? '0');
      const paid30 = Number(convRow?.paid ?? '0');
      const conversionRateLast30d = total30 > 0 ? paid30 / total30 : 0;

      return {
        today: {
          gmvCents: numFromBigintStr(todayRow?.gmv),
          orderCount: Number(todayRow?.orders ?? '0'),
          paidCount: Number(todayRow?.paid ?? '0'),
        },
        yesterday: {
          gmvCents: numFromBigintStr(yesterdayRow?.gmv),
          orderCount: Number(yesterdayRow?.orders ?? '0'),
          paidCount: Number(yesterdayRow?.paid ?? '0'),
        },
        allTime: {
          gmvCents: numFromBigintStr(allTimeRow?.gmv),
          paidCount: Number(allTimeRow?.paid ?? '0'),
        },
        conversionRateLast30d,
      };
    }),

  /**
   * Most recent orders. Drives the activity feed below the metric
   * cards. Caps at 20 — bigger fetches come from the Pedidos page
   * (lands in a follow-up block) with pagination.
   */
  recentOrders: workspaceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(10) }).default({ limit: 10 }))
    .output(
      z.array(
        z.object({
          id: z.string().uuid(),
          publicReference: z.string(),
          customerName: z.string(),
          customerEmail: z.string(),
          totalCents: z.number().int().nonnegative(),
          currency: z.enum(['BRL', 'USD', 'EUR']),
          status: OrderStatus,
          createdAt: z.date(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.services.db.db
        .select({
          id: schema.orders.id,
          publicReference: schema.orders.publicReference,
          customerName: schema.orders.customerName,
          customerEmail: schema.orders.customerEmail,
          totalCents: schema.orders.totalCents,
          currency: schema.orders.currency,
          status: schema.orders.status,
          createdAt: schema.orders.createdAt,
        })
        .from(schema.orders)
        .where(eq(schema.orders.workspaceId, ctx.workspaceId))
        .orderBy(desc(schema.orders.createdAt))
        .limit(input.limit);

      return rows.map((r) => ({
        id: r.id,
        publicReference: r.publicReference,
        customerName: r.customerName,
        customerEmail: r.customerEmail,
        totalCents: Number(r.totalCents),
        currency: r.currency,
        status: r.status,
        createdAt: r.createdAt,
      }));
    }),
});

/**
 * Drizzle hands us a string for bigint aggregates (Postgres returns
 * numeric/bigint as a string to avoid JS precision loss). Cents fit
 * comfortably under 2^53 for our domain (R$ 100k limit per product,
 * platform-wide GMV would have to exceed ~R$ 90 trillion to overflow),
 * so the Number cast is safe.
 */
function numFromBigintStr(value: string | null | undefined): number {
  if (value == null) return 0;
  return Number(value);
}
