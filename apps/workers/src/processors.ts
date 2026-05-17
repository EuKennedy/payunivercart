import { createDatabaseClient } from '@payunivercart/db';
import { WahaClient } from '@payunivercart/waha';
import { Worker, type WorkerOptions } from 'bullmq';
import type IORedis from 'ioredis';
import type { WorkersEnv } from './env';
import { runRecoverySweep } from './handlers/recovery';
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

  for (const w of [webhookInbound, webhookOutbox, recovery, auditVerify]) {
    w.on('failed', (job, err) => {
      logEvent('worker.failed', {
        queue: w.name,
        jobId: job?.id,
        error: err.message,
      });
    });
    w.on('error', (err) => logEvent('worker.error', { queue: w.name, error: err.message }));
  }

  return [webhookInbound, webhookOutbox, recovery, auditVerify];
}

function logEvent(event: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level: 'info', event, ...data })}\n`);
}
