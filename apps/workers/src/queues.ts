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
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface QueueBundle {
  connection: IORedis;
  webhookInbound: Queue;
  webhookOutbox: Queue;
  recovery: Queue;
  auditVerify: Queue;
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
  };
}
