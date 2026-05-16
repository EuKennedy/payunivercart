import { Worker, type WorkerOptions } from 'bullmq';
import type IORedis from 'ioredis';
import { QUEUE_NAMES } from './queues';

/**
 * Job processors. Each worker is a separate BullMQ instance bound to one
 * queue. Heavy lifting (DB writes, audit chain appends, gateway calls)
 * lives in handlers under `./handlers/*` when each one lands; for the
 * scaffolding pass we register the workers and log structured events so
 * the boot already shows up correctly in `docker compose logs`.
 */

interface WorkerCtx {
  connection: IORedis;
  concurrency: number;
}

export function startWorkers(ctx: WorkerCtx): Worker[] {
  const opts: WorkerOptions = { connection: ctx.connection, concurrency: ctx.concurrency };

  const webhookInbound = new Worker(
    QUEUE_NAMES.webhookInbound,
    async (job) => {
      logEvent('webhook.inbound.received', { jobId: job.id, payloadKeys: Object.keys(job.data) });
      // Production handler lands with the next block. For now we just
      // mark the job as processed so apps/api can already enqueue
      // events from the webhook receiver without the queue piling up.
      return { ack: true };
    },
    opts,
  );

  const webhookOutbox = new Worker(
    QUEUE_NAMES.webhookOutbox,
    async (job) => {
      logEvent('webhook.outbox.dispatch', { jobId: job.id });
      // Reads from `webhooks_outbox` and POSTs to the producer's
      // configured URL with HMAC signature. Real delivery loop lands
      // with Bloco 17 alongside the producer-facing endpoints
      // listing.
      return { delivered: false, reason: 'handler-pending' };
    },
    opts,
  );

  const recovery = new Worker(
    QUEUE_NAMES.recovery,
    async (job) => {
      logEvent('recovery.dispatch', { jobId: job.id });
      // Reads `recovery_attempts` due rows and fires WhatsApp / email.
      return { sent: false, reason: 'handler-pending' };
    },
    opts,
  );

  const auditVerify = new Worker(
    QUEUE_NAMES.auditVerify,
    async (job) => {
      logEvent('audit.verify', { jobId: job.id, workspaceId: job.data?.workspaceId ?? null });
      // Calls `AuditService.verify(...)` per workspace; alerts on
      // chain breaks. Real verifier lands with the audit Drizzle
      // port + cron registration in Bloco 17.
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
