import { schema } from '@payunivercart/db';
import { TRPCError } from '@trpc/server';
import { and, count, desc, eq, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import { router, superuserProcedure } from '../trpc';

/**
 * Super-admin router. Cross-tenant queries (no `workspaceId` predicate)
 * gated behind `superuserProcedure` so only env-allowlisted operators
 * can hit them.
 *
 * Scope today is read-only: list every producer + workspace + the
 * money flowing through. Impersonate, suspend, and platform-level
 * billing controls land in a follow-up — we ship the visibility surface
 * first because operations needs it BEFORE any destructive action.
 */

const WorkspaceRow = z.object({
  workspaceId: z.string().uuid(),
  workspaceName: z.string(),
  workspaceSlug: z.string(),
  companyName: z.string().nullable(),
  organizationId: z.string().uuid(),
  organizationName: z.string(),
  ownerEmail: z.string().nullable(),
  createdAt: z.date(),
  gmvCents: z.number().int().nonnegative(),
  paidOrders: z.number().int().nonnegative(),
  pendingOrders: z.number().int().nonnegative(),
  suspended: z.boolean(),
});

const TransactionRow = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  workspaceName: z.string(),
  orderRef: z.string(),
  customerName: z.string(),
  customerEmail: z.string(),
  amountCents: z.number().int().nonnegative(),
  currency: z.string(),
  status: z.string(),
  gatewayId: z.string().nullable(),
  method: z.string().nullable(),
  paidAt: z.date().nullable(),
  createdAt: z.date(),
});

