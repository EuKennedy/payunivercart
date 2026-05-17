import { DEFAULT_RECOVERY_STEPS, schema } from '@payunivercart/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc';

/**
 * Recovery cadence dashboard surface. Block 25 ships a read-only
 * view of the active campaign + a live activity feed. Editing the
 * cadence + templates lands in a follow-up block — for now the
 * default cadence (15min / 2h / 12h on WhatsApp) is seeded at
 * workspace bootstrap and runs automatically.
 */

const Step = z.object({
  delayMinutes: z.number().int().nonnegative(),
  channel: z.enum(['whatsapp', 'email']),
  template: z.string(),
});

const RecentRow = z.object({
  id: z.string().uuid(),
  status: z.string(),
  failureReason: z.string().nullable(),
  channel: z.enum(['whatsapp', 'email']),
  stepIndex: z.number().int(),
  scheduledFor: z.date(),
  sentAt: z.date().nullable(),
  customerName: z.string(),
  customerEmail: z.string(),
  publicReference: z.string(),
  totalCents: z.number().int().nonnegative(),
  currency: z.enum(['BRL', 'USD', 'EUR']),
  orderStatus: z.string(),
});

export const recoveryRouter = router({
  /**
   * The workspace's active campaign — or `null` when nothing's
   * configured (shouldn't happen post-Block-19's bootstrap seed,
   * defensively handled).
   */
  activeCampaign: workspaceProcedure
    .output(
      z
        .object({
          id: z.string().uuid(),
          name: z.string(),
          isActive: z.boolean(),
          triggerWindowMinutes: z.number().int().nonnegative(),
          steps: z.array(Step),
        })
        .nullable(),
    )
    .query(async ({ ctx }) => {
      const [existing] = await ctx.services.db.db
        .select({
          id: schema.recoveryCampaigns.id,
          name: schema.recoveryCampaigns.name,
          isActive: schema.recoveryCampaigns.isActive,
          triggerWindowMinutes: schema.recoveryCampaigns.triggerWindowMinutes,
          steps: schema.recoveryCampaigns.steps,
        })
        .from(schema.recoveryCampaigns)
        .where(eq(schema.recoveryCampaigns.workspaceId, ctx.workspaceId))
        .orderBy(desc(schema.recoveryCampaigns.createdAt))
        .limit(1);
      if (existing) {
        return {
          ...existing,
          steps: (existing.steps as unknown as z.infer<typeof Step>[]) ?? [],
        };
      }

      // Self-heal: pre-Block-25 workspaces never received the seed
      // from `provisionWorkspaceInTx`. Insert the default campaign
      // idempotently — the unique (workspace_id, name) index makes
      // concurrent calls converge on a single row.
      await ctx.services.db.db
        .insert(schema.recoveryCampaigns)
        .values({
          workspaceId: ctx.workspaceId,
          name: 'Padrão',
          isActive: true,
          triggerWindowMinutes: 30,
          steps: DEFAULT_RECOVERY_STEPS,
        })
        .onConflictDoNothing({
          target: [schema.recoveryCampaigns.workspaceId, schema.recoveryCampaigns.name],
        });

      const [seeded] = await ctx.services.db.db
        .select({
          id: schema.recoveryCampaigns.id,
          name: schema.recoveryCampaigns.name,
          isActive: schema.recoveryCampaigns.isActive,
          triggerWindowMinutes: schema.recoveryCampaigns.triggerWindowMinutes,
          steps: schema.recoveryCampaigns.steps,
        })
        .from(schema.recoveryCampaigns)
        .where(eq(schema.recoveryCampaigns.workspaceId, ctx.workspaceId))
        .orderBy(desc(schema.recoveryCampaigns.createdAt))
        .limit(1);
      if (!seeded) return null;
      return {
        ...seeded,
        steps: (seeded.steps as unknown as z.infer<typeof Step>[]) ?? [],
      };
    }),

  /**
   * Last N recovery attempts joined with the order for the activity
   * feed. Each row shows: customer, status pill, step index,
   * scheduledFor / sentAt + the order ref the cadence was firing
   * against.
   */
  recentAttempts: workspaceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }).default({ limit: 30 }))
    .output(z.array(RecentRow))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.services.db.db
        .select({
          id: schema.recoveryAttempts.id,
          status: schema.recoveryAttempts.status,
          failureReason: schema.recoveryAttempts.failureReason,
          channel: schema.recoveryAttempts.channel,
          stepIndex: schema.recoveryAttempts.stepIndex,
          scheduledFor: schema.recoveryAttempts.scheduledFor,
          sentAt: schema.recoveryAttempts.sentAt,
          customerName: schema.orders.customerName,
          customerEmail: schema.orders.customerEmail,
          publicReference: schema.orders.publicReference,
          totalCents: schema.orders.totalCents,
          currency: schema.orders.currency,
          orderStatus: schema.orders.status,
        })
        .from(schema.recoveryAttempts)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.recoveryAttempts.orderId))
        .where(eq(schema.recoveryAttempts.workspaceId, ctx.workspaceId))
        .orderBy(desc(schema.recoveryAttempts.scheduledFor))
        .limit(input.limit);
      return rows.map((r) => ({
        ...r,
        totalCents: Number(r.totalCents),
      }));
    }),

  /**
   * Toggle the active campaign on/off. Producer can pause the
   * cadence at any time (e.g., during a Black Friday rush when
   * delivery email is the priority channel).
   */
  setActive: workspaceProcedure
    .input(z.object({ campaignId: z.string().uuid(), isActive: z.boolean() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.db.db
        .update(schema.recoveryCampaigns)
        .set({ isActive: input.isActive })
        .where(
          and(
            eq(schema.recoveryCampaigns.id, input.campaignId),
            eq(schema.recoveryCampaigns.workspaceId, ctx.workspaceId),
          ),
        );
      return { ok: true as const };
    }),
});
