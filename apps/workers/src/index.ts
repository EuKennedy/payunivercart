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
