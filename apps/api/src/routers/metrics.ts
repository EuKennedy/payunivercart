import { schema } from '@payunivercart/db';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc';

const PeriodDays = z.enum(['7', '30', '90']);

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

  /**
   * Daily timeline for the hero area chart. Buckets ALL orders in the
   * window by the producer's wall-clock day (America/Sao_Paulo) and
   * splits revenue (paid) vs created (every row). Returns a dense
   * series — days with zero orders are filled with `0` so the chart
   * draws a continuous baseline instead of jumping gaps.
   */
  timeline: workspaceProcedure
    .input(z.object({ days: PeriodDays.default('30') }).default({ days: '30' as const }))
    .output(
      z.array(
        z.object({
          date: z.string(),
          revenueCents: z.number().int().nonnegative(),
          paidOrders: z.number().int().nonnegative(),
          createdOrders: z.number().int().nonnegative(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const days = Number(input.days);
      const since = sql<Date>`date_trunc('day', now() at time zone 'America/Sao_Paulo') - make_interval(days => ${days - 1})`;

      const rows = await ctx.services.db.db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${schema.orders.createdAt} at time zone 'America/Sao_Paulo'), 'YYYY-MM-DD')`,
          revenue: sql<string>`coalesce(sum(${schema.orders.totalCents}) filter (where ${schema.orders.status} = 'paid'), 0)`,
          paid: sql<string>`count(*) filter (where ${schema.orders.status} = 'paid')`,
          created: sql<string>`count(*)`,
        })
        .from(schema.orders)
        .where(
          and(eq(schema.orders.workspaceId, ctx.workspaceId), gte(schema.orders.createdAt, since)),
        )
        .groupBy(
          sql`date_trunc('day', ${schema.orders.createdAt} at time zone 'America/Sao_Paulo')`,
        );

      // Dense fill: build an index of YYYY-MM-DD keys for the full
      // window so the chart has zeros for empty days. Using UTC math
      // for the iteration key avoids DST surprises.
      const map = new Map<string, (typeof rows)[number]>();
      for (const r of rows) map.set(r.day, r);

      const out: {
        date: string;
        revenueCents: number;
        paidOrders: number;
        createdOrders: number;
      }[] = [];
      const today = new Date();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - i);
        const key = d.toISOString().slice(0, 10);
        const row = map.get(key);
        out.push({
          date: key,
          revenueCents: numFromBigintStr(row?.revenue),
          paidOrders: Number(row?.paid ?? '0'),
          createdOrders: Number(row?.created ?? '0'),
        });
      }
      return out;
    }),

  /**
   * Top selling products by paid revenue in the window. Joins
   * order_items → products so a product renamed AFTER a sale still
   * shows under its current name (matches what the producer sees on
   * the catalogue page).
   */
  topProducts: workspaceProcedure
    .input(
      z
        .object({
          days: PeriodDays.default('30'),
          limit: z.number().int().min(1).max(20).default(5),
        })
        .default({ days: '30' as const, limit: 5 }),
    )
    .output(
      z.array(
        z.object({
          productId: z.string().uuid(),
          name: z.string(),
          slug: z.string(),
          paidOrders: z.number().int().nonnegative(),
          revenueCents: z.number().int().nonnegative(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const days = Number(input.days);
      const since = sql<Date>`now() - make_interval(days => ${days})`;

      const rows = await ctx.services.db.db
        .select({
          productId: schema.orderItems.productId,
          name: schema.products.name,
          slug: schema.products.slug,
          paid: sql<string>`count(distinct ${schema.orders.id})`,
          revenue: sql<string>`coalesce(sum(${schema.orderItems.totalCents}), 0)`,
        })
        .from(schema.orderItems)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.orderItems.orderId))
        .innerJoin(schema.products, eq(schema.products.id, schema.orderItems.productId))
        .where(
          and(
            eq(schema.orders.workspaceId, ctx.workspaceId),
            eq(schema.orders.status, 'paid'),
            gte(schema.orders.createdAt, since),
          ),
        )
        .groupBy(schema.orderItems.productId, schema.products.name, schema.products.slug)
        .orderBy(sql`sum(${schema.orderItems.totalCents}) desc`)
        .limit(input.limit);

      return rows.map((r) => ({
        productId: r.productId,
        name: r.name,
        slug: r.slug,
        paidOrders: Number(r.paid),
        revenueCents: numFromBigintStr(r.revenue),
      }));
    }),

  /**
   * Payment method split for the donut. We read from `transactions`
   * (not `orders`) because the method lives there — a refunded or
   * failed attempt still counts as one method's volume. Limited to
   * `paid` transactions so a buyer who switched from card to pix
   * doesn't get double-counted.
   */
  paymentMethods: workspaceProcedure
    .input(z.object({ days: PeriodDays.default('30') }).default({ days: '30' as const }))
    .output(
      z.array(
        z.object({
          method: z.enum(['pix', 'credit_card', 'boleto']),
          paidCount: z.number().int().nonnegative(),
          revenueCents: z.number().int().nonnegative(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const days = Number(input.days);
      const since = sql<Date>`now() - make_interval(days => ${days})`;

      const rows = await ctx.services.db.db
        .select({
          method: schema.transactions.method,
          paid: sql<string>`count(*)`,
          revenue: sql<string>`coalesce(sum(${schema.transactions.amountCents}), 0)`,
        })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.workspaceId, ctx.workspaceId),
            eq(schema.transactions.status, 'paid'),
            gte(schema.transactions.createdAt, since),
          ),
        )
        .groupBy(schema.transactions.method);

      return rows
        .filter(
          (r): r is typeof r & { method: 'pix' | 'credit_card' | 'boleto' } =>
            r.method === 'pix' || r.method === 'credit_card' || r.method === 'boleto',
        )
        .map((r) => ({
          method: r.method,
          paidCount: Number(r.paid),
          revenueCents: numFromBigintStr(r.revenue),
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
