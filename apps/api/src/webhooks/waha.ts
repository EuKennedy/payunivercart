import { schema } from '@payunivercart/db';
import type { PayunivercartError } from '@payunivercart/shared';
import { type WahaSessionStatus, verifyWahaWebhook } from '@payunivercart/waha';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { AppServices } from '../services';

/**
 * WAHA webhook receiver. Mounted at `/webhooks/waha` on the Hono router
 * — NOT under `/trpc/*` because tRPC is JSON-only and the HMAC check
 * must run over the EXACT raw body bytes WAHA signed.
 *
 * The path:
 *   1. Read the raw body as a string (Hono gives us `await c.req.text()`).
 *   2. Verify HMAC-SHA512 + 300s timestamp window via
 *      `verifyWahaWebhook` (the parser from packages/waha).
 *   3. Resolve the producer's workspace from the session name — uses
 *      the live `whatsapp_sessions.waha_session_id` row instead of the
 *      old `ws_<hex>` decode (Block 24 let producers name their own
 *      sessions; the auto-derived pattern stopped working then).
 *   4. Persist the event into `webhooks_inbound` with the resolved
 *      workspaceId — the unique `(source, event_id)` index gives us
 *      idempotent dedupe; a retry of the same event from WAHA is a
 *      no-op.
 *   5. React to high-signal events INLINE:
 *        - `session.status`  → flip `whatsapp_sessions.status` +
 *          `connected_at`/`disconnected_at` so the dashboard sees the
 *          new state without waiting on the 3 s poll.
 *        - `state.change`    → same mapping, different envelope WAHA
 *          emits as the WEBJS engine boots / disconnects.
 *      Inbound `message` and `message.ack` events stay in
 *      `webhooks_inbound` for the worker to consume — they have no
 *      hot-path UX impact and benefit from batching.
 *   6. Acknowledge with 200 fast. Failures of either persistence or
 *      reactor are logged but never surfaced to WAHA as a 5xx — the
 *      HMAC already proved authenticity, retrying would only flood us.
 *
 * Errors are mapped to the appropriate HTTP status without leaking
 * detail: signature failures return 401, schema failures return 400,
 * everything else 500 (and is logged with a request id once we wire
 * pino).
 */

const WAHA_SOURCE = 'waha';

export function mountWahaWebhook(app: Hono, services: AppServices): void {
  app.post('/webhooks/waha', async (c) => {
    const raw = await c.req.text();
    const signature = c.req.header('x-webhook-hmac') ?? c.req.header('X-Webhook-Hmac') ?? '';

    let parsed: ReturnType<typeof verifyWahaWebhook>;
    try {
      parsed = verifyWahaWebhook({
        rawBody: raw,
        signature,
        secret: services.env.WAHA_WEBHOOK_SECRET,
      });
    } catch (cause) {
      const err = cause as PayunivercartError;
      if (err?.code === 'WEBHOOK_INVALID_SIGNATURE') {
        return c.json({ error: 'invalid signature' }, 401);
      }
      if (err?.code === 'VALIDATION') {
        return c.json({ error: 'invalid payload' }, 400);
      }
      return c.json({ error: 'internal error' }, 500);
    }

    // Resolve the workspace from the session row. NULL workspaceId
    // means an event arrived for a session we don't track — we still
    // persist the row (audit) but skip the reactor branch.
    const workspaceId = await resolveWorkspaceId(services, parsed.session);
    const eventId = parsed.id ?? `${parsed.session}:${parsed.timestamp}`;

    try {
      await services.db.db
        .insert(schema.webhooksInbound)
        .values({
          workspaceId,
          source: WAHA_SOURCE,
          eventId,
          eventType: parsed.event,
          rawHeaders: Object.fromEntries(c.req.raw.headers.entries()),
          rawBody: raw,
          signatureValid: 'valid',
        })
        .onConflictDoNothing({
          target: [schema.webhooksInbound.source, schema.webhooksInbound.eventId],
        });
    } catch (cause) {
      process.stdout.write(
        `${JSON.stringify({
          level: 'warn',
          event: 'waha.webhook.persistFailed',
          eventId,
          error: cause instanceof Error ? cause.message : String(cause),
        })}\n`,
      );
    }

    // Reactor: only run on events whose freshness matters for the
    // dashboard UX. Wrap in try/catch so a reactor failure never
    // poisons the 200 ack.
    if (workspaceId) {
      try {
        await runReactor(services, workspaceId, parsed);
      } catch (cause) {
        process.stdout.write(
          `${JSON.stringify({
            level: 'warn',
            event: 'waha.webhook.reactorFailed',
            eventId,
            error: cause instanceof Error ? cause.message : String(cause),
          })}\n`,
        );
      }
    }

    return c.json({ received: true }, 200);
  });
}

/**
 * Lookup the workspace owning the given session. Returns NULL when the
 * session isn't tracked locally (e.g., an old WAHA session leftover
 * from a prior tenant). Cheap query — Postgres lookup on the unique
 * index `whatsapp_sessions_waha_id_unique`.
 */
async function resolveWorkspaceId(
  services: AppServices,
  sessionName: string,
): Promise<string | null> {
  const [row] = await services.db.db
    .select({ workspaceId: schema.whatsappSessions.workspaceId })
    .from(schema.whatsappSessions)
    .where(eq(schema.whatsappSessions.wahaSessionId, sessionName))
    .limit(1);
  return row?.workspaceId ?? null;
}

/**
 * High-signal reactor for events the dashboard cares about NOW
 * (status flips). Everything else stays in `webhooks_inbound` for the
 * worker to consume in batches.
 */
async function runReactor(
  services: AppServices,
  workspaceId: string,
  parsed: ReturnType<typeof verifyWahaWebhook>,
): Promise<void> {
  if (parsed.event === 'session.status') {
    const status = (parsed.payload as { status?: WahaSessionStatus })?.status;
    if (!status) return;
    await updateSessionStatus(services, workspaceId, status);
    return;
  }
  if (parsed.event === 'state.change') {
    // WEBJS `state.change` carries WhatsApp Web's lower-level state
    // (CONNECTED / DISCONNECTED / OPENING etc). Map the subset that
    // maps cleanly to our session enum — the rest stays only in the
    // audit row.
    const state = String((parsed.payload as { state?: string })?.state ?? '').toUpperCase();
    const mapped = mapWebjsStateToSessionStatus(state);
    if (mapped) await updateSessionStatus(services, workspaceId, mapped);
  }
}

async function updateSessionStatus(
  services: AppServices,
  workspaceId: string,
  status: WahaSessionStatus,
): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (status === 'WORKING') {
    patch.connectedAt = new Date();
    patch.disconnectedAt = null;
  } else if (status === 'STOPPED' || status === 'FAILED') {
    patch.disconnectedAt = new Date();
  }
  await services.db.db
    .update(schema.whatsappSessions)
    .set(patch)
    .where(eq(schema.whatsappSessions.workspaceId, workspaceId));
}

function mapWebjsStateToSessionStatus(state: string): WahaSessionStatus | null {
  switch (state) {
    case 'CONNECTED':
      return 'WORKING';
    case 'DISCONNECTED':
    case 'UNPAIRED':
    case 'CONFLICT':
      return 'FAILED';
    case 'OPENING':
      return 'STARTING';
    default:
      return null;
  }
}
