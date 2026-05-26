import * as Sentry from '@sentry/node';
import 'dotenv/config';
import { loadEnv } from './env';
import { startWorkers } from './processors';
import { createQueues } from './queues';

/**
 * BullMQ worker process entry point. Boot order:
 *   1. Validate env.
 *   2. Spin up Redis + queue handles.
 *   3. Register one Worker per queue with the documented concurrency.
 *   4. Listen for SIGTERM/SIGINT and drain in-flight jobs before exit.
 */

async function main() {
  const env = loadEnv();

  // Init Sentry before any handler runs so a job that crashes during
  // its first tick still reports. No-op when DSN missing.
  if (env.SENTRY_DSN) {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      release: env.SENTRY_RELEASE,
      environment: env.NODE_ENV,
      serverName: 'payunivercart-workers',
      tracesSampleRate: 0,
    });
  }

  const queues = createQueues(env);

  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      event: 'workers.boot',
      concurrency: env.WORKERS_CONCURRENCY,
      nodeEnv: env.NODE_ENV,
    })}\n`,
  );

  const workers = startWorkers({
    env,
    connection: queues.connection,
    concurrency: env.WORKERS_CONCURRENCY,
  });

  // Repeatable hourly job for the audit verifier — registered at boot
  // so we don't need an external scheduler.
  await queues.auditVerify.upsertJobScheduler(
    'hourly',
    { every: 60 * 60 * 1000 },
    {
      name: 'audit.verify.all-workspaces',
      data: {},
    },
  );

  // Repeatable cart-recovery sweep — every 60s, scan recovery_attempts
  // for rows whose scheduled_for has passed and dispatch via WAHA.
  // The handler is a no-op when there are no due rows.
  await queues.recovery.upsertJobScheduler(
    'sweeper',
    { every: 60 * 1000 },
    {
      name: 'recovery.sweep',
      data: {},
    },
  );

  // Univercart Connect — partner webhook delivery sweeper. Tighter
  // cadence (5s) than recovery because newly-paid subscriptions expect
  // their webhook within seconds, not minutes. The sweep is idempotent
  // (state machine on each delivery row) and bounded (BATCH_SIZE).
  await queues.connectDeliveries.upsertJobScheduler(
    'sweeper',
    { every: 5 * 1000 },
    {
      name: 'connect.deliveries.sweep',
      data: {},
    },
  );

  // Affiliate commissions rollover — hourly sweep that flips pending
  // → available when the refund window passes. Idempotent + cheap on
  // empty result sets so a 60-min cadence is comfortable.
  await queues.affiliateRollover.upsertJobScheduler(
    'hourly',
    { every: 60 * 60 * 1000 },
    {
      name: 'affiliate.rollover.sweep',
      data: {},
    },
  );

  // Pilar 2 — tracking dispatch sweep every 5 s. Ads optimization
  // hates lag; firing Purchase events within seconds of the conversion
  // gives Meta / GA4 / TikTok the highest-quality signal.
  await queues.trackingDispatch.upsertJobScheduler(
    'sweeper',
    { every: 5 * 1000 },
    {
      name: 'tracking.dispatch.sweep',
      data: {},
    },
  );

  // Pilar 4 — marketplace cached counters rollup. Hourly is enough;
  // the `popular` sort uses cachedPurchases + cachedClicks so a fresh
  // listing climbs the ranks within an hour of its first conversion.
  await queues.marketplaceRollup.upsertJobScheduler(
    'hourly',
    { every: 60 * 60 * 1000 },
    {
      name: 'marketplace.rollup.sweep',
      data: {},
    },
  );

  // Subscription status reconciliation — every 15 min, picks stale
  // active/pending subs and round-trips the gateway so out-of-band
  // cancellations (buyer cancels in MP app) reflect locally even
  // when the webhook never arrives.
  await queues.subscriptionReconcile.upsertJobScheduler(
    'reconcile',
    { every: 15 * 60 * 1000 },
    {
      name: 'subscription.reconcile.sweep',
      data: {},
    },
  );

  // WhatsApp session liveness — every 5 min. Reflects real WAHA status
  // in the local mirror so the dashboard chip + bell stop lying when a
  // session crashes out-of-band. Tight cadence because a stale chip
  // means recovery sweeps keep firing into a dead session for hours.
  await queues.whatsappSessionHealth.upsertJobScheduler(
    'health',
    { every: 5 * 60 * 1000 },
    {
      name: 'whatsapp.session.health.sweep',
      data: {},
    },
  );

  // Affiliate program self-heal — every hour. Cheap query on the small
  // marketplace_listings table; safe to run frequently.
  await queues.affiliateProgramBackfill.upsertJobScheduler(
    'backfill',
    { every: 60 * 60 * 1000 },
    {
      name: 'affiliate.program.backfill.sweep',
      data: {},
    },
  );

  // Kick the backfill once at boot so a fresh deploy doesn't have to
  // wait an hour for the first cron tick to provision programs for
  // any listings that landed before the auto-provisioner shipped.
  // Deduped on `jobId` so multiple worker replicas don't double-run.
  await queues.affiliateProgramBackfill.add(
    'affiliate.program.backfill.sweep',
    {},
    { jobId: `boot:${Date.now()}` },
  );

  const shutdown = async (signal: string) => {
    process.stdout.write(
      `${JSON.stringify({ level: 'info', event: 'workers.shutdown', signal })}\n`,
    );
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all([
      queues.webhookInbound.close(),
      queues.webhookOutbox.close(),
      queues.recovery.close(),
      queues.auditVerify.close(),
      queues.connectDeliveries.close(),
    ]);
    queues.connection.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      event: 'workers.boot.failed',
      error: err instanceof Error ? err.message : String(err),
    })}\n`,
  );
  process.exit(1);
});
