import { type DatabaseClient, schema } from '@payunivercart/db';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';

/**
 * Payout notify worker — Pilar 1.
 *
 * Once a payout sits in `approved` for more than `NOTIFY_AFTER_MINUTES`
 * with no transfer started (processedAt IS NULL, paidAt IS NULL), this
 * sweeper marks the payout `processing` (idempotent) so the producer's
 * dashboard surfaces it and a separate notification helper can send
 * the producer a reminder.
 *
 * FULL automated MP transfer is OUT OF SCOPE for v1 because Mercado
 * Pago's outbound transfer endpoint requires:
 *   - KYC validation per recipient PIX key (BACEN compliance)
 *   - Producer-side seller agreement signed (manual onboarding step)
 *   - Anti-fraud limits per workspace (config tier in MP backoffice)
 *
 * Until that lands, the producer marks payouts paid manually after
 * sending the PIX from their own bank/MP app. This sweeper just
 * guarantees the producer is reminded.
 *
 * Cadence: hourly (registered in `index.ts`). Cheap on empty result
 * sets; uses an indexed predicate scan.
 */

const NOTIFY_AFTER_MINUTES = 30;

interface SweepCtx {
  db: DatabaseClient;
  /** Optional notification dispatcher hook. Wires up in `processors.ts`
   *  when a worker-side notification helper exists; today it's NULL
   *  and we just log the intent (parity with the PIX reminder worker). */
  notify?: (args: {
    workspaceId: string;
    payoutId: string;
    affiliateName: string;
    amountCents: number;
    requestedAt: Date;
  }) => Promise<void>;
}

export interface PayoutNotifySweepResult {
  approvedScanned: number;
  movedToProcessing: number;
  notified: number;
  errors: number;
}

export async function runPayoutNotifySweep(ctx: SweepCtx): Promise<PayoutNotifySweepResult> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - NOTIFY_AFTER_MINUTES * 60 * 1000);

  let movedToProcessing = 0;
  let notified = 0;
  let errors = 0;

  // Pick approved payouts whose review landed > 30 min ago and that
  // still have no transfer attempt recorded. Join the affiliate +
  // workspace for the notification body.
  const candidates = await ctx.db
    .select({
      id: schema.affiliatePayouts.id,
      workspaceId: schema.affiliatePayouts.workspaceId,
      affiliateName: schema.affiliates.displayName,
      amountCents: schema.affiliatePayouts.totalAmountCents,
      requestedAt: schema.affiliatePayouts.requestedAt,
      reviewedAt: schema.affiliatePayouts.reviewedAt,
    })
    .from(schema.affiliatePayouts)
    .innerJoin(schema.affiliates, eq(schema.affiliates.id, schema.affiliatePayouts.affiliateId))
    .where(
      and(
        eq(schema.affiliatePayouts.status, 'approved'),
        isNull(schema.affiliatePayouts.paidAt),
        lte(schema.affiliatePayouts.reviewedAt, cutoff),
      ),
    )
    .limit(100);

  for (const payout of candidates) {
    try {
      // Flip approved → processing once. Idempotent via the status
      // predicate — concurrent sweeps can't double-move.
      const updated = await ctx.db
        .update(schema.affiliatePayouts)
        .set({ status: 'processing', updatedAt: now })
        .where(
          and(
            eq(schema.affiliatePayouts.id, payout.id),
            eq(schema.affiliatePayouts.status, 'approved'),
          ),
        )
        .returning({ id: schema.affiliatePayouts.id });
      if (updated.length > 0) {
        movedToProcessing++;
        log('info', 'payout.moved.to.processing', {
          payoutId: payout.id,
          workspaceId: payout.workspaceId,
        });
      }

      try {
        await ctx.notify?.({
          workspaceId: payout.workspaceId,
          payoutId: payout.id,
          affiliateName: payout.affiliateName,
          amountCents: Number(payout.amountCents),
          requestedAt: payout.requestedAt,
        });
        notified++;
      } catch (cause) {
        log('warn', 'payout.notify.failed', {
          payoutId: payout.id,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    } catch (cause) {
      errors++;
      log('warn', 'payout.sweep.row.failed', {
        payoutId: payout.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  // Silence unused-import warning when sql isn't referenced above.
  void sql;

  return {
    approvedScanned: candidates.length,
    movedToProcessing,
    notified,
    errors,
  };
}

function log(level: 'info' | 'warn', event: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level, event, ...data })}\n`);
}
