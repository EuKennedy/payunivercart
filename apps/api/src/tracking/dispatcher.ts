import { schema } from '@payunivercart/db';
import { and, eq, isNotNull, lte, or } from 'drizzle-orm';
import { getAdapter, isProviderSupported } from './providers';
import type { TrackingEvent, TrackingEventType, TrackingProvider } from './types';

/**
 * Minimal context the dispatcher needs. Smaller than the full
 * `AppServices` so the workers package can construct it without
 * pulling the entire API service tree.
 */
export interface TrackingDispatcherCtx {
  // biome-ignore lint/suspicious/noExplicitAny: drizzle PgDatabase generic doesn't compose across packages cleanly; runtime call is stable.
  db: { db: any };
  crypto: { unsealJson: <T>(blob: Uint8Array) => T };
}

/**
 * Server-side tracking dispatcher. Two entry points:
 *
 *   1. `dispatchEventToAllPixels(...)` — fired inline from the API
 *      (webhook handler / checkout success) for a conversion source
 *      (order, subscription). Creates ONE `tracking_dispatches` row
 *      per active pixel that has the event type enabled. Inserts use
 *      `ON CONFLICT DO NOTHING` so retries / replays are idempotent.
 *
 *   2. `runTrackingSweep(...)` — worker tick (5 s cadence) that drains
 *      the dispatch queue. Picks up `pending` + `failed (attempt < 6)`
 *      rows whose `nextAttemptAt` has passed, calls the adapter, and
 *      updates status. Exponential backoff between attempts.
 *
 * Why this split:
 *   - Inline create gives us an immediate per-pixel row the producer
 *     can audit in the UI, even if the adapter call hasn't fired yet.
 *   - Async send keeps the webhook fast (200 in <50ms) and lets us
 *     retry without coupling to gateway webhook delivery.
 */

const MAX_ATTEMPTS = 6;
const BATCH_SIZE = 50;

export interface DispatchSource {
  workspaceId: string;
  eventType: TrackingEventType;
  /** What this dispatch is about — `order`, `subscription`, etc. */
  sourceType: string;
  /** Foreign id of the source row. */
  sourceId: string;
  /** Provider-agnostic event payload (currency, value, contents, user). */
  event: Omit<TrackingEvent, 'eventId' | 'eventTimeSeconds' | 'eventType'>;
}

/**
 * Enqueue ONE dispatch row per active pixel of the workspace whose
 * `eventsEnabled[eventType]` is not explicitly false. Caller does not
 * await provider HTTP calls — the worker sweep picks them up.
 */
export async function dispatchEventToAllPixels(
  services: TrackingDispatcherCtx,
  input: DispatchSource,
): Promise<{ enqueued: number }> {
  const pixels = await services.db.db
    .select({
      id: schema.trackingPixels.id,
      provider: schema.trackingPixels.provider,
      eventsEnabled: schema.trackingPixels.eventsEnabled,
    })
    .from(schema.trackingPixels)
    .where(
      and(
        eq(schema.trackingPixels.workspaceId, input.workspaceId),
        eq(schema.trackingPixels.enabled, true),
      ),
    );

  let enqueued = 0;
  const now = new Date();
  for (const pixel of pixels) {
    const enabled = pixel.eventsEnabled?.[input.eventType] ?? true;
    if (!enabled) continue;
    // Stable eventId per (pixel, source, eventType) so the browser
    // pixel can dedupe against the server fire when the producer also
    // wires up a client tag.
    const eventId = `${pixel.id}:${input.sourceType}:${input.sourceId}:${input.eventType}`;
    const fullEvent: TrackingEvent = {
      ...input.event,
      eventId,
      eventType: input.eventType,
      eventTimeSeconds: Math.floor(Date.now() / 1000),
    };

    const inserted = await services.db.db
      .insert(schema.trackingDispatches)
      .values({
        workspaceId: input.workspaceId,
        pixelId: pixel.id,
        eventType: input.eventType,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        payload: fullEvent as object,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: now,
      })
      .onConflictDoNothing({
        target: [
          schema.trackingDispatches.workspaceId,
          schema.trackingDispatches.pixelId,
          schema.trackingDispatches.sourceType,
          schema.trackingDispatches.sourceId,
          schema.trackingDispatches.eventType,
        ],
      })
      .returning({ id: schema.trackingDispatches.id });
    if (inserted.length > 0) enqueued += 1;
  }
  return { enqueued };
}

