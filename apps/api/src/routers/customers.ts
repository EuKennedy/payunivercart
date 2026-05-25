import { schema } from '@payunivercart/db';
import { desc, eq, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc';

/**
 * Customers — derived view over `orders` grouped by `customerEmail`.
 *
 * We don't have a `customers` table on purpose: every domain table
 * already carries `customer_email + customer_phone_e164 + customer_name`
 * directly, so a separate identity table would risk drift between
 * "what the buyer typed" and "what the platform thinks of them".
 *
 * The downside is that name/phone for a given email can change across
 * orders (different family member, typo, etc.). We expose the
 * MOST-RECENT name and phone — usually what the producer wants to
 * see when reaching out.
 */

const Currency = z.enum(['BRL', 'USD', 'EUR']);

const CustomerRow = z.object({
  email: z.string(),
  customerName: z.string(),
  customerPhoneE164: z.string(),
  customerDocument: z.string(),
  hasWhatsappChatId: z.boolean(),
  orderCount: z.number().int().nonnegative(),
  paidCount: z.number().int().nonnegative(),
  paidTotalCents: z.number().int().nonnegative(),
  currency: Currency,
  firstOrderAt: z.date(),
  lastOrderAt: z.date(),
});

export const customersRouter = router({
  list: workspaceProcedure
    .input(
      z.object({ limit: z.number().int().min(1).max(200).default(100) }).default({ limit: 100 }),
    )
    .output(z.array(CustomerRow))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.services.db.db
        .select({
          email: schema.orders.customerEmail,
          customerName: sql<string>`(
            SELECT customer_name
            FROM orders o2
            WHERE o2.workspace_id = ${ctx.workspaceId}
              AND o2.customer_email = ${schema.orders.customerEmail}
            ORDER BY o2.created_at DESC
            LIMIT 1
          )`,
          customerPhoneE164: sql<string>`(
            SELECT customer_phone_e164
            FROM orders o2
            WHERE o2.workspace_id = ${ctx.workspaceId}
              AND o2.customer_email = ${schema.orders.customerEmail}
            ORDER BY o2.created_at DESC
            LIMIT 1
          )`,
          customerDocument: sql<string>`(
            SELECT customer_document
            FROM orders o2
            WHERE o2.workspace_id = ${ctx.workspaceId}
              AND o2.customer_email = ${schema.orders.customerEmail}
            ORDER BY o2.created_at DESC
            LIMIT 1
          )`,
          hasWhatsappChatId: sql<boolean>`bool_or(${schema.orders.customerWahaChatId} IS NOT NULL)`,
          orderCount: sql<number>`COUNT(*)::int`,
          paidCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.orders.status} = 'paid')::int`,
          paidTotalCents: sql<string>`COALESCE(SUM(${schema.orders.totalCents}) FILTER (WHERE ${schema.orders.status} = 'paid'), 0)`,
          currency: sql<string>`MAX(${schema.orders.currency}::text)`,
          firstOrderAt: sql<Date>`MIN(${schema.orders.createdAt})`,
          lastOrderAt: max(schema.orders.createdAt),
        })
        .from(schema.orders)
        .where(eq(schema.orders.workspaceId, ctx.workspaceId))
        .groupBy(schema.orders.customerEmail)
        .orderBy(desc(max(schema.orders.createdAt)))
        .limit(input.limit);

      return rows.map((r) => ({
        email: r.email,
        customerName: r.customerName ?? '',
        customerPhoneE164: r.customerPhoneE164 ?? '',
        customerDocument: r.customerDocument ?? '',
        hasWhatsappChatId: !!r.hasWhatsappChatId,
        orderCount: Number(r.orderCount ?? 0),
        paidCount: Number(r.paidCount ?? 0),
        paidTotalCents: Number(r.paidTotalCents ?? 0),
        currency: (r.currency ?? 'BRL') as z.infer<typeof Currency>,
        firstOrderAt: r.firstOrderAt as Date,
        lastOrderAt: r.lastOrderAt as Date,
      }));
    }),

  /**
   * Single customer detail by email. Returns the most-recent identity
   * fields + ALL orders (capped) so the producer can scan history in
   * one fetch. Email is the natural key since we don't have a customers
   * table — see this router's docblock.
   */
  byEmail: workspaceProcedure
    .input(z.object({ email: z.string().email() }))
    .output(
      z.object({
        email: z.string(),
        customerName: z.string(),
        customerPhoneE164: z.string(),
        customerDocument: z.string(),
        hasWhatsappChatId: z.boolean(),
        orderCount: z.number().int().nonnegative(),
        paidCount: z.number().int().nonnegative(),
        paidTotalCents: z.number().int().nonnegative(),
        currency: Currency,
        firstOrderAt: z.date(),
        lastOrderAt: z.date(),
        orders: z.array(
          z.object({
            id: z.string().uuid(),
            publicReference: z.string(),
            status: z.string(),
            totalCents: z.number().int().nonnegative(),
            currency: Currency,
            createdAt: z.date(),
            paidAt: z.date().nullable(),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      const email = input.email.toLowerCase();
      const [summary] = await ctx.services.db.db
        .select({
          customerName: sql<string>`(
            SELECT customer_name FROM orders o2
            WHERE o2.workspace_id = ${ctx.workspaceId}
              AND o2.customer_email = ${email}
            ORDER BY o2.created_at DESC LIMIT 1
          )`,
          customerPhoneE164: sql<string>`(
            SELECT customer_phone_e164 FROM orders o2
            WHERE o2.workspace_id = ${ctx.workspaceId}
              AND o2.customer_email = ${email}
            ORDER BY o2.created_at DESC LIMIT 1
          )`,
          customerDocument: sql<string>`(
            SELECT customer_document FROM orders o2
            WHERE o2.workspace_id = ${ctx.workspaceId}
              AND o2.customer_email = ${email}
            ORDER BY o2.created_at DESC LIMIT 1
          )`,
          hasWhatsappChatId: sql<boolean>`bool_or(${schema.orders.customerWahaChatId} IS NOT NULL)`,
          orderCount: sql<number>`COUNT(*)::int`,
          paidCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.orders.status} = 'paid')::int`,
          paidTotalCents: sql<string>`COALESCE(SUM(${schema.orders.totalCents}) FILTER (WHERE ${schema.orders.status} = 'paid'), 0)`,
          currency: sql<string>`MAX(${schema.orders.currency}::text)`,
          firstOrderAt: sql<Date>`MIN(${schema.orders.createdAt})`,
          lastOrderAt: max(schema.orders.createdAt),
        })
        .from(schema.orders)
        .where(
          sql`${schema.orders.workspaceId} = ${ctx.workspaceId}
            AND ${schema.orders.customerEmail} = ${email}`,
        );
      const orders = await ctx.services.db.db
        .select({
          id: schema.orders.id,
          publicReference: schema.orders.publicReference,
          status: schema.orders.status,
          totalCents: schema.orders.totalCents,
          currency: schema.orders.currency,
          createdAt: schema.orders.createdAt,
          paidAt: schema.orders.paidAt,
        })
        .from(schema.orders)
        .where(
          sql`${schema.orders.workspaceId} = ${ctx.workspaceId}
            AND ${schema.orders.customerEmail} = ${email}`,
        )
        .orderBy(desc(schema.orders.createdAt))
        .limit(50);
      return {
        email,
        customerName: summary?.customerName ?? '',
        customerPhoneE164: summary?.customerPhoneE164 ?? '',
        customerDocument: summary?.customerDocument ?? '',
        hasWhatsappChatId: !!summary?.hasWhatsappChatId,
        orderCount: Number(summary?.orderCount ?? 0),
        paidCount: Number(summary?.paidCount ?? 0),
        paidTotalCents: Number(summary?.paidTotalCents ?? 0),
        currency: (summary?.currency ?? 'BRL') as z.infer<typeof Currency>,
        firstOrderAt: (summary?.firstOrderAt as Date) ?? new Date(),
        lastOrderAt: (summary?.lastOrderAt as Date) ?? new Date(),
        orders: orders.map((o) => ({
          id: o.id,
          publicReference: o.publicReference,
          status: o.status,
          totalCents: Number(o.totalCents),
          currency: o.currency as z.infer<typeof Currency>,
          createdAt: o.createdAt,
          paidAt: o.paidAt,
        })),
      };
    }),
});
