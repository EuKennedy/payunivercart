import { schema } from '@payunivercart/db';
import { getAdapter } from '@payunivercart/payments';
import { type GatewayId, PayunivercartError } from '@payunivercart/shared';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { AppServices } from '../services';

/**
 * Inbound gateway webhooks. Mounted at `/webhooks/gateway/:gatewayId`
 * — NOT under `/trpc/*` because tRPC parses JSON and the gateway's HMAC
 * signature is computed over the EXACT raw body bytes.
 *
 * Block 22 supports Mercado Pago only; the dispatch table makes adding
 * Pagar.me / PagSeguro a 4-line change once their adapters' webhook
 * verification is exercised.
 *
 * Flow per request:
 *   1. Read raw body as string (preserves bytes for HMAC).
 *   2. Look up the resourceId the gateway claims this event refers to.
 *   3. Find the transaction by `gateway_charge_id` — that gives us the
 *      workspaceId without trusting metadata.
 *   4. Decrypt the workspace's gateway credentials.
 *   5. Call adapter.verifyWebhook → throws on signature mismatch.
 *   6. Idempotent INSERT into `webhooks_inbound` keyed on (source,
 *      event_id). A duplicate retry from the gateway is a no-op.
 *   7. Call adapter.getCharge to fetch the canonical status straight
 *      from the gateway (no trust in the webhook's payload alone).
 *   8. Update transactions + orders accordingly.
 *   9. Return 200 fast. Heavy follow-on work (cart recovery, email,
 *      WhatsApp notify) happens out-of-band on the worker side.
 */

