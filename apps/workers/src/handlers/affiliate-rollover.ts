import { schema } from '@payunivercart/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { emitWebhookFromWorker } from '../webhooks/emit';

/**
 * Affiliate commission rollover sweep.
 *
 * Hourly job that:
 *   1. Flips `affiliate_commissions.status = 'pending'` to `'available'`
 *      when the refund window has passed (available_at < now).
 *   2. Recomputes the materialised `affiliates.lifetime_earned_cents`
 *      so the dashboard counter doesn't drift.
 *
 * Idempotent and cheap when there's nothing to flip — both queries
 * short-circuit on empty result sets.
 *
 * Implementation lives in the workers package (not the API package)
 * to keep the API tree-shake clean and so the worker container can be
 * scaled independently in deploys with high commission volume.
 */

interface RolloverInput {
  // biome-ignore lint/suspicious/noExplicitAny: drizzle's PgDatabase generic doesn't compose across packages cleanly; runtime call is stable.
  db: any;
}

export async function rolloverPendingCommissions(
  input: RolloverInput,
): Promise<{ flipped: number; totalsRefreshed: boolean }> {
  const { db } = input;
  const flipped = await db
    .update(schema.affiliateCommissions)
    .set({ status: 'available' })
    .where(
      and(
        eq(schema.affiliateCommissions.status, 'pending'),
        sql`${schema.affiliateCommissions.availableAt} < now()`,
      ),
    )
    .returning({ id: schema.affiliateCommissions.id });

  if (flipped.length === 0) {
    return { flipped: 0, totalsRefreshed: false };
  }

  // Refresh the lifetime counter. Single UPDATE with a WITH-CTE keeps
  // it one round-trip even when thousands of rows changed.
  await db.execute(sql`
    WITH totals AS (
      SELECT affiliate_id, SUM(commission_amount_cents) AS total
      FROM affiliate_commissions
      WHERE status IN ('available', 'paid')
      GROUP BY affiliate_id
    )
    UPDATE affiliates a
    SET lifetime_earned_cents = totals.total
    FROM totals
    WHERE a.id = totals.affiliate_id
  `);

  // Outbound webhook: `affiliate.commission.available` per flipped row.
  // Best-effort — failure here must not roll the rollover back.
  try {
    const flippedIds = flipped.map((r: { id: string }) => r.id);
    const rows = await db
      .select({
        id: schema.affiliateCommissions.id,
        workspaceId: schema.affiliateCommissions.workspaceId,
        affiliateId: schema.affiliateCommissions.affiliateId,
        orderId: schema.affiliateCommissions.orderId,
        status: schema.affiliateCommissions.status,
        commissionAmountCents: schema.affiliateCommissions.commissionAmountCents,
        currency: schema.affiliateCommissions.currency,
        cycleNumber: schema.affiliateCommissions.cycleNumber,
        availableAt: schema.affiliateCommissions.availableAt,
        paidAt: schema.affiliateCommissions.paidAt,
        createdAt: schema.affiliateCommissions.createdAt,
      })
      .from(schema.affiliateCommissions)
      .where(inArray(schema.affiliateCommissions.id, flippedIds));

    for (const r of rows) {
      await emitWebhookFromWorker(db, {
        workspaceId: r.workspaceId,
        eventType: 'affiliate.commission.available',
        object: {
          id: r.id,
          workspace_id: r.workspaceId,
          affiliate_id: r.affiliateId,
          order_id: r.orderId ?? '',
          status: r.status,
          commission_amount_cents: Number(r.commissionAmountCents),
          currency: r.currency,
          cycle_number: r.cycleNumber,
          available_at: r.availableAt instanceof Date ? r.availableAt.toISOString() : r.availableAt,
          paid_at: r.paidAt instanceof Date ? r.paidAt.toISOString() : r.paidAt,
          created_at: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
        },
      });
    }
  } catch (cause) {
    process.stdout.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'affiliate.rollover.webhook.emit.failed',
        error: cause instanceof Error ? cause.message : String(cause),
      })}\n`,
    );
  }

  return { flipped: flipped.length, totalsRefreshed: true };
}
