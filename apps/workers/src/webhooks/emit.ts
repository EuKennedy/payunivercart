import { randomUUID } from 'node:crypto';
import { schema } from '@payunivercart/db';
import {
  WEBHOOK_API_VERSION,
  type WebhookEventEnvelope,
  type WebhookEventType,
} from '@payunivercart/shared';
import { signWebhook } from '@payunivercart/shared/webhooks/signature';
import { and, eq, sql } from 'drizzle-orm';

/**
 * Worker-side webhook outbox writer.
 *
 * Mirror of `apps/api/src/webhooks/outbound-emit.ts` — we keep a copy
 * here instead of cross-importing because:
 *   1. Workers are a separate deployable; pulling the API package would
 *      drag tRPC + Hono into the worker bundle for no reason.
 *   2. The webhook outbox INSERT is a thin slice of logic — duplicating
 *      it avoids a third "shared infra" package that would only ever
 *      have one consumer pair.
 *
 * Best-effort: errors are swallowed so a producer integration bug
 * never blocks the sweep that fired the event.
 */
export interface WorkerEmitArgs<TObject = unknown> {
  workspaceId: string;
  eventType: WebhookEventType;
  object: TObject;
  livemode?: boolean;
}

export async function emitWebhookFromWorker<TObject>(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle's PgDatabase generic doesn't compose cross-package.
  db: any,
  args: WorkerEmitArgs<TObject>,
): Promise<number> {
  const livemode = args.livemode ?? true;

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

  if (endpoints.length === 0) return 0;

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
        data: { object: args.object },
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
    } catch (cause) {
      process.stdout.write(
        `${JSON.stringify({
          level: 'warn',
          event: 'worker.webhook.enqueue.failed',
          workspaceId: args.workspaceId,
          eventType: args.eventType,
          endpointId: endpoint.id,
          error: cause instanceof Error ? cause.message : String(cause),
        })}\n`,
      );
    }
  }

  return enqueued;
}
