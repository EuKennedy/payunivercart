import { type DatabaseClient, schema } from '@payunivercart/db';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';

/**
 * Affiliate fraud auto-suspend sweeper.
 *
 * Pilar 1 ships a fraud-signals append-only ledger (see
 * `affiliate_fraud_signals` + the detectors in
 * `apps/api/src/affiliates/tracker.ts`). Signals classify into:
 *   - `info`     worth noting (e.g. IP velocity slightly above mean)
 *   - `warn`     probable abuse (ip self-attribution, repeated bursts)
 *   - `critical` confirmed fraud (chargeback ring, stolen card)
 *
 * Without an enforcement layer the ledger is just an audit log — a
 * fraudster keeps earning until a producer manually suspends them.
 * This worker closes the loop hourly:
 *
 *   - ANY `severity='critical'` signal in the last 7 days that is
 *     unresolved → suspend the affiliate's memberships in that
 *     workspace immediately.
 *   - ≥3 `severity='warn'` signals from the same affiliate in the
 *     last 7 days → suspend.
 *
 * Suspension flips `affiliate_memberships.status='suspended'` +
 * `suspendedAt=now` + `suspendedReason='auto:<rule>'`. It DOES NOT
 * touch existing commissions — that's the refund / payout flow's
 * job. The producer can review and reactivate via the dashboard.
 *
 * Idempotent: skipping memberships already in suspended state means
 * a second sweep with no new signals is a no-op.
 */

const LOOKBACK_HOURS = 24 * 7; // 7 days
const WARN_THRESHOLD = 3;

interface SweepCtx {
  db: DatabaseClient;
}

export interface FraudAutoSuspendResult {
  criticalsActioned: number;
  warnsActioned: number;
  membershipsSuspended: number;
  errors: number;
}

export async function runAffiliateFraudAutoSuspendSweep(
  ctx: SweepCtx,
): Promise<FraudAutoSuspendResult> {
  const lookbackStart = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
  let criticalsActioned = 0;
  let warnsActioned = 0;
  let membershipsSuspended = 0;
  let errors = 0;

  // 1. Aggregate signals per (workspace, affiliate). One round-trip,
  // GROUP BY so we don't ship every signal row across the wire — we
  // only care about counts per severity bucket.
  const groups = await ctx.db
    .select({
      workspaceId: schema.affiliateFraudSignals.workspaceId,
      affiliateId: schema.affiliateFraudSignals.affiliateId,
      severity: schema.affiliateFraudSignals.severity,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.affiliateFraudSignals)
    .where(
      and(
        gte(schema.affiliateFraudSignals.createdAt, lookbackStart),
        // Only consider unresolved signals — resolved ones were
        // explicitly cleared by an operator and shouldn't trigger
        // automatic action.
        sql`${schema.affiliateFraudSignals.resolvedAt} IS NULL`,
      ),
    )
    .groupBy(
      schema.affiliateFraudSignals.workspaceId,
      schema.affiliateFraudSignals.affiliateId,
      schema.affiliateFraudSignals.severity,
    );

  // Pivot into per-(workspace, affiliate) bucket counts.
  const bucket = new Map<
    string,
    { workspaceId: string; affiliateId: string; warns: number; criticals: number }
  >();
  for (const row of groups) {
    const key = `${row.workspaceId}::${row.affiliateId}`;
    const entry = bucket.get(key) ?? {
      workspaceId: row.workspaceId,
      affiliateId: row.affiliateId,
      warns: 0,
      criticals: 0,
    };
    if (row.severity === 'critical') entry.criticals += Number(row.n ?? 0);
    if (row.severity === 'warn') entry.warns += Number(row.n ?? 0);
    bucket.set(key, entry);
  }

  for (const entry of bucket.values()) {
    let reason: string | null = null;
    if (entry.criticals > 0) {
      reason = `auto:critical_signal x${entry.criticals}`;
      criticalsActioned++;
    } else if (entry.warns >= WARN_THRESHOLD) {
      reason = `auto:warn_threshold x${entry.warns}`;
      warnsActioned++;
    }
    if (!reason) continue;

    try {
      const result = await ctx.db
        .update(schema.affiliateMemberships)
        .set({
          status: 'suspended',
          suspendedAt: new Date(),
          suspendedReason: reason,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.affiliateMemberships.workspaceId, entry.workspaceId),
            eq(schema.affiliateMemberships.affiliateId, entry.affiliateId),
            inArray(schema.affiliateMemberships.status, ['approved', 'pending']),
          ),
        )
        .returning({ id: schema.affiliateMemberships.id });
      membershipsSuspended += result.length;
      if (result.length > 0) {
        log('warn', 'affiliate.fraud.auto_suspended', {
          workspaceId: entry.workspaceId,
          affiliateId: entry.affiliateId,
          reason,
          memberships: result.length,
        });
      }
    } catch (cause) {
      errors++;
      log('warn', 'affiliate.fraud.auto_suspend.failed', {
        workspaceId: entry.workspaceId,
        affiliateId: entry.affiliateId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { criticalsActioned, warnsActioned, membershipsSuspended, errors };
}

function log(level: 'info' | 'warn', event: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level, event, ...data })}\n`);
}
