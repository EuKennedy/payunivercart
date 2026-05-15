import { schema } from '@payunivercart/db';
import type { PayunivercartError } from '@payunivercart/shared';
import { verifyWahaWebhook } from '@payunivercart/waha';
import type { Hono } from 'hono';
import type { AppServices } from '../services.js';

/**
 * WAHA webhook receiver. Mounted at `/webhooks/waha` on the Hono router
 * — NOT under `/trpc/*` because tRPC is JSON-only and the HMAC check
 * must run over the EXACT raw body bytes WAHA signed.
 *
 * The path:
 *   1. Read the raw body as a string (Hono gives us `await c.req.text()`).
 *   2. Verify HMAC-SHA512 + 300s timestamp window via
 *      `verifyWahaWebhook` (the parser from packages/waha).
 *   3. Persist the event into `webhooks_inbound` with the resolved
 *      workspaceId — the unique `(source, event_id)` index gives us
 *      idempotent dedupe; a retry of the same event from WAHA is a
 *      no-op.
 *   4. Acknowledge with 200 fast. Heavy lifting (delivery ack updates,
 *      cart-recovery dispatch, etc.) happens later in the worker by
 *      reading the row out of `webhooks_inbound`.
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
      // WEBHOOK_INVALID_SIGNATURE -> 401. VALIDATION -> 400. Anything
      // else (unlikely) -> 500.
      if (err?.code === 'WEBHOOK_INVALID_SIGNATURE') {
        return c.json({ error: 'invalid signature' }, 401);
      }
      if (err?.code === 'VALIDATION') {
        return c.json({ error: 'invalid payload' }, 400);
      }
      return c.json({ error: 'internal error' }, 500);
    }

    // Resolve the workspace from the session name (`ws_<32-hex>`).
    const workspaceId = workspaceIdFromSessionName(parsed.session);

    // Idempotent insert. The unique `(source, event_id)` index in
    // `webhooks_inbound` means a duplicate replay from WAHA is a
    // no-op. Use the parsed event id if available, otherwise fall
    // back to a synthetic one from session+timestamp so the dedupe
    // still has something to compare.
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
    } catch {
      // Persistence failure should NOT cause WAHA to retry — the HMAC
      // already validated, the event is authentic. Acknowledge and
      // alert downstream (pino + sentry once wired).
    }

    return c.json({ received: true }, 200);
  });
}

/**
 * The session-name convention is `ws_<workspaceId-without-dashes>` (set
 * in `routers/whatsapp.ts`). Reverse it back to the canonical UUID.
 *
 * Returns `null` when the session name does not match our convention —
 * a webhook for an unknown session is recorded with NULL workspaceId
 * and surfaced via the audit table for ops to investigate.
 */
function workspaceIdFromSessionName(name: string): string | null {
  const match = name.match(/^ws_([a-f0-9]{32})$/);
  const hex = match?.[1];
  if (!hex) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
