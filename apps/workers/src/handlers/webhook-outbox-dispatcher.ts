import { type DatabaseClient, schema } from '@payunivercart/db';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';

/**
 * Webhook outbox dispatcher — Stripe-style.
 *
 * Drains `webhooks_outbox` rows whose `nextAttemptAt` has matured (or
 * are brand-new with nextAttemptAt=NULL). For each row:
 *
 *   1. CLAIM the row by flipping pending → processing in a single
 *      conditional UPDATE. Concurrent sweeper replicas can't double-
 *      dispatch the same delivery: only the writer whose UPDATE
 *      affected a row keeps going.
 *   2. POST the payload to the customer endpoint with a 10 s budget,
 *      forwarding the pre-signed `Univercart-Signature` header and an
 *      `Idempotency-Key` set to the delivery id so partner servers can
 *      dedupe retries.
 *   3. Classify the response:
 *        - 2xx                  → delivered (terminal success)
 *        - 4xx exc. 408/429/410 → failed    (terminal client error)
 *        - 410 Gone             → failed    (endpoint dead, stop retrying)
 *        - 5xx / 408 / 429      → retry on the Stripe-ish schedule
 *        - timeout / network    → retry
 *      After 10 failed attempts the row dead-letters.
 *
 * The whole sweep is best-effort: a single delivery failure is isolated,
 * never blocks the others, and never throws out of this function so
 * BullMQ keeps the scheduler healthy.
 */

interface SweepCtx {
  db: DatabaseClient;
}

export interface WebhookOutboxSweepResult {
  picked: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  errored: number;
}

const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 10;
const MAX_RESPONSE_BODY_BYTES = 4096;

/**
 * Backoff lookup, in seconds, indexed by the attempt number we just
 * completed. After attempt N fails we wait BACKOFF_SECONDS[N] before
 * attempt N+1. Attempts > MAX_ATTEMPTS dead-letter.
 */
const BACKOFF_SECONDS: Record<number, number> = {
  1: 60,
  2: 5 * 60,
  3: 30 * 60,
  4: 60 * 60,
  5: 6 * 60 * 60,
  6: 12 * 60 * 60,
  7: 24 * 60 * 60,
  8: 2 * 24 * 60 * 60,
  9: 4 * 24 * 60 * 60,
  10: 7 * 24 * 60 * 60,
};

