import { type DatabaseClient, schema } from '@payunivercart/db';
import type { WahaClient } from '@payunivercart/waha';
import { eq, ne } from 'drizzle-orm';

/**
 * WhatsApp session liveness sweeper.
 *
 * Why this exists: the producer dashboard's "WhatsApp connected"
 * indicator reads from the local `whatsapp_sessions.status` mirror.
 * That mirror is only refreshed when the producer opens the
 * integrations page (`whatsapp.me` query does a best-effort sync).
 *
 * So a session that crashes at 02:00 stays "WORKING" in our DB until
 * the producer logs in. Meanwhile the recovery sweep silently fails
 * every dispatch with `whatsapp_session_status:STOPPED` and nothing
 * surfaces. This worker closes the loop by polling WAHA every 5
 * minutes and reflecting the real status in the mirror — so the
 * dashboard's status chip and the notification bell are honest about
 * what's actually live.
 *
 * Scope: only sweeps sessions that currently THINK they're WORKING.
 * Sessions already marked SCAN_QR_CODE / STARTING / FAILED / STOPPED
 * are skipped because their state is producer-driven (they're waiting
 * for a QR scan, or were deliberately stopped); WAHA's view is less
 * authoritative there.
 *
 * Failure handling: a single WAHA outage during the sweep would
 * incorrectly flip every session to FAILED. We tolerate transient
 * errors by treating "WAHA unreachable" as "unknown" and skipping the
 * mirror update entirely — never overwriting WORKING with garbage.
 */

const BATCH_SIZE = 50;

interface HealthSweepCtx {
  db: DatabaseClient;
  waha: WahaClient;
}

export interface HealthSweepResult {
  scanned: number;
  unchanged: number;
  flipped: number;
  errors: number;
}

export async function runWhatsappSessionHealthSweep(
  ctx: HealthSweepCtx,
): Promise<HealthSweepResult> {
  const rows = await ctx.db
    .select({
      id: schema.whatsappSessions.id,
      workspaceId: schema.whatsappSessions.workspaceId,
      wahaSessionId: schema.whatsappSessions.wahaSessionId,
      status: schema.whatsappSessions.status,
    })
    .from(schema.whatsappSessions)
    // Only sessions the dashboard currently considers live. Other
    // states are producer-driven and would noise-up the sweep.
    .where(eq(schema.whatsappSessions.status, 'WORKING'))
    .limit(BATCH_SIZE);

  let unchanged = 0;
  let flipped = 0;
  let errors = 0;

  for (const row of rows) {
    let liveStatus: string;
    try {
      liveStatus = await ctx.waha.getSessionStatus(row.wahaSessionId);
    } catch (cause) {
      // WAHA unreachable / transient HTTP error → do NOT overwrite the
      // mirror. Log and move on; the next sweep will retry.
      errors++;
      process.stdout.write(
        `${JSON.stringify({
          level: 'warn',
          event: 'whatsapp.session.health.probe_failed',
          workspaceId: row.workspaceId,
          wahaSessionId: row.wahaSessionId,
          error: cause instanceof Error ? cause.message : String(cause),
        })}\n`,
      );
      continue;
    }

    if (liveStatus === row.status) {
      unchanged++;
      continue;
    }

    // Status drift detected — reflect WAHA's view in the mirror and
    // structured-log the transition so ops can correlate dispatch
    // failures with the moment a session went down.
    await ctx.db
      .update(schema.whatsappSessions)
      .set({
        status: liveStatus,
        disconnectedAt:
          liveStatus !== 'WORKING' && row.status === 'WORKING' ? new Date() : undefined,
        updatedAt: new Date(),
      })
      .where(eq(schema.whatsappSessions.id, row.id));
    flipped++;
    process.stdout.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'whatsapp.session.health.drift',
        workspaceId: row.workspaceId,
        wahaSessionId: row.wahaSessionId,
        from: row.status,
        to: liveStatus,
      })}\n`,
    );
  }

  // Keep this exported so the workers test suite can call it once with
  // a stub DB+WAHA and assert the contract. The `ne` import dependency
  // remains in case future logic needs to query non-WORKING rows.
  void ne;

  return { scanned: rows.length, unchanged, flipped, errors };
}
