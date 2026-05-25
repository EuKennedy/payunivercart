import { schema } from '@payunivercart/db';
import { and, eq, sql } from 'drizzle-orm';

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

  return { flipped: flipped.length, totalsRefreshed: true };
}
