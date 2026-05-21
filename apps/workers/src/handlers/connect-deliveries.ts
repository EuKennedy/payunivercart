import { MAX_DELIVERY_ATTEMPTS, nextAttemptAt, signWebhookPayload } from '@payunivercart/connect';
import { schema } from '@payunivercart/db';
import { and, eq, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

/**
 * Univercart Connect outbound webhook delivery sweeper.
 *
 * Runs on a tight cadence (every 5 s). Each tick:
 *   1. Pull up to `batchSize` pending deliveries whose `nextAttemptAt`
 *      has passed.
 *   2. For each: load the parent event payload + endpoint URL/secret,
 *      sign the body, POST with a 15-second timeout.
 *   3. Update the row:
 *      - 2xx → status=delivered, deliveredAt=now
 *      - 4xx → dead_letter (partner config bug, retrying is pointless)
 *      - 5xx / network → bump attempts, set nextAttemptAt via
 *        Stripe-style schedule; dead_letter if attempts == MAX.
 *
 * The whole sweep is best-effort: any single delivery failure is
 * isolated, never blocks the others, and never throws out of this
 * function so BullMQ stays happy.
 */

interface SweepDeps {
  db: PostgresJsDatabase<typeof schema>;
}

interface SweepResult {
  processed: number;
  delivered: number;
  failed: number;
  deadLettered: number;
}

const BATCH_SIZE = 25;
const REQUEST_TIMEOUT_MS = 15_000;

export async function runConnectDeliveriesSweep(deps: SweepDeps): Promise<SweepResult> {
  const now = new Date();
  // Claim up to BATCH_SIZE pending rows whose nextAttemptAt has come.
  // We don't need a SKIP LOCKED here yet — single worker process —
  // but adding it costs nothing and is required the day we scale out.
  const due = await deps.db
    .select({
      deliveryId: schema.connectWebhookDeliveries.id,
      attempts: schema.connectWebhookDeliveries.attempts,
      eventPayload: schema.connectEvents.payload,
      endpointUrl: schema.partnerWebhookEndpoints.url,
      endpointSecret: schema.partnerWebhookEndpoints.signingSecret,
      endpointActive: schema.partnerWebhookEndpoints.isActive,
    })
    .from(schema.connectWebhookDeliveries)
    .innerJoin(
      schema.connectEvents,
      eq(schema.connectEvents.id, schema.connectWebhookDeliveries.eventId),
    )
    .innerJoin(
      schema.partnerWebhookEndpoints,
      eq(schema.partnerWebhookEndpoints.id, schema.connectWebhookDeliveries.endpointId),
    )
    .where(
      and(
        eq(schema.connectWebhookDeliveries.status, 'pending'),
        lte(schema.connectWebhookDeliveries.nextAttemptAt, now),
      ),
    )
    .limit(BATCH_SIZE);

  const result: SweepResult = { processed: 0, delivered: 0, failed: 0, deadLettered: 0 };

  for (const row of due) {
    result.processed += 1;
    // Endpoint may have been deactivated since the row was enqueued —
    // dead-letter instead of trying.
    if (!row.endpointActive) {
      await markDeadLetter(deps.db, row.deliveryId, 0, 'endpoint_deactivated');
      result.deadLettered += 1;
      continue;
    }

    const rawBody = JSON.stringify(row.eventPayload);
    const signatureHeader = signWebhookPayload({
      secret: row.endpointSecret,
      rawBody,
    });

    let httpStatus: number | null = null;
    let httpBody = '';
    let networkError: string | null = null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(row.endpointUrl, {
        method: 'POST',
        body: rawBody,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Univercart-Connect/v1',
          'X-Univercart-Signature': signatureHeader,
        },
        signal: controller.signal,
      });
      httpStatus = res.status;
      // Truncate body to keep the row size sane (some partners echo back
      // huge debug payloads).
      httpBody = (await res.text()).slice(0, 2048);
    } catch (err) {
      networkError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    const success = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
    const clientError = httpStatus !== null && httpStatus >= 400 && httpStatus < 500;

    if (success) {
      await deps.db
        .update(schema.connectWebhookDeliveries)
        .set({
          status: 'delivered',
          deliveredAt: new Date(),
          lastAttemptAt: new Date(),
          attempts: sql`${schema.connectWebhookDeliveries.attempts} + 1`,
          lastResponseStatus: httpStatus,
          lastResponseBody: httpBody,
          nextAttemptAt: null,
        })
        .where(eq(schema.connectWebhookDeliveries.id, row.deliveryId));
      result.delivered += 1;
      continue;
    }

    const newAttempts = row.attempts + 1;
    if (clientError || newAttempts >= MAX_DELIVERY_ATTEMPTS) {
      await deps.db
        .update(schema.connectWebhookDeliveries)
        .set({
          status: 'dead_letter',
          attempts: newAttempts,
          lastAttemptAt: new Date(),
          lastResponseStatus: httpStatus,
          lastResponseBody: networkError ?? httpBody,
          nextAttemptAt: null,
        })
        .where(eq(schema.connectWebhookDeliveries.id, row.deliveryId));
      result.deadLettered += 1;
      continue;
    }

    const next = nextAttemptAt(newAttempts);
    await deps.db
      .update(schema.connectWebhookDeliveries)
      .set({
        status: 'pending',
        attempts: newAttempts,
        lastAttemptAt: new Date(),
        lastResponseStatus: httpStatus,
        lastResponseBody: networkError ?? httpBody,
        nextAttemptAt: next,
      })
      .where(eq(schema.connectWebhookDeliveries.id, row.deliveryId));
    result.failed += 1;
  }

  return result;
}

async function markDeadLetter(
  db: PostgresJsDatabase<typeof schema>,
  deliveryId: string,
  status: number,
  reason: string,
): Promise<void> {
  await db
    .update(schema.connectWebhookDeliveries)
    .set({
      status: 'dead_letter',
      lastAttemptAt: new Date(),
      lastResponseStatus: status,
      lastResponseBody: reason,
      nextAttemptAt: null,
    })
    .where(eq(schema.connectWebhookDeliveries.id, deliveryId));
}