export const adminRouter = router({
  /**
   * Every workspace on the platform with rolled-up money + counts.
   * Sorted by gmv desc so the operator sees the biggest tenants
   * first. Capped at 200 — bigger pages need a real pagination cursor.
   */
  workspaces: superuserProcedure.output(z.array(WorkspaceRow)).query(async ({ ctx }) => {
    const rows = await ctx.services.db.db
      .select({
        workspaceId: schema.workspaces.id,
        workspaceName: schema.workspaces.name,
        workspaceSlug: schema.workspaces.slug,
        companyName: schema.workspaces.companyName,
        suspended: schema.workspaces.suspended,
        organizationId: schema.organizations.id,
        organizationName: schema.organizations.name,
        ownerEmail: schema.users.email,
        createdAt: schema.workspaces.createdAt,
        gmvCents: sql<string>`COALESCE(SUM(CASE WHEN ${schema.orders.status} = 'paid' THEN ${schema.orders.totalCents} ELSE 0 END), 0)`,
        paidOrders: sql<number>`COUNT(*) FILTER (WHERE ${schema.orders.status} = 'paid')::int`,
        pendingOrders: sql<number>`COUNT(*) FILTER (WHERE ${schema.orders.status} = 'pending_payment')::int`,
      })
      .from(schema.workspaces)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.workspaces.organizationId),
      )
      .leftJoin(schema.users, eq(schema.users.id, schema.organizations.ownerId))
      .leftJoin(schema.orders, eq(schema.orders.workspaceId, schema.workspaces.id))
      .groupBy(
        schema.workspaces.id,
        schema.workspaces.name,
        schema.workspaces.slug,
        schema.workspaces.companyName,
        schema.workspaces.suspended,
        schema.organizations.id,
        schema.organizations.name,
        schema.users.email,
        schema.workspaces.createdAt,
      )
      .orderBy(
        desc(
          sql`COALESCE(SUM(CASE WHEN ${schema.orders.status} = 'paid' THEN ${schema.orders.totalCents} ELSE 0 END), 0)`,
        ),
      )
      .limit(200);
    return rows.map((r) => ({
      workspaceId: r.workspaceId,
      workspaceName: r.workspaceName,
      workspaceSlug: r.workspaceSlug,
      companyName: r.companyName,
      organizationId: r.organizationId,
      organizationName: r.organizationName,
      ownerEmail: r.ownerEmail,
      createdAt: r.createdAt,
      gmvCents: Number(r.gmvCents),
      paidOrders: Number(r.paidOrders),
      pendingOrders: Number(r.pendingOrders),
      suspended: r.suspended,
    }));
  }),

  /**
   * Latest N transactions across every workspace. Joins on orders to
   * surface customer + amount in one row.
   */
  recentTransactions: superuserProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).default({ limit: 50 }))
    .output(z.array(TransactionRow))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.services.db.db
        .select({
          id: schema.transactions.id,
          workspaceId: schema.transactions.workspaceId,
          workspaceName: schema.workspaces.name,
          orderRef: schema.orders.publicReference,
          customerName: schema.orders.customerName,
          customerEmail: schema.orders.customerEmail,
          amountCents: schema.transactions.amountCents,
          currency: schema.transactions.currency,
          status: schema.transactions.status,
          gatewayId: schema.transactions.gatewayId,
          method: schema.transactions.method,
          paidAt: schema.transactions.paidAt,
          createdAt: schema.transactions.createdAt,
        })
        .from(schema.transactions)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.transactions.orderId))
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.transactions.workspaceId))
        .orderBy(desc(schema.transactions.createdAt))
        .limit(input.limit);
      return rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        workspaceName: r.workspaceName,
        orderRef: r.orderRef,
        customerName: r.customerName,
        customerEmail: r.customerEmail,
        amountCents: Number(r.amountCents),
        currency: r.currency,
        status: r.status,
        gatewayId: r.gatewayId,
        method: r.method,
        paidAt: r.paidAt,
        createdAt: r.createdAt,
      }));
    }),

  /**
   * Platform-wide rollup. One snapshot the operator sees at the top
   * of `apps/admin`. Single query — uses subselects so each metric
   * touches its own filtered subset (avoids a giant join blow-up).
   */
  overview: superuserProcedure
    .output(
      z.object({
        producers: z.number().int().nonnegative(),
        workspaces: z.number().int().nonnegative(),
        paidGmvCents: z.number().int().nonnegative(),
        paidOrders: z.number().int().nonnegative(),
        pendingOrders: z.number().int().nonnegative(),
        suspendedWorkspaces: z.number().int().nonnegative(),
      }),
    )
    .query(async ({ ctx }) => {
      const [orgCount] = await ctx.services.db.db.select({ n: count() }).from(schema.organizations);
      const [wsAll] = await ctx.services.db.db
        .select({
          n: count(),
          suspended: sql<number>`COUNT(*) FILTER (WHERE ${schema.workspaces.suspended})::int`,
        })
        .from(schema.workspaces);
      const [orders] = await ctx.services.db.db
        .select({
          paid: sql<number>`COUNT(*) FILTER (WHERE ${schema.orders.status} = 'paid')::int`,
          pending: sql<number>`COUNT(*) FILTER (WHERE ${schema.orders.status} = 'pending_payment')::int`,
          paidGmv: sql<string>`COALESCE(SUM(${schema.orders.totalCents}) FILTER (WHERE ${schema.orders.status} = 'paid'), 0)`,
        })
        .from(schema.orders);
      return {
        producers: orgCount?.n ?? 0,
        workspaces: wsAll?.n ?? 0,
        suspendedWorkspaces: Number(wsAll?.suspended ?? 0),
        paidOrders: Number(orders?.paid ?? 0),
        pendingOrders: Number(orders?.pending ?? 0),
        paidGmvCents: Number(orders?.paidGmv ?? 0),
      };
    }),

  /**
   * Suspend or unsuspend a workspace. Suspended workspaces still see
   * their data but `workspaceProcedure` will refuse mutations once
   * we wire the guard (follow-up). Today the flag is a read.
   */
  setWorkspaceSuspended: superuserProcedure
    .input(z.object({ workspaceId: z.string().uuid(), suspended: z.boolean() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.services.db.db
        .update(schema.workspaces)
        .set({ suspended: input.suspended })
        .where(eq(schema.workspaces.id, input.workspaceId))
        .returning({ id: schema.workspaces.id });
      if (result.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace inexistente.' });
      }
      return { ok: true as const };
    }),
});

// Suppress the unused-import warnings for symbols imported above but
// not used in every code path (`and`, `sum`); the explicit list keeps
// the import grouping stable as more procedures land.
void and;
void sum;
