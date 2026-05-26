import { type DatabaseClient, schema } from '@payunivercart/db';
import { type WahaChatId, type WahaClient, isRetryableError } from '@payunivercart/waha';
import { and, eq, lte } from 'drizzle-orm';

/**
 * Cart-recovery sweeper. Runs every minute (cron via BullMQ
 * repeatable) and dispatches WhatsApp messages for any
 * `recovery_attempts` row whose `scheduled_for` has passed.
 *
 * Concurrency: multiple worker processes claim rows atomically via
 *   UPDATE ... SET status='processing' WHERE id=$1 AND status='queued'
 * If the affected row count is 0 the row was claimed by another
 * worker — we skip without erroring.
 *
 * Failure mode: any unexpected error during dispatch flips the row to
 * `status='failed'` with `failure_reason`. The producer's dashboard
 * surfaces these so they can re-queue manually after fixing the
 * WhatsApp session.
 *
 * WAHA WEBJS rate ceiling: the engine itself doesn't expose a rate
 * limit but WhatsApp's anti-spam will ban a session that bursts dozens
 * of messages per minute. We cap the per-sweep batch and sleep between
 * sends so the producer's account stays healthy. Sequential — never
 * parallel.
 */

const BATCH_SIZE = 10;
/**
 * Sleep between successive `sendText` calls. WhatsApp's anti-spam
 * heuristics flag bursts; an inter-message gap close to typical human
 * cadence keeps the session out of the danger zone. Tuned empirically
 * from BR funnel operations.
 */
const INTER_MESSAGE_DELAY_MS = 1_800;

/**
 * Max times the worker re-queues a single row on transient failures
 * (WAHA timeout, 5xx, network). After this many tries we flip the row
 * to `failed` permanently so it stops consuming sweep budget. Spread
 * across 4 attempts with exponentially-growing scheduledFor offsets
 * (1m, 5m, 15m, 30m) the worker has ≈50 minutes of recovery window
 * after the first failure — long enough to ride a typical WAHA hiccup.
 */
const MAX_TRANSIENT_RETRIES = 3;
/** Backoff schedule in seconds, indexed by next `attemptCount` (1-N). */
const RETRY_DELAYS_SECONDS = [60, 5 * 60, 15 * 60, 30 * 60];

interface SweepResult {
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Rows that hit a transient error and got re-scheduled with backoff
   *  instead of being marked failed. Surfaced in the worker log so ops
   *  can see retries happening without scanning the table directly. */
  requeued: number;
}

interface SweepCtx {
  db: DatabaseClient;
  waha: WahaClient;
}

interface RecoveryStepShape {
  delayMinutes: number;
  channel: 'whatsapp' | 'email';
  template: string;
}