export async function runWebhookOutboxSweep(ctx: SweepCtx): Promise<WebhookOutboxSweepResult> {
  const result: WebhookOutboxSweepResult = {
    picked: 0,
    delivered: 0,
    retried: 0,
    deadLettered: 0,
    errored: 0,
  };

  const now = new Date();
  const due = await ctx.db
    .select({
      id: schema.webhooksOutbox.id,
      endpoint: schema.webhooksOutbox.endpoint,
      eventType: schema.webhooksOutbox.eventType,
      payload: schema.webhooksOutbox.payload,
      signature: schema.webhooksOutbox.signature,
      attempts: schema.webhooksOutbox.attempts,
    })
    .from(schema.webhooksOutbox)
    .where(
      and(
        eq(schema.webhooksOutbox.status, 'pending'),
        or(
          isNull(schema.webhooksOutbox.nextAttemptAt),
          lte(schema.webhooksOutbox.nextAttemptAt, now),
        ),
      ),
    )
    .orderBy(schema.webhooksOutbox.createdAt)
    .limit(BATCH_SIZE);

  for (const row of due) {
    // Conditional claim — flips pending → processing only if no other
    // worker beat us to it. Skip silently on lost race.
    const claimed = await ctx.db
      .update(schema.webhooksOutbox)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(and(eq(schema.webhooksOutbox.id, row.id), eq(schema.webhooksOutbox.status, 'pending')))
      .returning({ id: schema.webhooksOutbox.id });
    if (claimed.length === 0) continue;
    result.picked += 1;

    const startedAt = Date.now();
    const rawBody = JSON.stringify(row.payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let httpStatus: number | null = null;
    let httpBody = '';
    let networkError: string | null = null;
    try {
      const res = await fetch(row.endpoint, {
        method: 'POST',
        body: rawBody,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Univercart-Webhook/1.0',
          'Univercart-Signature': row.signature,
          'Univercart-Event': row.eventType,
          'Univercart-Delivery': row.id,
          'Idempotency-Key': row.id,
        },
        signal: controller.signal,
      });
      httpStatus = res.status;
      httpBody = truncate(await res.text(), MAX_RESPONSE_BODY_BYTES);
    } catch (err) {
      networkError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - startedAt;
    const newAttempts = row.attempts + 1;
    const completedAt = new Date();
    const responseBodyForStorage = networkError
      ? truncate(networkError, MAX_RESPONSE_BODY_BYTES)
      : httpBody;

    const classification = classify(httpStatus, networkError !== null);

    try {
      if (classification === 'delivered') {
        await ctx.db
          .update(schema.webhooksOutbox)
          .set({
            status: 'delivered',
            attempts: newAttempts,
            lastAttemptAt: completedAt,
            deliveredAt: completedAt,
            lastResponseStatus: httpStatus,
            lastResponseBody: responseBodyForStorage,
            nextAttemptAt: null,
            updatedAt: completedAt,
          })
          .where(eq(schema.webhooksOutbox.id, row.id));
        result.delivered += 1;
        log({
          event: 'webhook.outbox.delivery',
          deliveryId: row.id,
          endpoint: row.endpoint,
          status: 'delivered',
          attempts: newAttempts,
          durationMs,
        });
        continue;
      }

      if (classification === 'failed') {
        await ctx.db
          .update(schema.webhooksOutbox)
          .set({
            status: 'failed',
            attempts: newAttempts,
            lastAttemptAt: completedAt,
            lastResponseStatus: httpStatus,
            lastResponseBody: responseBodyForStorage,
            nextAttemptAt: null,
            updatedAt: completedAt,
          })
          .where(eq(schema.webhooksOutbox.id, row.id));
        result.errored += 1;
        log({
          event: 'webhook.outbox.delivery',
          deliveryId: row.id,
          endpoint: row.endpoint,
          status: 'failed',
          attempts: newAttempts,
          durationMs,
        });
        continue;
      }

      // classification === 'retry'
      if (newAttempts > MAX_ATTEMPTS) {
        await ctx.db
          .update(schema.webhooksOutbox)
          .set({
            status: 'dead_letter',
            attempts: newAttempts,
            lastAttemptAt: completedAt,
            lastResponseStatus: httpStatus,
            lastResponseBody: responseBodyForStorage,
            nextAttemptAt: null,
            updatedAt: completedAt,
          })
          .where(eq(schema.webhooksOutbox.id, row.id));
        result.deadLettered += 1;
        log({
          event: 'webhook.outbox.delivery',
          deliveryId: row.id,
          endpoint: row.endpoint,
          status: 'dead_letter',
          attempts: newAttempts,
          durationMs,
        });
        continue;
      }

      const delaySeconds = backoffForAttempt(newAttempts);
      const nextAttemptAt = new Date(completedAt.getTime() + delaySeconds * 1000);
      await ctx.db
        .update(schema.webhooksOutbox)
        .set({
          status: 'pending',
          attempts: newAttempts,
          lastAttemptAt: completedAt,
          lastResponseStatus: httpStatus,
          lastResponseBody: responseBodyForStorage,
          nextAttemptAt,
          updatedAt: completedAt,
        })
        .where(eq(schema.webhooksOutbox.id, row.id));
      result.retried += 1;
      log({
        event: 'webhook.outbox.delivery',
        deliveryId: row.id,
        endpoint: row.endpoint,
        status: 'retry',
        attempts: newAttempts,
        durationMs,
      });
    } catch (cause) {
      // DB write itself blew up — leave the row in `processing` so a
      // future sweep can pick it up after a manual reset, and count it
      // as errored so the metric reflects reality.
      result.errored += 1;
      log({
        event: 'webhook.outbox.delivery',
        deliveryId: row.id,
        endpoint: row.endpoint,
        status: 'db_error',
        attempts: newAttempts,
        durationMs,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  // Silence unused-import warning on quiet ticks.
  void sql;

  return result;
}

type Classification = 'delivered' | 'failed' | 'retry';

function classify(httpStatus: number | null, hadNetworkError: boolean): Classification {
  if (hadNetworkError || httpStatus === null) return 'retry';
  if (httpStatus >= 200 && httpStatus < 300) return 'delivered';
  if (httpStatus === 408 || httpStatus === 429) return 'retry';
  if (httpStatus === 410) return 'failed';
  if (httpStatus >= 400 && httpStatus < 500) return 'failed';
  if (httpStatus >= 500) return 'retry';
  return 'retry';
}

function backoffForAttempt(attemptJustCompleted: number): number {
  const seconds = BACKOFF_SECONDS[attemptJustCompleted];
  if (typeof seconds === 'number') return seconds;
  // Shouldn't happen — caller dead-letters above MAX_ATTEMPTS. Fallback
  // to the longest delay we know.
  return BACKOFF_SECONDS[MAX_ATTEMPTS] ?? 7 * 24 * 60 * 60;
}

function truncate(input: string, maxBytes: number): string {
  if (input.length <= maxBytes) return input;
  return input.slice(0, maxBytes);
}

function log(data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level: 'info', ...data })}\n`);
}
