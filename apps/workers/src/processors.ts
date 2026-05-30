import { CryptoService, loadKeyRegistryFromEnv } from '@payunivercart/crypto';
import { createDatabaseClient } from '@payunivercart/db';
import { WahaClient } from '@payunivercart/waha';
import { Worker, type WorkerOptions } from 'bullmq';
import type IORedis from 'ioredis';
import type { WorkersEnv } from './env';
import { runAffiliateFraudAutoSuspendSweep } from './handlers/affiliate-fraud-auto-suspend';
import { runAffiliateProgramBackfill } from './handlers/affiliate-program-backfill';
import { runConnectDeliveriesSweep } from './handlers/connect-deliveries';
import { runMarketplaceRollup } from './handlers/marketplace-rollup';
import { runPayoutNotifySweep } from './handlers/payout-notify';
import { runPixSubscriptionCycleSweep } from './handlers/pix-subscription-cycle';
import { runPixSubscriptionReminderSweep } from './handlers/pix-subscription-reminders';
import { runRecoverySweep } from './handlers/recovery';
import { createSubscriptionNotifier } from './handlers/subscription-notify';
import { runSubscriptionReconcileSweep } from './handlers/subscription-reconcile';
import { runTrackingDispatchSweep } from './handlers/tracking-dispatch';
import { runWebhookOutboxSweep } from './handlers/webhook-outbox-dispatcher';
import { runWhatsappSessionHealthSweep } from './handlers/whatsapp-session-health';
import { QUEUE_NAMES } from './queues';

/**
 * BullMQ job processors. Workers are instantiated once per process and
 * registered against the relevant queue. Heavy lifting per queue lives
 * in `./handlers/*` so this file stays a dispatch table.
 */

interface WorkerCtx {
  env: WorkersEnv;
  connection: IORedis;
  concurrency: number;
}

