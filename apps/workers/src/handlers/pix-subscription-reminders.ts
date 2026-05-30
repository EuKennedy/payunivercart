import { type DatabaseClient, schema } from '@payunivercart/db';
import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';

/**
 * PIX-recurring subscription lifecycle sweeper.
 *
 * Three responsibilities (hourly tick):
 *
 *   1. T-3 reminder — subscriptions with `paymentMethod='pix'`, status
 *      `active`, `currentCycleStatus='paid'`, and `nextChargeAt` within
 *      the next 72h get a `subscription_renewal_reminder` dispatch so
 *      the buyer knows the charge is coming.
 *
 *   2. Overdue ping — subscriptions with `currentCycleStatus IN
 *      (pending_pix, overdue)` whose due date passed but still inside
 *      grace get a `subscription_renewal_overdue` dispatch with the
 *      days remaining. State flips `pending_pix → overdue` on the
 *      first overdue tick so subsequent counts are correct.
 *
 *   3. Grace expiry — subscriptions where `nextChargeAt +
 *      gracePeriodDays < now()` and still unpaid get cancelled:
 *        - subscriptions.status = 'cancelled'
 *        - cancelReason = 'pix_grace_expired'
 *        - currentCycleStatus = 'cancelled_by_grace'
 *      And a `subscription_grace_expired` notification fires.
 *      Entitlement revoke via Connect dispatcher is fired separately
 *      (best-effort — partner SaaS yanks access on their side).
 *
 * Idempotent — every transition is gated by the current status. A
 * second sweep with no state changes is a no-op.
 *
 * The actual PIX charge GENERATION (calls MP createPix, persists new
 * transactions row, flips paid → pending_pix on due date) lives in a
 * sibling worker `pix-subscription-cycle` that runs every 5 minutes.
 * Splitting the two keeps each handler under 200 lines and lets ops
 * pause one without touching the other.
 */

const BATCH_SIZE = 100;

interface SweepCtx {
  db: DatabaseClient;
  /** Optional Connect dispatcher — when provided, grace expiry also
   *  fires `entitlement.revoked` to the partner SaaS. We type as
   *  `unknown` so the worker module stays free of API-layer imports;
   *  callers wire the real instance in `processors.ts`. */
  // biome-ignore lint/suspicious/noExplicitAny: see comment above.
  connectDispatcher?: { dispatch(args: { type: string; subscriptionId: string }): Promise<any> };
  /** Optional notification dispatcher hook. When omitted we just log
   *  the intent — useful for staged rollout where templates aren't
   *  wired into a renderer yet. */
  notify?: (args: {
    workspaceId: string;
    subscriptionId: string;
    eventKey:
      | 'subscription_renewal_reminder'
      | 'subscription_renewal_overdue'
      | 'subscription_grace_expired';
    vars: Record<string, string>;
  }) => Promise<void>;
}

export interface PixReminderSweepResult {
  remindersSent: number;
  overdueSent: number;
  graceExpired: number;
  errors: number;
}

