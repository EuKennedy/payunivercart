import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { publicProcedure, router } from '../trpc.js';

/**
 * Health endpoints. Two distinct probes:
 *
 *   - `health.live` answers "is this process alive?" — no dependencies.
 *     Used by the orchestrator (Coolify / k8s) to decide whether to
 *     restart the container. Must NEVER touch downstream services
 *     because a flaky downstream would loop-kill the process.
 *
 *   - `health.ready` answers "can this process serve traffic?" — runs
 *     a `SELECT 1` against Postgres and a `PING` against WAHA. Used by
 *     the load balancer to decide whether to send a request to this
 *     instance.
 */
export const healthRouter = router({
  live: publicProcedure
    .output(z.object({ status: z.literal('ok'), uptimeSeconds: z.number() }))
    .query(() => ({ status: 'ok' as const, uptimeSeconds: process.uptime() })),

  ready: publicProcedure
    .output(
      z.object({
        status: z.enum(['ok', 'degraded']),
        checks: z.object({
          database: z.enum(['ok', 'fail']),
          waha: z.enum(['ok', 'fail', 'skipped']),
        }),
      }),
    )
    .query(async ({ ctx }) => {
      const { db, waha, env } = ctx.services;

      let database: 'ok' | 'fail' = 'ok';
      try {
        await db.db.execute(sql`SELECT 1`);
      } catch {
        database = 'fail';
      }

      // WAHA readiness check is skipped in `test` to keep unit tests
      // hermetic. In dev/prod we make a cheap session-status call.
      let wahaCheck: 'ok' | 'fail' | 'skipped' = 'skipped';
      if (env.NODE_ENV !== 'test') {
        try {
          await waha.getSessionStatus();
          wahaCheck = 'ok';
        } catch {
          wahaCheck = 'fail';
        }
      }

      const status = database === 'ok' && wahaCheck !== 'fail' ? 'ok' : 'degraded';
      return { status, checks: { database, waha: wahaCheck } };
    }),
});
