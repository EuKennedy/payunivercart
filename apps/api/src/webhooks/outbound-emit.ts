import { randomUUID } from 'node:crypto';
import { schema } from '@payunivercart/db';
import {
  WEBHOOK_API_VERSION,
  type WebhookEventEnvelope,
  type WebhookEventType,
} from '@payunivercart/shared';
import { signWebhook } from '@payunivercart/shared/webhooks/signature';
import { and, eq, sql } from 'drizzle-orm';
import type { AppServices } from '../services';

/**
 * Outbound webhook fan-out — transactional outbox writer.
 *
 * Producers register HTTPS endpoints + subscribe to a list of event
 * types via `webhook_endpoints`. Anywhere in the API we want to emit
 * a producer-facing event, we call `emitWebhook` with the resource
 * snapshot; this helper:
 *
 *   1. Looks up every active endpoint that subscribed to this event
 *      type (or wildcard `*`).
 *   2. Builds a Stripe-style envelope per endpoint.
 *   3. Signs the JSON body with the endpoint's per-secret HMAC.
 *   4. Inserts one row into `webhooks_outbox` per match — the worker
 *      picks rows up off `status='pending' AND next_attempt_at<=now()`
 *      and POSTs to the endpoint with exponential backoff.
 *
 * Errors per endpoint are swallowed and logged: one busted endpoint
 * row never blocks fan-out to the other subscribers. The whole helper
 * is best-effort — call sites must NOT depend on it for correctness.
 */
export interface EmitWebhookArgs<TObject = unknown> {
  workspaceId: string;
  eventType: WebhookEventType;
  object: TObject;
  previousAttributes?: Partial<TObject>;
  /** Defaults to `true` (production). Set `false` for sandbox/test events. */
  livemode?: boolean;
}

export interface EmitWebhookCtx {
  services: AppServices;
}

export interface EmitWebhookResult {
  enqueued: number;
}

export async function emitWebhook<TObject = unknown>(
  ctx: EmitWebhookCtx,
  args: EmitWebhookArgs<TObject>,
): Promise<EmitWebhookResult> {
  const { db } = ctx.services.db;
  const livemode = args.livemode ?? true;

  // Match endpoints subscribed to this event type OR the `*` wildcard.
  // `event_types` is a jsonb array; `@>` is Postgres' containment op.
  const endpoints = await db
    .select({
      id: schema.webhookEndpoints.id,
      url: schema.webhookEndpoints.url,
      secret: schema.webhookEndpoints.secret,
    })
    .from(schema.webhookEndpoints)
    .where(
      and(
        eq(schema.webhookEndpoints.workspaceId, args.workspaceId),
        eq(schema.webhookEndpoints.isActive, true),
        sql`(${schema.webhookEndpoints.eventTypes} @> ${JSON.stringify([args.eventType])}::jsonb OR ${schema.webhookEndpoints.eventTypes} @> '["*"]'::jsonb)`,
      ),
    );

  if (endpoints.length === 0) {
    return { enqueued: 0 };
  }

  const createdUnix = Math.floor(Date.now() / 1000);
  const now = new Date();
  let enqueued = 0;

  for (const endpoint of endpoints) {
    try {
      const envelope: WebhookEventEnvelope<TObject> = {
        id: randomUUID(),
        object: 'event',
        api_version: WEBHOOK_API_VERSION,
        created: createdUnix,
        type: args.eventType,
        workspace_id: args.workspaceId,
        livemode,
        data: {
          object: args.object,
          ...(args.previousAttributes ? { previous_attributes: args.previousAttributes } : {}),
        },
      };

      const body = JSON.stringify(envelope);
      const signed = signWebhook(endpoint.secret, body);

      await db.insert(schema.webhooksOutbox).values({
        workspaceId: args.workspaceId,
        endpoint: endpoint.url,
        eventType: args.eventType,
        payload: envelope,
        signature: signed.signatureHeader,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
      });

      enqueued += 1;
    } catch (err) {
      // One broken endpoint must never block fan-out to peers.
      console.error('[outbound-emit] failed to enqueue webhook', {
        workspaceId: args.workspaceId,
        eventType: args.eventType,
        endpointId: endpoint.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { enqueued };
}