export async function runPixSubscriptionReminderSweep(
  ctx: SweepCtx,
): Promise<PixReminderSweepResult> {
  const now = new Date();
  let remindersSent = 0;
  let overdueSent = 0;
  let graceExpired = 0;
  let errors = 0;

  // 1. T-3 reminders. Window: nextChargeAt in [now+1h, now+72h] so a
  // sub whose due date is "today" doesn't get both reminder + due in
  // the same tick.
  const reminderWindowStart = new Date(now.getTime() + 60 * 60 * 1000);
  const reminderWindowEnd = new Date(now.getTime() + 72 * 60 * 60 * 1000);
  const reminders = await ctx.db
    .select({
      id: schema.subscriptions.id,
      workspaceId: schema.subscriptions.workspaceId,
      customerName: schema.subscriptions.customerName,
      planAmountCents: schema.subscriptionPlans.amountCents,
      productName: schema.products.name,
      nextChargeAt: schema.subscriptions.nextChargeAt,
      publicReference: schema.subscriptions.publicReference,
    })
    .from(schema.subscriptions)
    .innerJoin(
      schema.subscriptionPlans,
      eq(schema.subscriptionPlans.id, schema.subscriptions.planId),
    )
    .innerJoin(schema.products, eq(schema.products.id, schema.subscriptions.productId))
    .where(
      and(
        eq(schema.subscriptions.paymentMethod, 'pix'),
        eq(schema.subscriptions.status, 'active'),
        eq(schema.subscriptions.currentCycleStatus, 'paid'),
        // sql guarantees the window predicate; drizzle's between() is
        // OK too but spelling it explicit keeps the comparison
        // ordering obvious to a reader.
        sql`${schema.subscriptions.nextChargeAt} BETWEEN ${reminderWindowStart} AND ${reminderWindowEnd}`,
      ),
    )
    .limit(BATCH_SIZE);
  for (const sub of reminders) {
    try {
      await ctx.notify?.({
        workspaceId: sub.workspaceId,
        subscriptionId: sub.id,
        eventKey: 'subscription_renewal_reminder',
        vars: {
          nome: firstName(sub.customerName),
          produto: sub.productName,
          valor: formatBRL(sub.planAmountCents),
          vencimento: sub.nextChargeAt?.toLocaleDateString('pt-BR') ?? '—',
          codigo: sub.publicReference,
        },
      });
      remindersSent++;
    } catch (cause) {
      errors++;
      log('warn', 'pix.reminder.dispatch.failed', {
        subscriptionId: sub.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  // 2. Overdue dispatch — sub still has unpaid PIX inside grace.
  const overdue = await ctx.db
    .select({
      id: schema.subscriptions.id,
      workspaceId: schema.subscriptions.workspaceId,
      customerName: schema.subscriptions.customerName,
      planAmountCents: schema.subscriptionPlans.amountCents,
      productName: schema.products.name,
      nextChargeAt: schema.subscriptions.nextChargeAt,
      publicReference: schema.subscriptions.publicReference,
      gracePeriodDays: schema.subscriptions.gracePeriodDays,
      currentCycleStatus: schema.subscriptions.currentCycleStatus,
    })
    .from(schema.subscriptions)
    .innerJoin(
      schema.subscriptionPlans,
      eq(schema.subscriptionPlans.id, schema.subscriptions.planId),
    )
    .innerJoin(schema.products, eq(schema.products.id, schema.subscriptions.productId))
    .where(
      and(
        eq(schema.subscriptions.paymentMethod, 'pix'),
        eq(schema.subscriptions.status, 'active'),
        inArray(schema.subscriptions.currentCycleStatus, ['pending_pix', 'overdue']),
        lte(schema.subscriptions.nextChargeAt, now),
        sql`(${schema.subscriptions.nextChargeAt} + (${schema.subscriptions.gracePeriodDays} || ' days')::interval) > NOW()`,
      ),
    )
    .limit(BATCH_SIZE);
  for (const sub of overdue) {
    try {
      // Flip pending_pix → overdue on first overdue tick so the
      // notification copy reads correctly + status reflects the real
      // state in the producer dashboard.
      if (sub.currentCycleStatus === 'pending_pix') {
        await ctx.db
          .update(schema.subscriptions)
          .set({ currentCycleStatus: 'overdue', updatedAt: new Date() })
          .where(eq(schema.subscriptions.id, sub.id));
      }
      const dueDate = sub.nextChargeAt ?? now;
      const expiresAt = new Date(dueDate.getTime() + sub.gracePeriodDays * 86_400_000);
      const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000));
      await ctx.notify?.({
        workspaceId: sub.workspaceId,
        subscriptionId: sub.id,
        eventKey: 'subscription_renewal_overdue',
        vars: {
          nome: firstName(sub.customerName),
          produto: sub.productName,
          valor: formatBRL(sub.planAmountCents),
          codigo: sub.publicReference,
          // `link` populated by the dispatch helper from the active
          // PIX charge row — left empty here so the template renders
          // `{link}` (callers should patch when present).
          link: '',
          diasRestantes: String(daysLeft),
        },
      });
      overdueSent++;
    } catch (cause) {
      errors++;
      log('warn', 'pix.overdue.dispatch.failed', {
        subscriptionId: sub.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  // 3. Grace expiry — flip to cancelled + dispatch + revoke.
  const expired = await ctx.db
    .select({
      id: schema.subscriptions.id,
      workspaceId: schema.subscriptions.workspaceId,
      customerName: schema.subscriptions.customerName,
      productName: schema.products.name,
      publicReference: schema.subscriptions.publicReference,
    })
    .from(schema.subscriptions)
    .innerJoin(schema.products, eq(schema.products.id, schema.subscriptions.productId))
    .where(
      and(
        eq(schema.subscriptions.paymentMethod, 'pix'),
        eq(schema.subscriptions.status, 'active'),
        inArray(schema.subscriptions.currentCycleStatus, ['pending_pix', 'overdue']),
        sql`(${schema.subscriptions.nextChargeAt} + (${schema.subscriptions.gracePeriodDays} || ' days')::interval) <= NOW()`,
      ),
    )
    .limit(BATCH_SIZE);
  for (const sub of expired) {
    try {
      await ctx.db
        .update(schema.subscriptions)
        .set({
          status: 'cancelled',
          cancelReason: 'pix_grace_expired',
          cancelledAt: now,
          currentCycleStatus: 'cancelled_by_grace',
          updatedAt: now,
        })
        .where(eq(schema.subscriptions.id, sub.id));

      try {
        await ctx.connectDispatcher?.dispatch({
          type: 'entitlement.revoked',
          subscriptionId: sub.id,
        });
      } catch (cause) {
        log('warn', 'pix.grace.revoke.failed', {
          subscriptionId: sub.id,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }

      await ctx.notify?.({
        workspaceId: sub.workspaceId,
        subscriptionId: sub.id,
        eventKey: 'subscription_grace_expired',
        vars: {
          nome: firstName(sub.customerName),
          produto: sub.productName,
          codigo: sub.publicReference,
        },
      });
      graceExpired++;
      log('info', 'pix.grace.expired', { subscriptionId: sub.id });
    } catch (cause) {
      errors++;
      log('warn', 'pix.grace.flip.failed', {
        subscriptionId: sub.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  // Silence drizzle's unused-import warning when the SQL fragments
  // above happen to be the only consumers in a given build.
  void or;

  return { remindersSent, overdueSent, graceExpired, errors };
}

function firstName(full: string): string {
  return (full.split(/\s+/)[0] ?? full).trim();
}

export function formatBRL(cents: bigint | number): string {
  const n = typeof cents === 'bigint' ? Number(cents) : cents;
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  }).format(n / 100);
}

function log(level: 'info' | 'warn', event: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level, event, ...data })}\n`);
}