export async function runRecoverySweep(ctx: SweepCtx): Promise<SweepResult> {
  const due = await ctx.db
    .select({
      id: schema.recoveryAttempts.id,
      workspaceId: schema.recoveryAttempts.workspaceId,
      orderId: schema.recoveryAttempts.orderId,
      stepIndex: schema.recoveryAttempts.stepIndex,
      targetIdentifier: schema.recoveryAttempts.targetIdentifier,
      channel: schema.recoveryAttempts.channel,
      campaignId: schema.recoveryAttempts.campaignId,
      attemptCount: schema.recoveryAttempts.attemptCount,
    })
    .from(schema.recoveryAttempts)
    .where(
      and(
        eq(schema.recoveryAttempts.status, 'queued'),
        lte(schema.recoveryAttempts.scheduledFor, new Date()),
      ),
    )
    .limit(BATCH_SIZE);

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let requeued = 0;

  for (const [index, attempt] of due.entries()) {
    const claimed = await claim(ctx.db, attempt.id);
    if (!claimed) continue;

    try {
      const status = await processAttempt(ctx, attempt);
      if (status === 'sent') {
        sent++;
        // Pace the next send so we don't burst WhatsApp's anti-spam.
        if (index < due.length - 1) await sleep(INTER_MESSAGE_DELAY_MS);
      } else if (status === 'skipped') {
        skipped++;
      } else {
        failed++;
      }
    } catch (cause) {
      // Transient WAHA error (5xx, timeout, network) + room left in
      // the retry budget → re-queue with backoff instead of marking
      // failed. Producer keeps their recovery cadence alive across a
      // WAHA deploy / hiccup. Non-retryable errors (4xx, bad chatId,
      // invalid session) skip straight to `failed` because re-sending
      // the same request can't recover.
      const reason = cause instanceof Error ? cause.message : String(cause);
      const nextAttempt = attempt.attemptCount + 1;
      const retryable = isRetryableError(cause);
      if (retryable && nextAttempt <= MAX_TRANSIENT_RETRIES) {
        const delaySec =
          RETRY_DELAYS_SECONDS[nextAttempt - 1] ??
          RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1] ??
          60;
        const scheduledFor = new Date(Date.now() + delaySec * 1000);
        await ctx.db
          .update(schema.recoveryAttempts)
          .set({
            status: 'queued',
            attemptCount: nextAttempt,
            scheduledFor,
            failureReason: `retry-${nextAttempt}/${MAX_TRANSIENT_RETRIES}: ${reason.slice(0, 400)}`,
          })
          .where(eq(schema.recoveryAttempts.id, attempt.id));
        requeued++;
        logEvent('recovery.attempt.requeued', {
          attemptId: attempt.id,
          workspaceId: attempt.workspaceId,
          attempt: nextAttempt,
          retryAt: scheduledFor.toISOString(),
        });
      } else {
        await ctx.db
          .update(schema.recoveryAttempts)
          .set({
            status: 'failed',
            failureReason: reason.slice(0, 500),
            attemptCount: nextAttempt,
          })
          .where(eq(schema.recoveryAttempts.id, attempt.id));
        failed++;
        logEvent('recovery.attempt.failed', {
          attemptId: attempt.id,
          workspaceId: attempt.workspaceId,
          attempts: nextAttempt,
          retryable,
          reason: reason.slice(0, 200),
        });
      }
    }
  }

  return { processed: due.length, sent, skipped, failed, requeued };
}

/** Structured stdout for ops dashboards / log aggregation. */
function logEvent(event: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level: 'info', event, ...data })}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function claim(db: DatabaseClient, attemptId: string): Promise<boolean> {
  const rows = await db
    .update(schema.recoveryAttempts)
    .set({ status: 'processing' })
    .where(
      and(eq(schema.recoveryAttempts.id, attemptId), eq(schema.recoveryAttempts.status, 'queued')),
    )
    .returning({ id: schema.recoveryAttempts.id });
  return rows.length > 0;
}

