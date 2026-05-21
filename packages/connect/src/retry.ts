/**
 * Stripe-style exponential backoff schedule for webhook delivery
 * retries. Returns the delay in milliseconds for a given attempt
 * number (1-indexed). After attempt 9 the delivery is marked
 * `dead_letter` and no further retries are scheduled.
 *
 * Schedule (Stripe parity, approximately):
 *   attempt 2 →    1 min
 *   attempt 3 →    5 min
 *   attempt 4 →   30 min
 *   attempt 5 →    2 h
 *   attempt 6 →   12 h
 *   attempt 7 →   24 h
 *   attempt 8 →   36 h
 *   attempt 9 →   72 h  (last)
 *
 * Total wall-clock window: ~76 hours.
 */

export const MAX_DELIVERY_ATTEMPTS = 9;

const SCHEDULE_MS: Readonly<number[]> = Object.freeze([
  0, // attempt 1 — immediate (no delay)
  1 * 60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  12 * 3_600_000,
  24 * 3_600_000,
  36 * 3_600_000,
  72 * 3_600_000,
]);

/**
 * Next attempt timestamp helper.
 *
 * @param attemptsCompleted - how many attempts have already been tried (0 = none yet)
 * @param nowMs             - clock reference, defaults to Date.now()
 * @returns                 - Date for the NEXT attempt, or `null` if dead-lettered
 */
export function nextAttemptAt(attemptsCompleted: number, nowMs: number = Date.now()): Date | null {
  if (attemptsCompleted >= MAX_DELIVERY_ATTEMPTS) return null;
  const delay = SCHEDULE_MS[attemptsCompleted] ?? 0;
  return new Date(nowMs + delay);
}