export function startWorkers(ctx: WorkerCtx): Worker[] {
  const opts: WorkerOptions = { connection: ctx.connection, concurrency: ctx.concurrency };

  // Process-wide shared clients. Each worker handler that touches DB
  // or WAHA uses these — sharing avoids per-job connection churn.
  const dbWrapper = createDatabaseClient({ connectionString: ctx.env.DATABASE_URL });
  const waha = new WahaClient({
    baseUrl: ctx.env.WAHA_BASE_URL,
    apiKey: ctx.env.WAHA_API_KEY,
  });

  // Shared CryptoService — Pilar 2 dispatcher unseals provider
  // credentials per dispatch; constructing it once per process avoids
  // re-loading the KEK registry on every worker tick.
  const cryptoRegistry = loadKeyRegistryFromEnv({
    keysEnv: ctx.env.ENCRYPTION_KEYS,
    activeKeyIdEnv: ctx.env.ENCRYPTION_ACTIVE_KEY_ID,
    envVarName: 'ENCRYPTION_KEYS',
  });
  const crypto = new CryptoService(cryptoRegistry);

  // Customer-facing WhatsApp dispatcher for the PIX recurring lifecycle.
  // Shared by the cycle worker (delivers the fresh QR) and the reminder
  // worker (T-3 / overdue / grace dunning).
  const subscriptionNotifier = createSubscriptionNotifier({ db: dbWrapper.db, waha });

  const webhookInbound = new Worker(
    QUEUE_NAMES.webhookInbound,
    async (job) => {
      logEvent('webhook.inbound.received', { jobId: job.id, payloadKeys: Object.keys(job.data) });
      return { ack: true };
    },
    opts,
  );

  const webhookOutbox = new Worker(
    QUEUE_NAMES.webhookOutbox,
    async (job) => {
      const result = await runWebhookOutboxSweep({ db: dbWrapper.db });
      logEvent('webhook.outbox.sweep', { jobId: job.id, ...result });
      return result;
    },
    opts,
  );

  const recovery = new Worker(
    QUEUE_NAMES.recovery,
    async (job) => {
      // The recovery queue is driven by a single repeatable "sweep"
      // job that fires every 60s (registered in index.ts). Each tick
      // scans `recovery_attempts` for rows whose scheduled_for has
      // passed and dispatches WhatsApp via WAHA.
      const result = await runRecoverySweep({ db: dbWrapper.db, waha });
      logEvent('recovery.sweep', { jobId: job.id, ...result });
      return result;
    },
    opts,
  );

  const auditVerify = new Worker(
    QUEUE_NAMES.auditVerify,
    async (job) => {
      logEvent('audit.verify', { jobId: job.id, workspaceId: job.data?.workspaceId ?? null });
      return { ok: true };
    },
    opts,
  );

  // Univercart Connect — partner webhook deliveries. Driven by a
  // repeatable sweeper (registered in index.ts, every 5s). Each tick
  // claims a batch of due deliveries, POSTs them, and updates state.
  const connectDeliveries = new Worker(
    QUEUE_NAMES.connectDeliveries,
    async (job) => {
      const result = await runConnectDeliveriesSweep({ db: dbWrapper.db });
      logEvent('connect.deliveries.sweep', { jobId: job.id, ...result });
      return result;
    },
    opts,
  );

  // Affiliate commissions rollover — hourly sweep that flips pending →
  // available when the refund window passes and refreshes the
  // materialised lifetime totals on the affiliates table. Implemented
  // inline (no separate handler file yet) because the entire logic
  // lives in a single SQL helper.
  const affiliateRollover = new Worker(
    QUEUE_NAMES.affiliateRollover,
    async (job) => {
      // Import lazily to keep boot fast — the affiliate module pulls
      // a fair chunk of drizzle types we don't need until rollover.
      const { rolloverPendingCommissions } = await import('./handlers/affiliate-rollover');
      const result = await rolloverPendingCommissions({ db: dbWrapper.db });
      logEvent('affiliate.rollover.sweep', { jobId: job.id, ...result });
      return result;
    },
    opts,
  );

  // Pilar 2 — server-side tracking dispatcher. 5 s sweep drains the
  // tracking_dispatches queue, calls each provider's HTTP endpoint,
  // and updates row status. Exponential backoff lives in the
  // dispatcher core; the worker is a thin driver.
  const trackingDispatch = new Worker(
    QUEUE_NAMES.trackingDispatch,
    async (job) => {
      const result = await runTrackingDispatchSweep({ db: dbWrapper, crypto });
      logEvent('tracking.dispatch.sweep', { jobId: job.id, ...result });
      return result;
    },
    opts,
  );

  // Pilar 4 — marketplace cached counters rollup. Hourly sweep that
  // refreshes cachedClicks + cachedPurchases so the `popular` sort on
  // /marketplace stays accurate without scanning the orders table on
  // every public hit.
  const marketplaceRollup = new Worker(
    QUEUE_NAMES.marketplaceRollup,
    async (job) => {
      const result = await runMarketplaceRollup({ db: dbWrapper });
      logEvent('marketplace.rollup.sweep', { jobId: job.id, ...result });
      return result;
    },
    opts,
  );

  // Subscription reconcile — every 15min, round-trip the gateway for
  // stale active/pending subscriptions and sync local status. Catches
  // out-of-band cancellations (buyer cancels in MP app, webhook
  // never fires).
  const subscriptionReconcile = new Worker(
    QUEUE_NAMES.subscriptionReconcile,
    async (job) => {
      const result = await runSubscriptionReconcileSweep({
        db: dbWrapper,
        crypto,
      });
      logEvent('subscription.reconcile.sweep', { jobId: job.id, ...result });
      return result;
    },
    opts,
  );

  // WhatsApp session health — 5min sweep. Polls WAHA for every
  // session the local mirror considers WORKING and reflects the real
  // status when WAHA disagrees. Closes the visibility gap where a
  // session crashed at 02:00 but the dashboard still claimed WORKING
  // until the producer manually opened the integrations page.
  const whatsappSessionHealth = new Worker(
    QUEUE_NAMES.whatsappSessionHealth,
    async (job) => {
      const result = await runWhatsappSessionHealthSweep({ db: dbWrapper.db, waha });
      logEvent('whatsapp.session.health.sweep', { jobId: job.id, ...result });
      return result;
    },
    opts,
  );

  // Affiliate program self-heal — hourly. Provisions the workspace-
  // wide default affiliate program for any workspace that has a live
  // marketplace listing but no program yet. Covers legacy listings
  // and the rare migration-race case where the 0017/0019 backfill
  // didn't commit.
  const affiliateProgramBackfill = new Worker(
    QUEUE_NAMES.affiliateProgramBackfill,
    async (job) => {
      const result = await runAffiliateProgramBackfill({ db: dbWrapper.db });
      logEvent('affiliate.program.backfill.sweep', { jobId: job.id, ...result });
      return result;
    },
    opts,
  );

  // Pilar 5 — PIX subscription lifecycle reminders. Hourly:
  //   - T-3 reminders before next renewal
  //   - Daily overdue pings during grace period
  //   - Grace expiry → flip to cancelled + entitlement revoke
  //
  // notify hook intentionally left null for now — wiring it through
  // dispatchEmailNotification / dispatchWhatsappNotification requires
  // resolving the workspace's WAHA session per dispatch, which is the
  // same path order/sub-activation already use. Next iteration ports
  // that helper into the worker package; this commit ships the state
  // machine + observability.
  const pixSubscriptionReminders = new Worker(
    QUEUE_NAMES.pixSubscriptionReminders,
    async (job) => {
      const result = await runPixSubscriptionReminderSweep({
        db: dbWrapper.db,
        notify: subscriptionNotifier,
      });
      logEvent('pix.subscription.reminders.sweep', { jobId: job.id, ...result });
      return result;
    },
    opts,
  );

  // Pilar 5 — PIX subscription CYCLE generator. Tighter cadence (5min)
  // because a sub due in <4h can't wait an hour for the QR. Hits MP
  // createPix only when there's actually a sub to charge, so an empty
  // workspace is a one-query no-op.
  const pixSubscriptionCycle = new Worker(
    QUEUE_NAMES.pixSubscriptionCycle,
    async (job) => {
      const result = await runPixSubscriptionCycleSweep({
        db: dbWrapper.db,
        crypto,
        apiPublicUrl: ctx.env.API_PUBLIC_URL ?? null,
        notify: subscriptionNotifier,
      });
      logEvent('pix.subscription.cycle.sweep', { jobId: job.id, ...result });
      return result;
    },
    opts,
  );

  // Pilar 1 — payout notify sweeper. Hourly tick that surfaces
  // approved-but-untouched payouts so the producer is reminded to
  // send the PIX. Full MP transfer-out automation is gated on KYC
  // compliance work (BACEN); this is the stepping stone.
  const payoutNotify = new Worker(
    QUEUE_NAMES.payoutNotify,
    async (job) => {
      const result = await runPayoutNotifySweep({ db: dbWrapper.db });
      logEvent('payout.notify.sweep', { jobId: job.id, ...result });
      return result;
    },
    opts,
  );

  // Pilar 1 — affiliate fraud auto-suspend. Hourly enforcement of the
  // fraud-signal ledger: critical signals OR ≥3 warns in 7d flip
  // affiliate memberships to suspended in the affected workspace.
  // Producer sees the action in the Afiliados dashboard and can
  // reactivate manually after review.
  const affiliateFraudAutoSuspend = new Worker(
    QUEUE_NAMES.affiliateFraudAutoSuspend,
    async (job) => {
      const result = await runAffiliateFraudAutoSuspendSweep({ db: dbWrapper.db });
      logEvent('affiliate.fraud.auto_suspend.sweep', { jobId: job.id, ...result });
      return result;
    },
    opts,
  );

  for (const w of [
    webhookInbound,
    webhookOutbox,
    recovery,
    auditVerify,
    connectDeliveries,
    affiliateRollover,
    trackingDispatch,
    marketplaceRollup,
    subscriptionReconcile,
    whatsappSessionHealth,
    affiliateProgramBackfill,
    pixSubscriptionReminders,
    pixSubscriptionCycle,
    payoutNotify,
    affiliateFraudAutoSuspend,
  ]) {
    w.on('failed', (job, err) => {
      logEvent('worker.failed', {
        queue: w.name,
        jobId: job?.id,
        error: err.message,
      });
    });
    w.on('error', (err) => logEvent('worker.error', { queue: w.name, error: err.message }));
  }

  return [
    trackingDispatch,
    marketplaceRollup,
    subscriptionReconcile,
    whatsappSessionHealth,
    affiliateProgramBackfill,
    pixSubscriptionReminders,
    pixSubscriptionCycle,
    payoutNotify,
    affiliateFraudAutoSuspend,
    webhookInbound,
    webhookOutbox,
    recovery,
    auditVerify,
    connectDeliveries,
    affiliateRollover,
  ];
}

function logEvent(event: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level: 'info', event, ...data })}\n`);
}