/**
 * Worker tick — drain due dispatches. Idempotent + bounded by
 * BATCH_SIZE so a backlog can't starve the event loop.
 */
export async function runTrackingSweep(
  services: TrackingDispatcherCtx,
): Promise<{ processed: number; sent: number; failed: number; dropped: number }> {
  const now = new Date();
  const due = await services.db.db
    .select({
      id: schema.trackingDispatches.id,
      workspaceId: schema.trackingDispatches.workspaceId,
      pixelId: schema.trackingDispatches.pixelId,
      eventType: schema.trackingDispatches.eventType,
      payload: schema.trackingDispatches.payload,
      attemptCount: schema.trackingDispatches.attemptCount,
    })
    .from(schema.trackingDispatches)
    .where(
      and(
        or(
          eq(schema.trackingDispatches.status, 'pending'),
          eq(schema.trackingDispatches.status, 'failed'),
        ),
        isNotNull(schema.trackingDispatches.nextAttemptAt),
        lte(schema.trackingDispatches.nextAttemptAt, now),
      ),
    )
    .limit(BATCH_SIZE);

  let sent = 0;
  let failed = 0;
  let dropped = 0;

  for (const row of due) {
    const [pixel] = await services.db.db
      .select({
        provider: schema.trackingPixels.provider,
        publicPixelId: schema.trackingPixels.publicPixelId,
        testMode: schema.trackingPixels.testMode,
        enabled: schema.trackingPixels.enabled,
        credentialsEncrypted: schema.trackingPixels.credentialsEncrypted,
      })
      .from(schema.trackingPixels)
      .where(eq(schema.trackingPixels.id, row.pixelId))
      .limit(1);

    if (!pixel || !pixel.enabled || !isProviderSupported(pixel.provider as TrackingProvider)) {
      // Producer disabled / removed the pixel between enqueue and send.
      // Drop the dispatch — there's no recovery path.
      await services.db.db
        .update(schema.trackingDispatches)
        .set({ status: 'dropped', updatedAt: new Date() })
        .where(eq(schema.trackingDispatches.id, row.id));
      dropped += 1;
      continue;
    }

    const adapter = getAdapter(pixel.provider as TrackingProvider);
    const credentials = adapter.parseCredentials(
      services.crypto.unsealJson<Record<string, unknown>>(pixel.credentialsEncrypted),
    );
    const result = await adapter.send(
      credentials,
      { publicPixelId: pixel.publicPixelId, testMode: pixel.testMode },
      row.payload as TrackingEvent,
    );

    const nextAttempt = result.ok ? null : computeNextAttempt(row.attemptCount + 1);
    const isDropped = !result.ok && row.attemptCount + 1 >= MAX_ATTEMPTS;
    const finalStatus = result.ok ? 'sent' : isDropped ? 'dropped' : 'failed';

    await services.db.db
      .update(schema.trackingDispatches)
      .set({
        status: finalStatus,
        attemptCount: row.attemptCount + 1,
        httpStatus: result.httpStatus,
        response: truncatePayload(result.response) as object | null,
        providerEventId: result.providerEventId,
        lastError: result.errorMessage,
        nextAttemptAt: nextAttempt,
        sentAt: result.ok ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(schema.trackingDispatches.id, row.id));

    if (result.ok) sent += 1;
    else if (isDropped) dropped += 1;
    else failed += 1;
  }

  return { processed: due.length, sent, failed, dropped };
}

/**
 * Exponential backoff with jitter, capped at 1h. Attempt 1 → ~30s,
 * attempt 6 → ~1h. We jitter ±20% to avoid thundering-herd retries
 * after a provider outage recovers.
 */
function computeNextAttempt(attempt: number): Date {
  const base = Math.min(30 * 2 ** (attempt - 1), 3600); // seconds
  const jitter = base * (0.8 + Math.random() * 0.4);
  return new Date(Date.now() + jitter * 1000);
}

function truncatePayload(value: unknown): unknown {
  if (value == null) return null;
  try {
    const s = JSON.stringify(value);
    if (s.length <= 8192) return value;
    return { truncated: true, head: s.slice(0, 8000) };
  } catch {
    return null;
  }
}
