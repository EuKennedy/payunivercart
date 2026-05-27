import { Queue, type QueueOptions } from 'bullmq';
import IORedis from 'ioredis';
import type { WorkersEnv } from './env';

/**
 * Process-wide queue + connection registry. Each queue gets its own
 * connection pool (BullMQ best practice — sharing a Redis connection
 * across queues blocks the event loop when one queue is heavy).
 */

export const QUEUE_NAMES = {
  /** Inbound webhook events parsed from `webhooks_inbound`. */
  webhookInbound: 'webhook.inbound',
  /** Outbound webhook delivery (transactional outbox). */
  webhookOutbox: 'webhook.outbox',
  /** Cart-recovery campaigns scheduled in `recovery_attempts`. */
  recovery: 'recovery.dispatch',
  /** Audit chain verifier (runs hourly via a repeatable job). */
  auditVerify: 'audit.verify',
  /** Univercart Connect — partner webhook deliveries sweeper. */
  connectDeliveries: 'connect.deliveries',
  /** Affiliate commissions: flip pending → available when refund
   *  window passes. Hourly repeatable job. */
  affiliateRollover: 'affiliate.rollover',
  /** Pilar 2 — server-side tracking dispatcher. 5 s sweep that drains
   *  the `tracking_dispatches` queue, calls each provider's API, and
   *  flips status accordingly. */
  trackingDispatch: 'tracking.dispatch',
  /** Pilar 4 — marketplace cached counters rollup. Hourly sweep that
   *  refreshes cachedClicks + cachedPurchases on listings. */
  marketplaceRollup: 'marketplace.rollup',
  /** Subscription status reconcile — 15min sweep that round-trips
   *  the gateway for stale subscriptions so out-of-band cancellations
   *  (buyer cancels in MP app, webhook never fires) reflect locally. */
  subscriptionReconcile: 'subscription.reconcile',
  /** WhatsApp session liveness — 5min sweep that polls WAHA for every
   *  session we currently consider WORKING and flips the local mirror
   *  when WAHA disagrees. Keeps the dashboard honest about a session
   *  that died out-of-band. */
  whatsappSessionHealth: 'whatsapp.session.health',
  /** Affiliate program self-heal — hourly sweep that ensures every
   *  workspace with a live marketplace listing has a workspace-wide
   *  default affiliate program. Covers the cases where the runtime
   *  auto-provisioner missed (legacy listings, admin bulk inserts,
   *  migration-time races). */
  affiliateProgramBackfill: 'affiliate.program.backfill',
  /** Pilar 5 — PIX subscription lifecycle sweeper. Hourly tick fires
   *  T-3 reminders, overdue pings during grace, and grace expiry
   *  cancellations. */
  pixSubscriptionReminders: 'pix.subscription.reminders',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface QueueBundle {
  connection: IORedis;
  webhookInbound: Queue;
  webhookOutbox: Queue;
  recovery: Queue;
  auditVerify: Queue;
  connectDeliveries: Queue;
  affiliateRollover: Queue;
  trackingDispatch: Queue;
  marketplaceRollup: Queue;
  subscriptionReconcile: Queue;
  whatsappSessionHealth: Queue;
  affiliateProgramBackfill: Queue;
  pixSubscriptionReminders: Queue;
}

export function createQueues(env: WorkersEnv): QueueBundle {
  // `maxRetriesPerRequest: null` is BullMQ's documented requirement —
  // otherwise the bull script stays connected to a dead redis forever.
  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const opts: QueueOptions = {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      // Keep recent completions for dashboards; aggressive prune past 24 h.
      removeOnComplete: { age: 24 * 3600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  };

  return {
    connection,
    webhookInbound: new Queue(QUEUE_NAMES.webhookInbound, opts),
    webhookOutbox: new Queue(QUEUE_NAMES.webhookOutbox, opts),
    recovery: new Queue(QUEUE_NAMES.recovery, opts),
    auditVerify: new Queue(QUEUE_NAMES.auditVerify, opts),
    connectDeliveries: new Queue(QUEUE_NAMES.connectDeliveries, opts),
    affiliateRollover: new Queue(QUEUE_NAMES.affiliateRollover, opts),
    trackingDispatch: new Queue(QUEUE_NAMES.trackingDispatch, opts),
    marketplaceRollup: new Queue(QUEUE_NAMES.marketplaceRollup, opts),
    subscriptionReconcile: new Queue(QUEUE_NAMES.subscriptionReconcile, opts),
    whatsappSessionHealth: new Queue(QUEUE_NAMES.whatsappSessionHealth, opts),
    affiliateProgramBackfill: new Queue(QUEUE_NAMES.affiliateProgramBackfill, opts),
    pixSubscriptionReminders: new Queue(QUEUE_NAMES.pixSubscriptionReminders, opts),
  };
}
