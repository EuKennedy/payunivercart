import { CryptoService, loadKeyRegistryFromEnv } from '@payunivercart/crypto';
import { createDatabaseClient } from '@payunivercart/db';
import { WahaClient } from '@payunivercart/waha';
import { Worker, type WorkerOptions } from 'bullmq';
import type IORedis from 'ioredis';
import type { WorkersEnv } from './env';
import { runAffiliateProgramBackfill } from './handlers/affiliate-program-backfill';
import { runConnectDeliveriesSweep } from './handlers/connect-deliveries';
import { runMarketplaceRollup } from './handlers/marketplace-rollup';
import { runRecoverySweep } from './handlers/recovery';
import { runSubscriptionReconcileSweep } from './handlers/subscription-reconcile';
import { runTrackingDispatchSweep } from './handlers/tracking-dispatch';
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
      logEvent('webhook.outbox.dispatch', { jobId: job.id });
      return { delivered: false, reason: 'handler-pending' };
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
