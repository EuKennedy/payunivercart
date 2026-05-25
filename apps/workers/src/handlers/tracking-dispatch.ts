import {
  type TrackingDispatcherCtx,
  runTrackingSweep,
} from '@payunivercart/api/tracking/dispatcher';

/**
 * BullMQ handler for the tracking dispatch sweep. Drains the
 * `tracking_dispatches` queue every 5 s via a repeatable job
 * registered in `index.ts`.
 *
 * Why a sweep instead of a per-event BullMQ job:
 *   - One row per dispatch already exists in the DB the moment an
 *     order/subscription event fires, so the queue would be a 1:1
 *     mirror with no additional ordering guarantees.
 *   - A sweep gives us cheap per-tick rate-limit awareness across
 *     providers (no per-job context) and lets the BullMQ job-set stay
 *     small even when a workspace fires 10k events / minute.
 */
export async function runTrackingDispatchSweep(ctx: TrackingDispatcherCtx) {
  return runTrackingSweep(ctx);
}