export function mountGatewayWebhooks(app: Hono, services: AppServices): void {
  app.post('/webhooks/gateway/:gatewayId', async (c) => {
    const gatewayId = c.req.param('gatewayId') as GatewayId;
    if (!isSupportedGatewayId(gatewayId)) {
      return c.json({ error: 'unsupported_gateway' }, 404);
    }

    const raw = await c.req.text();
    const headers = Object.fromEntries(c.req.raw.headers.entries());
    const queryParams = Object.fromEntries(new URL(c.req.url).searchParams);

    // 1. Extract the resourceId the gateway is reporting on. We need it
    //    BEFORE signature verification because we need the credentials,
    //    which we find via the transaction the resourceId points at.
    //    Each gateway has its own variant; for MP the id arrives either
    //    in `?data.id` or in the JSON body's `data.id` field.
    const resourceId = extractMpResourceId(queryParams, raw);
    if (!resourceId) {
      return c.json({ error: 'missing_resource_id' }, 400);
    }

    // 2. Find the transaction → workspaceId.
    const [tx] = await services.db.db
      .select({
        id: schema.transactions.id,
        workspaceId: schema.transactions.workspaceId,
        orderId: schema.transactions.orderId,
        method: schema.transactions.method,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.gatewayId, gatewayId),
          eq(schema.transactions.gatewayChargeId, resourceId),
        ),
      )
      .limit(1);

    if (!tx) {
      // The webhook may have raced ahead of the createPix-response
      // write. Persist for the worker to retry; ack 200 so the gateway
      // doesn't keep retrying at the protocol layer.
      await storeRaw({
        services,
        source: gatewayId,
        eventId: `pending:${gatewayId}:${resourceId}:${Date.now()}`,
        eventType: 'unresolved',
        headers,
        raw,
        signatureValid: 'unknown',
        workspaceId: null,
        error: 'transaction not yet recorded for resourceId',
      });
      return c.json({ ok: true, deferred: true });
    }

    // 3. Decrypt credentials for the owning workspace.
    const [credRow] = await services.db.db
      .select({
        credentialsEncrypted: schema.gatewayCredentials.credentialsEncrypted,
      })
      .from(schema.gatewayCredentials)
      .where(
        and(
          eq(schema.gatewayCredentials.workspaceId, tx.workspaceId),
          eq(schema.gatewayCredentials.gatewayId, gatewayId),
          eq(schema.gatewayCredentials.isDefault, true),
        ),
      )
      .limit(1);

    if (!credRow) {
      // The producer deleted the gateway between createPix and webhook
      // arrival. Persist for audit + ack so gateway stops retrying.
      await storeRaw({
        services,
        source: gatewayId,
        eventId: `orphan-cred:${gatewayId}:${resourceId}:${Date.now()}`,
        eventType: 'unresolved',
        headers,
        raw,
        signatureValid: 'unknown',
        workspaceId: tx.workspaceId,
        error: 'gateway credentials no longer present',
      });
      return c.json({ ok: true, deferred: true });
    }

    const adapter = getAdapter(gatewayId);
    let credentials: unknown;
    try {
      credentials = adapter.parseCredentials(
        services.crypto.unsealJson<Record<string, unknown>>(credRow.credentialsEncrypted),
      );
    } catch (cause) {
      process.stdout.write(
        `${JSON.stringify({
          level: 'error',
          event: 'gateway.webhook.decryptFailed',
          gatewayId,
          workspaceId: tx.workspaceId,
          error: cause instanceof Error ? cause.message : String(cause),
        })}\n`,
      );
      return c.json({ error: 'credential_decode_failed' }, 500);
    }

    // 4. Verify signature.
    let event;
    try {
      event = adapter.verifyWebhook(credentials as never, {
        rawBody: raw,
        headers,
        queryParams,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await storeRaw({
        services,
        source: gatewayId,
        eventId: `invalid-sig:${gatewayId}:${resourceId}:${Date.now()}`,
        eventType: 'signature_invalid',
        headers,
        raw,
        signatureValid: 'invalid',
        workspaceId: tx.workspaceId,
        error: message,
      });
      if (cause instanceof PayunivercartError && cause.code === 'WEBHOOK_INVALID_SIGNATURE') {
        return c.json({ error: 'invalid_signature' }, 401);
      }
      return c.json({ error: 'verification_failed' }, 400);
    }

    // 5. Idempotent dedupe + record.
    try {
      await services.db.db.insert(schema.webhooksInbound).values({
        workspaceId: tx.workspaceId,
        source: gatewayId,
        eventId: event.eventId,
        eventType: event.eventType,
        rawHeaders: headers,
        rawBody: raw,
        signatureValid: 'valid',
      });
    } catch (cause) {
      // 23505 on (source, event_id) — already processed. Ack and bail.
      if ((cause as { code?: string })?.code === '23505') {
        return c.json({ ok: true, deduplicated: true });
      }
      throw cause;
    }

    // 6. Fetch authoritative state from the gateway. We don't trust the
    //    webhook payload alone — fraudsters could send a forged "paid"
    //    event matching a public charge id. `getCharge` reads the real
    //    state with our credentials.
    try {
      const charge = await adapter.getCharge(credentials as never, event.resourceId);

      const nowDate = new Date();
      await services.db.db
        .update(schema.transactions)
        .set({
          status: charge.status,
          paidAt: charge.status === 'paid' ? nowDate : undefined,
          authorizedAt: charge.status === 'authorized' ? nowDate : undefined,
          refundedAt: charge.status === 'refunded' ? nowDate : undefined,
          chargedbackAt: charge.status === 'chargedback' ? nowDate : undefined,
          rawResponse: charge.raw as object,
        })
        .where(eq(schema.transactions.id, tx.id));

      if (charge.status === 'paid') {
        await services.db.db
          .update(schema.orders)
          .set({ status: 'paid', paidAt: nowDate })
          .where(eq(schema.orders.id, tx.orderId));
      } else if (charge.status === 'refunded') {
        await services.db.db
          .update(schema.orders)
          .set({ status: 'refunded' })
          .where(eq(schema.orders.id, tx.orderId));
      } else if (charge.status === 'failed' || charge.status === 'cancelled') {
        await services.db.db
          .update(schema.orders)
          .set({ status: 'cancelled', cancelledAt: nowDate })
          .where(eq(schema.orders.id, tx.orderId));
      }

      await services.db.db
        .update(schema.webhooksInbound)
        .set({ processedAt: new Date() })
        .where(
          and(
            eq(schema.webhooksInbound.source, gatewayId),
            eq(schema.webhooksInbound.eventId, event.eventId),
          ),
        );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await services.db.db
        .update(schema.webhooksInbound)
        .set({ error: message })
        .where(
          and(
            eq(schema.webhooksInbound.source, gatewayId),
            eq(schema.webhooksInbound.eventId, event.eventId),
          ),
        );
      // The gateway will retry; we return 500 so it backs off.
      return c.json({ error: 'processing_failed' }, 500);
    }

    return c.json({ ok: true });
  });
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

const SUPPORTED_GATEWAYS = new Set<GatewayId>(['mercadopago']);

function isSupportedGatewayId(id: string): id is GatewayId {
  return SUPPORTED_GATEWAYS.has(id as GatewayId);
}

function extractMpResourceId(queryParams: Record<string, string>, rawBody: string): string | null {
  const fromQuery = queryParams['data.id'] ?? queryParams.id;
  if (fromQuery) return String(fromQuery);
  try {
    const parsed = JSON.parse(rawBody) as { data?: { id?: unknown }; id?: unknown };
    const id = parsed.data?.id ?? parsed.id;
    if (id != null) return String(id);
  } catch {
    /* malformed body — caller will reject */
  }
  return null;
}

async function storeRaw(params: {
  services: AppServices;
  source: string;
  eventId: string;
  eventType: string;
  headers: Record<string, string>;
  raw: string;
  signatureValid: 'valid' | 'invalid' | 'unknown';
  workspaceId: string | null;
  error?: string;
}): Promise<void> {
  await params.services.db.db.insert(schema.webhooksInbound).values({
    workspaceId: params.workspaceId,
    source: params.source,
    eventId: params.eventId,
    eventType: params.eventType,
    rawHeaders: params.headers,
    rawBody: params.raw,
    signatureValid: params.signatureValid,
    error: params.error,
  });
}
