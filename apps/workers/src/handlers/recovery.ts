import { type DatabaseClient, schema } from '@payunivercart/db';
import type { WahaClient } from '@payunivercart/waha';
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
 */

const BATCH_SIZE = 25;

interface SweepResult {
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
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

  for (const attempt of due) {
    const claimed = await claim(ctx.db, attempt.id);
    if (!claimed) continue;

    try {
      const status = await processAttempt(ctx, attempt);
      if (status === 'sent') sent++;
      else if (status === 'skipped') skipped++;
      else failed++;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      await ctx.db
        .update(schema.recoveryAttempts)
        .set({ status: 'failed', failureReason: reason.slice(0, 500) })
        .where(eq(schema.recoveryAttempts.id, attempt.id));
      failed++;
    }
  }

  return { processed: due.length, sent, skipped, failed };
}

async function claim(db: DatabaseClient, attemptId: string): Promise<boolean> {
  const rows = await db
    .update(schema.recoveryAttempts)
    .set({ status: 'processing' })
    .where(
      and(
        eq(schema.recoveryAttempts.id, attemptId),
        eq(schema.recoveryAttempts.status, 'queued'),
      ),
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

  // 4. Make sure the workspace's WAHA session is up.
  const sessionName = `ws_${attempt.workspaceId.replace(/-/g, '')}`;
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
    await mark(
      ctx.db,
      attempt.id,
      'failed',
      `whatsapp_session_status:${sessionStatus}`,
    );
    return 'failed';
  }

  // 5. Render template + dispatch.
  const text = renderTemplate(step.template, {
    nome: firstName(order.customerName),
    produto: item?.name ?? '',
    valor: formatBRL(Number(order.totalCents), order.currency),
    codigo: order.publicReference,
  });

  await ctx.waha.sendText({
    session: sessionName,
    chatId: attempt.targetIdentifier,
    text,
    linkPreview: false,
  });

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