async function processAttempt(
  ctx: SweepCtx,
  attempt: {
    id: string;
    workspaceId: string;
    orderId: string | null;
    stepIndex: number;
    targetIdentifier: string;
    channel: 'whatsapp' | 'email';
    campaignId: string;
    attemptCount: number;
  },
): Promise<'sent' | 'skipped' | 'failed'> {
  if (attempt.channel !== 'whatsapp') {
    await mark(ctx.db, attempt.id, 'skipped', 'channel_not_supported');
    return 'skipped';
  }
  if (!attempt.orderId) {
    await mark(ctx.db, attempt.id, 'skipped', 'no_subject');
    return 'skipped';
  }

  // 1. Load order — bail if it already settled / cancelled / expired.
  const [order] = await ctx.db
    .select({
      id: schema.orders.id,
      status: schema.orders.status,
      customerName: schema.orders.customerName,
      totalCents: schema.orders.totalCents,
      currency: schema.orders.currency,
      publicReference: schema.orders.publicReference,
    })
    .from(schema.orders)
    .where(eq(schema.orders.id, attempt.orderId))
    .limit(1);
  if (!order) {
    await mark(ctx.db, attempt.id, 'skipped', 'order_not_found');
    return 'skipped';
  }
  if (order.status !== 'pending_payment') {
    await mark(ctx.db, attempt.id, 'skipped', `order_status:${order.status}`);
    return 'skipped';
  }

  // 2. Load the first order item for the template's {produto} variable.
  const [item] = await ctx.db
    .select({ name: schema.orderItems.name })
    .from(schema.orderItems)
    .where(eq(schema.orderItems.orderId, order.id))
    .limit(1);

  // 3. Load the campaign step template.
  const [campaign] = await ctx.db
    .select({ steps: schema.recoveryCampaigns.steps })
    .from(schema.recoveryCampaigns)
    .where(eq(schema.recoveryCampaigns.id, attempt.campaignId))
    .limit(1);
  const steps = (campaign?.steps as unknown as RecoveryStepShape[] | null) ?? [];
  const step = steps[attempt.stepIndex];
  if (!step?.template) {
    await mark(ctx.db, attempt.id, 'failed', 'template_missing');
    return 'failed';
  }

  // 4. Resolve the producer's WAHA session name. The old auto-derived
  // `ws_<workspaceId>` scheme stopped working once producers got to
  // pick their own session name (Block 24). Look it up from the
  // mirror row instead — fail loud if it's missing so the dashboard
  // can prompt the producer to reconnect.
  const [sessionRow] = await ctx.db
    .select({ sessionName: schema.whatsappSessions.wahaSessionId })
    .from(schema.whatsappSessions)
    .where(eq(schema.whatsappSessions.workspaceId, attempt.workspaceId))
    .limit(1);
  if (!sessionRow) {
    await mark(ctx.db, attempt.id, 'failed', 'whatsapp_session_missing');
    return 'failed';
  }
  const sessionName = sessionRow.sessionName;

  let sessionStatus: string;
  try {
    sessionStatus = await ctx.waha.getSessionStatus(sessionName);
  } catch (cause) {
    await mark(
      ctx.db,
      attempt.id,
      'failed',
      `whatsapp_session_unreachable:${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return 'failed';
  }
  if (sessionStatus !== 'WORKING') {
    await mark(ctx.db, attempt.id, 'failed', `whatsapp_session_status:${sessionStatus}`);
    return 'failed';
  }

  // 5. Verify the cached chatId is still valid OR resolve it now. For
  // BR pre-2012 mobile numbers the heuristic-only guess we did at
  // checkout time can land on the wrong 10/11-digit variant; we
  // canonicalise via WAHA `check-exists` and write back the value so
  // every subsequent step uses the form WhatsApp actually accepts.
  let chatId: WahaChatId = attempt.targetIdentifier as WahaChatId;
  try {
    const digits = chatId.split('@')[0]?.replace(/\D/g, '') ?? '';
    if (digits.length >= 8) {
      const probe = await ctx.waha.checkExists(digits, sessionName);
      if (!probe.numberExists) {
        await mark(ctx.db, attempt.id, 'skipped', 'number_does_not_have_whatsapp');
        return 'skipped';
      }
      if (probe.chatId && probe.chatId !== chatId) {
        chatId = probe.chatId;
        // Persist the canonical form on the order so manual sends from
        // the dashboard reuse it without paying the round-trip.
        await ctx.db
          .update(schema.orders)
          .set({ customerWahaChatId: chatId })
          .where(eq(schema.orders.id, order.id));
      }
    }
  } catch (cause) {
    await mark(
      ctx.db,
      attempt.id,
      'failed',
      `check_exists_failed:${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return 'failed';
  }

  // 6. Render template + dispatch.
  const text = renderTemplate(step.template, {
    nome: firstName(order.customerName),
    produto: item?.name ?? '',
    valor: formatBRL(Number(order.totalCents), order.currency),
    codigo: order.publicReference,
  });

  await ctx.waha.sendTextWithRetry(
    {
      session: sessionName,
      chatId,
      text,
      linkPreview: false,
    },
    {
      // Each sweep already has its own re-queue layer; the WAHA-level
      // retry covers the small in-tick blip (a single re-issue of the
      // same request) so a 1-of-10 batch hiccup doesn't burn the
      // entire requeue budget.
      maxAttempts: 2,
    },
  );

  await ctx.db
    .update(schema.recoveryAttempts)
    .set({ status: 'sent', sentAt: new Date(), failureReason: null })
    .where(eq(schema.recoveryAttempts.id, attempt.id));
  return 'sent';
}

async function mark(
  db: DatabaseClient,
  attemptId: string,
  status: 'skipped' | 'failed' | 'sent',
  reason: string | null,
): Promise<void> {
  await db
    .update(schema.recoveryAttempts)
    .set({ status, failureReason: reason })
    .where(eq(schema.recoveryAttempts.id, attemptId));
}

function firstName(full: string): string {
  return (full.split(/\s+/)[0] ?? full).trim();
}

function formatBRL(cents: number, currency: string): string {
  const locale = currency === 'BRL' ? 'pt-BR' : 'en-US';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(v);
  }
  return out;
}
