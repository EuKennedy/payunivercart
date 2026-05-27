import type { EntitlementEventType } from '@payunivercart/connect';
import { schema } from '@payunivercart/db';
import { type WebhookEvent, getAdapter } from '@payunivercart/payments';
import { type GatewayId, PayunivercartError } from '@payunivercart/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Hono } from 'hono';
import { materializeCommission } from '../affiliates/tracker';
import { ConnectDispatcher } from '../connect/dispatcher';
import { dispatchEmailNotification, dispatchWhatsappNotification } from '../notifications/dispatch';
import type { AppServices } from '../services';

/**
 * Inbound gateway webhooks. Mounted at `/webhooks/gateway/:gatewayId`
 * — NOT under `/trpc/*` because tRPC parses JSON and the gateway's HMAC
 * signature is computed over the EXACT raw body bytes.
 *
 * Routes all 4 supported gateways (Mercado Pago, Pagar.me, PagSeguro,
 * Stripe). The per-gateway resource-id extractor lives in
 * `extractResourceId(gatewayId, ...)`; everything downstream is generic
 * because the adapter contract is uniform (`verifyWebhook` + `getCharge`).
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
    //    Per-gateway shape:
    //      - mercadopago : `?data.id` or body `data.id`
    //      - pagarme     : body `data.id`
    //      - pagseguro   : body `charges[0].id` or body `id`
    //      - stripe      : body `data.object.id`
    const resourceId = extractResourceId(gatewayId, queryParams, raw);
    if (!resourceId) {
      return c.json({ error: 'missing_resource_id' }, 400);
    }

    // 1.5. MP subscription topics route to a dedicated handler. The
    //      resource id for `subscription_preapproval` events IS the
    //      preapproval id (matches `subscriptions.gatewaySubscriptionId`);
    //      for `subscription_authorized_payment` it's the recurring
    //      payment id and we'll round-trip MP to learn which
    //      preapproval it belongs to. Both branches return early so
    //      the rest of the function (built for one-time charges) stays
    //      unchanged.
    if (gatewayId === 'mercadopago') {
      const mpType = extractMpEventType(raw);
      if (mpType?.startsWith('subscription_')) {
        const result = await handleMpSubscriptionEvent(services, {
          eventType: mpType,
          resourceId,
          raw,
          headers,
          queryParams,
        });
        return c.json(result);
      }
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
    let event: WebhookEvent;
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

    // 5. Idempotent dedupe + record. Uses ON CONFLICT instead of
    //    catch-the-23505: the duplicate path is hot (every gateway
    //    retry hits it), so making it a regular path beats throwing
    //    + catching an exception every time. RETURNING tells us
    //    whether a row was actually inserted; empty result = duplicate.
    const inserted = await services.db.db
      .insert(schema.webhooksInbound)
      .values({
        workspaceId: tx.workspaceId,
        source: gatewayId,
        eventId: event.eventId,
        eventType: event.eventType,
        rawHeaders: headers,
        rawBody: raw,
        signatureValid: 'valid',
      })
      .onConflictDoNothing({
        target: [schema.webhooksInbound.source, schema.webhooksInbound.eventId],
      })
      .returning({ id: schema.webhooksInbound.id });
    if (inserted.length === 0) {
      // Duplicate — same (source, event_id) already processed. Ack
      // success so the gateway stops retrying; no further work.
      return c.json({ ok: true, deduplicated: true });
    }

    // 6. Fetch authoritative state from the gateway. We don't trust the
    //    webhook payload alone — fraudsters could send a forged "paid"
    //    event matching a public charge id. `getCharge` reads the real
    //    state with our credentials.
    //
    //    8s timeout bound: gateways occasionally stall (MP outages, DNS
    //    blips). Without a bound the webhook handler holds a DB
    //    connection for minutes and the gateway eventually times us out
    //    at the protocol layer + retries — same outcome, worse latency.
    //    8s = comfortable above the 99p (~2s) but under our 30s edge
    //    layer cap.
    try {
      const charge = await withTimeout(
        adapter.getCharge(credentials as never, event.resourceId),
        8_000,
        `${gatewayId}.getCharge`,
      );

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
        // Post-payment fan-out: receipt email + buyer WhatsApp w/
        // delivery + producer WhatsApp alert. Each leg is wrapped
        // independently — a Resend hiccup must not stop the WAHA
        // dispatch, and a WAHA hiccup must not double-mark the order
        // as paid by failing the webhook ack.
        await dispatchPaidFanOut(services, tx.orderId);
        // Pilar 2 — server-side tracking. Best-effort enqueue per
        // pixel; the worker sweep handles the actual HTTP fire so a
        // slow Meta CAPI call can't delay the webhook ack.
        try {
          await dispatchPurchaseTrackingEvent(services, tx.workspaceId, tx.orderId);
        } catch (cause) {
          process.stdout.write(
            `${JSON.stringify({
              level: 'warn',
              event: 'tracking.purchase.enqueue.failed',
              orderId: tx.orderId,
              error: cause instanceof Error ? cause.message : String(cause),
            })}\n`,
          );
        }
        // PIX-recurring activation: when the paid order is tied to a
        // subscription (orders.subscriptionId set by subscribePix), flip
        // the subscription to active + schedule the next charge. Card
        // recurring keeps its existing path (MP preapproval webhook).
        try {
          await activateSubscriptionFromPaidOrder(services, tx.orderId, nowDate);
        } catch (cause) {
          process.stdout.write(
            `${JSON.stringify({
              level: 'warn',
              event: 'subscription.activate.from.order.failed',
              orderId: tx.orderId,
              error: cause instanceof Error ? cause.message : String(cause),
            })}\n`,
          );
        }
      } else if (charge.status === 'refunded') {
        await services.db.db
          .update(schema.orders)
          .set({ status: 'refunded' })
          .where(eq(schema.orders.id, tx.orderId));
        // Reverse any affiliate commission accrued from this order +
        // revoke partner-side entitlement when the order had granted
        // one. Fire-and-log so a downstream failure (Connect partner
        // 500) doesn't block the webhook ack — gateway must NOT think
        // refund processing failed.
        await handleOrderRefundedSideEffects(services, tx.orderId);
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

/**
 * Bound a gateway round-trip so the webhook handler can't hang on a
 * stalled upstream. Rejects with a labelled Error after `ms` so the
 * surrounding try/catch maps it to a 500 + the gateway's normal retry
 * loop kicks in. The original promise keeps running unobserved; that's
 * fine — gateway SDKs are idempotent on read.
 */
/**
 * Pilar 2 — fire a Purchase event into the tracking dispatch queue
 * for every active pixel of the workspace. We pull the buyer + amount
 * directly from the paid order so the event payload is consistent
 * across providers (Meta CAPI, GA4, TikTok). Per-pixel rows insert
 * with ON CONFLICT DO NOTHING so webhook replays are no-ops.
 */
async function dispatchPurchaseTrackingEvent(
  services: AppServices,
  workspaceId: string,
  orderId: string,
): Promise<void> {
  const [order] = await services.db.db
    .select({
      id: schema.orders.id,
      total: schema.orders.totalCents,
      currency: schema.orders.currency,
      customerName: schema.orders.customerName,
      customerEmail: schema.orders.customerEmail,
      customerDocument: schema.orders.customerDocument,
      customerPhoneE164: schema.orders.customerPhoneE164,
      ipAddress: schema.orders.ipAddress,
      userAgent: schema.orders.userAgent,
      metadata: schema.orders.metadata,
    })
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);
  if (!order) return;
  const clickIds = ((order.metadata as { trackingClickIds?: Record<string, string | null> })
    ?.trackingClickIds ?? {}) as Record<string, string | null>;
  const [firstItem] = await services.db.db
    .select({
      productId: schema.orderItems.productId,
      name: schema.orderItems.name,
      qty: schema.orderItems.quantity,
      unit: schema.orderItems.unitAmountCents,
    })
    .from(schema.orderItems)
    .where(eq(schema.orderItems.orderId, orderId))
    .limit(1);
  const { dispatchEventToAllPixels } = await import('../tracking/dispatcher');
  await dispatchEventToAllPixels(services, {
    workspaceId,
    eventType: 'purchase',
    sourceType: 'order',
    sourceId: orderId,
    event: {
      currency: order.currency,
      value: Number(order.total) / 100,
      contentId: firstItem?.productId ?? null,
      contentName: firstItem?.name ?? null,
      contents: firstItem
        ? [
            {
              id: firstItem.productId,
              quantity: firstItem.qty,
              itemPrice: Number(firstItem.unit) / 100,
            },
          ]
        : undefined,
      user: {
        email: order.customerEmail,
        phoneE164: order.customerPhoneE164,
        name: order.customerName,
        document: order.customerDocument,
        country: 'BR',
        clientIpAddress: order.ipAddress,
        clientUserAgent: order.userAgent,
        fbp: clickIds.fbp ?? null,
        fbc: clickIds.fbc ?? null,
        gclid: clickIds.gclid ?? null,
        ttclid: clickIds.ttclid ?? null,
      },
    },
  });
}

/**
 * Pilar 2 — fire a Subscribe / SubscriptionRenew tracking event for
 * every active pixel of the workspace. Pulls amount + buyer from the
 * subscription row + linked plan; for renewal we prefer the just-
 * materialised order row's totalCents so refund-adjusted amounts
 * propagate correctly when the producer cancelled and reissued.
 */
async function dispatchSubscriptionTrackingEvent(
  services: AppServices,
  workspaceId: string,
  subscriptionId: string,
  eventType: 'subscribe' | 'subscription_renew',
  orderId?: string | null,
): Promise<void> {
  const [sub] = await services.db.db
    .select({
      id: schema.subscriptions.id,
      planAmount: schema.subscriptionPlans.amountCents,
      currency: schema.subscriptionPlans.currency,
      productId: schema.subscriptions.productId,
      productName: schema.products.name,
      customerName: schema.subscriptions.customerName,
      customerEmail: schema.subscriptions.customerEmail,
      customerDocument: schema.subscriptions.customerDocument,
      customerPhoneE164: schema.subscriptions.customerPhoneE164,
    })
    .from(schema.subscriptions)
    .innerJoin(
      schema.subscriptionPlans,
      eq(schema.subscriptionPlans.id, schema.subscriptions.planId),
    )
    .leftJoin(schema.products, eq(schema.products.id, schema.subscriptions.productId))
    .where(eq(schema.subscriptions.id, subscriptionId))
    .limit(1);
  if (!sub) return;

  // Prefer the actual order total when present — handles refunded or
  // partial recurring charges where plan-list price would lie.
  let amountCents = sub.planAmount;
  if (orderId) {
    const [order] = await services.db.db
      .select({ total: schema.orders.totalCents })
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);
    if (order) amountCents = order.total;
  }

  const { dispatchEventToAllPixels } = await import('../tracking/dispatcher');
  await dispatchEventToAllPixels(services, {
    workspaceId,
    eventType,
    sourceType: 'subscription',
    sourceId: orderId ?? subscriptionId,
    event: {
      currency: sub.currency,
      value: Number(amountCents) / 100,
      contentId: sub.productId,
      contentName: sub.productName,
      contents: [
        {
          id: sub.productId,
          quantity: 1,
          itemPrice: Number(amountCents) / 100,
        },
      ],
      user: {
        email: sub.customerEmail,
        phoneE164: sub.customerPhoneE164,
        name: sub.customerName,
        document: sub.customerDocument,
        country: 'BR',
      },
    },
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

const SUPPORTED_GATEWAYS = new Set<GatewayId>(['mercadopago', 'pagarme', 'pagseguro', 'stripe']);

function isSupportedGatewayId(id: string): id is GatewayId {
  return SUPPORTED_GATEWAYS.has(id as GatewayId);
}

function extractResourceId(
  gatewayId: GatewayId,
  queryParams: Record<string, string>,
  rawBody: string,
): string | null {
  switch (gatewayId) {
    case 'mercadopago':
      return extractMpResourceId(queryParams, rawBody);
    case 'pagarme':
      return extractPagarmeResourceId(rawBody);
    case 'pagseguro':
      return extractPagSeguroResourceId(rawBody);
    case 'stripe':
      return extractStripeResourceId(rawBody);
  }
}

/**
 * MP webhook bodies carry a `type` (v2) or `topic` (legacy v1) field.
 * Subscription events live under `subscription_preapproval` and
 * `subscription_authorized_payment`.
 */
function extractMpEventType(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as { type?: unknown; topic?: unknown };
    if (typeof parsed.type === 'string') return parsed.type;
    if (typeof parsed.topic === 'string') return parsed.topic;
    return null;
  } catch {
    return null;
  }
}

/**
 * Process MP subscription events. For `subscription_preapproval` we
 * round-trip `adapter.getSubscription(...)` so the local mirror picks
 * up the canonical status (active / paused / cancelled / expired) and
 * the new `next_payment_date`. Authorized-payment events are persisted
 * only — the orders / receipts surfaces lands in a follow-up.
 */
async function handleMpSubscriptionEvent(
  services: AppServices,
  ctx: {
    eventType: string;
    resourceId: string;
    raw: string;
    headers: Record<string, string>;
    queryParams: Record<string, string>;
  },
): Promise<{ ok: true; deferred?: boolean; status?: string }> {
  if (ctx.eventType === 'subscription_authorized_payment') {
    // Recurring charge fired by MP. Resource id is the authorized_payment
    // id; we resolve it to a preapproval_id by calling MP's authorized
    // payments endpoint. To find which workspace's access token can read
    // this payment, we iterate over MP credentials — small in absolute
    // numbers (one or two per workspace) so the brute-force is fine.
    return handleMpRecurringPayment(services, ctx);
  }
  if (ctx.eventType !== 'subscription_preapproval') {
    await storeRaw({
      services,
      source: 'mercadopago',
      eventId: `subevent:${ctx.eventType}:${ctx.resourceId}:${Date.now()}`,
      eventType: ctx.eventType,
      headers: ctx.headers,
      raw: ctx.raw,
      signatureValid: 'unknown',
      workspaceId: null,
    });
    return { ok: true, deferred: true };
  }

  const [sub] = await services.db.db
    .select({
      id: schema.subscriptions.id,
      workspaceId: schema.subscriptions.workspaceId,
      status: schema.subscriptions.status,
    })
    .from(schema.subscriptions)
    .where(
      and(
        eq(schema.subscriptions.gatewayId, 'mercadopago'),
        eq(schema.subscriptions.gatewaySubscriptionId, ctx.resourceId),
      ),
    )
    .limit(1);
  if (!sub) {
    await storeRaw({
      services,
      source: 'mercadopago',
      eventId: `sub-pending:${ctx.resourceId}:${Date.now()}`,
      eventType: ctx.eventType,
      headers: ctx.headers,
      raw: ctx.raw,
      signatureValid: 'unknown',
      workspaceId: null,
      error: 'subscription not yet recorded for resourceId',
    });
    return { ok: true, deferred: true };
  }

  const [credRow] = await services.db.db
    .select({ credentialsEncrypted: schema.gatewayCredentials.credentialsEncrypted })
    .from(schema.gatewayCredentials)
    .where(
      and(
        eq(schema.gatewayCredentials.workspaceId, sub.workspaceId),
        eq(schema.gatewayCredentials.gatewayId, 'mercadopago'),
        eq(schema.gatewayCredentials.isDefault, true),
      ),
    )
    .limit(1);
  if (!credRow) {
    return { ok: true, deferred: true };
  }

  const adapter = getAdapter('mercadopago');
  if (!adapter.getSubscription) return { ok: true, deferred: true };
  const credentials = adapter.parseCredentials(
    services.crypto.unsealJson<Record<string, unknown>>(credRow.credentialsEncrypted),
  );

  try {
    const fresh = await withTimeout(
      adapter.getSubscription(credentials as never, ctx.resourceId),
      8_000,
      'mp.getSubscription',
    );
    const now = new Date();
    const previousStatus = sub.status;
    // Optimistic concurrency: gate the UPDATE on the status we observed
    // when we read the row. If a concurrent webhook already advanced the
    // state machine, `.returning()` comes back empty and we skip the
    // fan-out so the same transition never fires twice (e.g., two
    // payment.updated events arriving 100ms apart both seeing
    // status='pending' and both dispatching activation email).
    const updated = await services.db.db
      .update(schema.subscriptions)
      .set({
        status: fresh.status,
        nextChargeAt: fresh.nextChargeAt ?? null,
        startedAt: fresh.status === 'active' && !sub.status ? now : undefined,
        cancelledAt: fresh.status === 'cancelled' ? now : null,
        updatedAt: now,
      })
      .where(
        and(eq(schema.subscriptions.id, sub.id), eq(schema.subscriptions.status, previousStatus)),
      )
      .returning({ id: schema.subscriptions.id });
    if (updated.length === 0) {
      // Concurrent winner already advanced; nothing more to do here.
      return { ok: true, deferred: false };
    }

    // Buyer + producer fan-out on first activation (pending → active/trialing).
    // Emits delivery email + WhatsApp using subscription-side customer data.
    const activated = fresh.status === 'active' && previousStatus !== 'active';
    if (activated) {
      await dispatchSubscriptionActivatedFanOut(services, sub.id);
      // Pilar 2 — fire `subscribe` tracking event the first time a
      // subscription goes active. Wrapped so a tracking outage cannot
      // block the activation fan-out itself.
      try {
        await dispatchSubscriptionTrackingEvent(services, sub.workspaceId, sub.id, 'subscribe');
      } catch (cause) {
        process.stdout.write(
          `${JSON.stringify({
            level: 'warn',
            event: 'tracking.subscribe.enqueue.failed',
            subscriptionId: sub.id,
            error: cause instanceof Error ? cause.message : String(cause),
          })}\n`,
        );
      }
    }

    // Dispatch Univercart Connect entitlement event when the status
    // transition is meaningful for a 3rd-party SaaS partner. Mapping:
    //   pending → active|trialing      → entitlement.granted
    //   active|trialing → paused|past_due → entitlement.suspended
    //   paused|past_due → active        → entitlement.reactivated
    //   * → cancelled                  → entitlement.revoked
    const dispatchType = mapStatusTransition(sub.status, fresh.status);
    if (dispatchType) {
      const dispatcher = new ConnectDispatcher(services);
      const result = await dispatcher.dispatch({
        type: dispatchType,
        subscriptionId: sub.id,
      });
      if ('skipped' in result) {
        // Skipping is normal for non-partner subscriptions; only log if
        // something looks wrong (e.g. partner suspended after we already
        // started provisioning).
        if (!result.reason.startsWith('plan_has_no_partner')) {
          process.stdout.write(
            `${JSON.stringify({
              level: 'info',
              event: 'connect.dispatch.skipped',
              subscriptionId: sub.id,
              type: dispatchType,
              reason: result.reason,
            })}\n`,
          );
        }
      }
    }

    return { ok: true, status: fresh.status };
  } catch (cause) {
    process.stdout.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'mp.subscription.refresh.failed',
        subscriptionId: sub.id,
        error: cause instanceof Error ? cause.message : String(cause),
      })}\n`,
    );
    return { ok: true, deferred: true };
  }
}

/**
 * Handle MP `subscription_authorized_payment` — a recurring charge has
 * been processed (status varies). We:
 *   1. Iterate over enabled MP credentials and call
 *      `GET /authorized_payments/{id}` until one succeeds.
 *   2. Read `preapproval_id` from the response → map to our subscription.
 *   3. Materialise an `orders` row tagged with the next cycle so the
 *      Pedidos UI + analytics surface the renewal revenue.
 *   4. Update `subscriptions.lastChargedAt` + `nextChargeAt`.
 *
 * Idempotent: a partial unique index on (subscription_id, cycle_number)
 * prevents double-materialisation when MP retries the webhook.
 */
async function handleMpRecurringPayment(
  services: AppServices,
  ctx: { resourceId: string; raw: string; headers: Record<string, string> },
): Promise<{ ok: true; deferred?: boolean; status?: string }> {
  const paymentId = ctx.resourceId;

  // Fetch ALL MP credential rows. We don't know which workspace the
  // payment belongs to until MP confirms; bias on `is_default` first
  // since the recurring engine usually rides on it.
  const creds = await services.db.db
    .select({
      id: schema.gatewayCredentials.id,
      workspaceId: schema.gatewayCredentials.workspaceId,
      credentialsEncrypted: schema.gatewayCredentials.credentialsEncrypted,
      isDefault: schema.gatewayCredentials.isDefault,
    })
    .from(schema.gatewayCredentials)
    .where(eq(schema.gatewayCredentials.gatewayId, 'mercadopago'))
    .orderBy(desc(schema.gatewayCredentials.isDefault));

  let preapprovalId: string | null = null;
  let amountCents: number | null = null;
  let chargeStatus: string | null = null;

  for (const cred of creds) {
    const parsed = (() => {
      try {
        const raw = services.crypto.unsealJson<Record<string, unknown>>(cred.credentialsEncrypted);
        const accessToken = typeof raw.accessToken === 'string' ? raw.accessToken : null;
        return accessToken;
      } catch {
        return null;
      }
    })();
    if (!parsed) continue;
    try {
      const res = await fetch(
        `https://api.mercadopago.com/authorized_payments/${encodeURIComponent(paymentId)}`,
        { headers: { Authorization: `Bearer ${parsed}` }, signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) continue;
      const json = (await res.json()) as {
        preapproval_id?: string;
        status?: string;
        transaction_amount?: number;
      };
      if (!json.preapproval_id) continue;
      preapprovalId = json.preapproval_id;
      amountCents =
        typeof json.transaction_amount === 'number'
          ? Math.round(json.transaction_amount * 100)
          : null;
      chargeStatus = json.status ?? null;
      break;
    } catch {
      /* try next credential */
    }
  }

  if (!preapprovalId) {
    await storeRaw({
      services,
      source: 'mercadopago',
      eventId: `auth-payment-orphan:${paymentId}:${Date.now()}`,
      eventType: 'subscription_authorized_payment',
      headers: ctx.headers,
      raw: ctx.raw,
      signatureValid: 'unknown',
      workspaceId: null,
      error: 'could not resolve preapproval_id with any MP credential',
    });
    return { ok: true, deferred: true };
  }

  // Map preapproval → our subscription.
  const [sub] = await services.db.db
    .select({ id: schema.subscriptions.id, workspaceId: schema.subscriptions.workspaceId })
    .from(schema.subscriptions)
    .where(
      and(
        eq(schema.subscriptions.gatewayId, 'mercadopago'),
        eq(schema.subscriptions.gatewaySubscriptionId, preapprovalId),
      ),
    )
    .limit(1);
  if (!sub) {
    await storeRaw({
      services,
      source: 'mercadopago',
      eventId: `auth-payment-no-sub:${preapprovalId}:${Date.now()}`,
      eventType: 'subscription_authorized_payment',
      headers: ctx.headers,
      raw: ctx.raw,
      signatureValid: 'unknown',
      workspaceId: null,
      error: `preapproval ${preapprovalId} not in our subscriptions table`,
    });
    return { ok: true, deferred: true };
  }

  // Only materialise on successful captures; skip pending/rejected.
  if (chargeStatus !== 'approved' && chargeStatus !== 'accredited') {
    process.stdout.write(
      `${JSON.stringify({
        level: 'info',
        event: 'mp.recurring.skip',
        subscriptionId: sub.id,
        chargeStatus,
        paymentId,
      })}\n`,
    );
    return { ok: true, status: chargeStatus ?? 'unknown' };
  }

  const cycle = await nextSubscriptionCycle(services, sub.id);
  const orderId = await materializeSubscriptionOrder(services, {
    subscriptionId: sub.id,
    cycleNumber: cycle,
    gatewayChargeId: paymentId,
  });

  await services.db.db
    .update(schema.subscriptions)
    .set({ lastChargedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.subscriptions.id, sub.id));

  // If the original sale had an affiliate attribution AND the program
  // is recurring/lifetime, materialise the next-cycle commission row.
  // We don't refire `resolveAttribution` (the attribution was set in
  // stone at subscribe-time); we just compute a new commission row
  // tied to the existing attribution + cycle.
  await materializeRenewalCommissionIfApplicable(services, {
    subscriptionId: sub.id,
    cycleNumber: cycle,
    orderId,
  });

  // Pilar 2 — fire `subscription_renew` tracking event for every
  // recurring payment that materialised an order row. Cycle 1 is the
  // initial activation (already handled by the `subscribe` event in
  // the preapproval handler), so we only fire on cycle >= 2.
  if (cycle >= 2 && orderId) {
    try {
      await dispatchSubscriptionTrackingEvent(
        services,
        sub.workspaceId,
        sub.id,
        'subscription_renew',
        orderId,
      );
    } catch (cause) {
      process.stdout.write(
        `${JSON.stringify({
          level: 'warn',
          event: 'tracking.renewal.enqueue.failed',
          subscriptionId: sub.id,
          cycle,
          error: cause instanceof Error ? cause.message : String(cause),
        })}\n`,
      );
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      event: orderId ? 'mp.recurring.materialised' : 'mp.recurring.duplicate',
      subscriptionId: sub.id,
      cycle,
      orderId,
      amountCents,
      paymentId,
    })}\n`,
  );

  return { ok: true, status: 'approved' };
}

/**
 * For subscriptions that already have an affiliate attribution AND a
 * recurring/lifetime commission program, write a fresh commission row
 * for this cycle. Idempotent via the (attribution, cycle) unique
 * index — webhook retries collapse silently.
 */
async function materializeRenewalCommissionIfApplicable(
  services: AppServices,
  args: { subscriptionId: string; cycleNumber: number; orderId: string | null },
): Promise<void> {
  const [attr] = await services.db.db
    .select({
      id: schema.affiliateAttributions.id,
      workspaceId: schema.affiliateAttributions.workspaceId,
      programId: schema.affiliateAttributions.programId,
      affiliateId: schema.affiliateAttributions.affiliateId,
      commissionType: schema.affiliatePrograms.commissionType,
      commissionPercent: schema.affiliatePrograms.commissionPercent,
      commissionFlatCents: schema.affiliatePrograms.commissionFlatCents,
      refundWindowDays: schema.affiliatePrograms.refundWindowDays,
      recurringCycleLimit: schema.affiliatePrograms.recurringCycleLimit,
    })
    .from(schema.affiliateAttributions)
    .innerJoin(
      schema.affiliatePrograms,
      eq(schema.affiliatePrograms.id, schema.affiliateAttributions.programId),
    )
    .where(eq(schema.affiliateAttributions.subscriptionId, args.subscriptionId))
    .limit(1);
  if (!attr) return;
  // Only recurring + lifetime accrue beyond cycle 1.
  if (attr.commissionType !== 'recurring' && attr.commissionType !== 'lifetime') return;
  if (
    attr.commissionType === 'recurring' &&
    attr.recurringCycleLimit != null &&
    args.cycleNumber > attr.recurringCycleLimit
  ) {
    return;
  }
  await materializeCommission(services, {
    workspaceId: attr.workspaceId,
    programId: attr.programId,
    affiliateId: attr.affiliateId,
    attributionId: attr.id,
    orderId: args.orderId,
    subscriptionId: args.subscriptionId,
    cycleNumber: args.cycleNumber,
    commissionType: attr.commissionType as 'percent' | 'flat' | 'recurring' | 'lifetime',
    commissionPercent: attr.commissionPercent,
    commissionFlatCents: attr.commissionFlatCents != null ? BigInt(attr.commissionFlatCents) : null,
    refundWindowDays: attr.refundWindowDays,
  });
}

/**
 * Map a (previous, next) subscription status pair to the Univercart
 * Connect event type. Returns `null` when the transition has no
 * partner-visible meaning (e.g. metadata-only edits, status unchanged).
 */
function mapStatusTransition(prev: string, next: string): EntitlementEventType | null {
  if (prev === next) return null;
  const isActive = (s: string) => s === 'active' || s === 'trialing';
  const isPaused = (s: string) => s === 'paused' || s === 'past_due';
  // Terminal states (cancelled / expired / finished) all revoke.
  if (next === 'cancelled' || next === 'expired' || next === 'finished') {
    return 'entitlement.revoked';
  }
  if (isPaused(prev) && isActive(next)) return 'entitlement.reactivated';
  if (isActive(prev) && isPaused(next)) return 'entitlement.suspended';
  if (!isActive(prev) && isActive(next)) return 'entitlement.granted';
  return null;
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

function extractPagarmeResourceId(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as {
      data?: { id?: unknown; charges?: Array<{ id?: unknown }> };
      id?: unknown;
    };
    const id = parsed.data?.id ?? parsed.data?.charges?.[0]?.id ?? parsed.id;
    return id != null ? String(id) : null;
  } catch {
    return null;
  }
}

function extractPagSeguroResourceId(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as {
      charges?: Array<{ id?: unknown }>;
      id?: unknown;
    };
    const id = parsed.charges?.[0]?.id ?? parsed.id;
    return id != null ? String(id) : null;
  } catch {
    return null;
  }
}

function extractStripeResourceId(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as {
      data?: { object?: { id?: unknown } };
      id?: unknown;
    };
    const id = parsed.data?.object?.id ?? parsed.id;
    return id != null ? String(id) : null;
  } catch {
    return null;
  }
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

/**
 * Side-effects triggered when the gateway confirms payment:
 *   1. Receipt email to the buyer (with optional delivery link).
 *   2. WhatsApp message to the buyer w/ delivery instructions, when
 *      a WAHA chatId is on file AND the workspace's session is up.
 *   3. WhatsApp ping to the producer's own number (if they set one
 *      under Configurações → Empresa).
 *
 * Every leg is wrapped in try/catch and logged. The webhook ack must
 * not depend on any single side-effect: if Resend is down we still
 * fire WAHA; if WAHA is down we still keep the order marked paid.
 *
 * Exported so the manual `orders.syncWithGateway` path can reuse the
 * same fan-out — buyers must receive the same email + WhatsApp
 * regardless of whether the webhook fired or the producer clicked
 * "Verificar pagamento" by hand.
 */
export async function dispatchPaidFanOut(services: AppServices, orderId: string): Promise<void> {
  const [row] = await services.db.db
    .select({
      email: schema.orders.customerEmail,
      name: schema.orders.customerName,
      ref: schema.orders.publicReference,
      total: schema.orders.totalCents,
      currency: schema.orders.currency,
      customerWahaChatId: schema.orders.customerWahaChatId,
      workspaceId: schema.orders.workspaceId,
      workspaceName: schema.workspaces.name,
      workspaceCompanyName: schema.workspaces.companyName,
      notificationPhoneE164: schema.workspaces.notificationPhoneE164,
    })
    .from(schema.orders)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.orders.workspaceId))
    .where(eq(schema.orders.id, orderId))
    .limit(1);
  if (!row) return;

  // Product is read via order_items → products. Order_items always
  // has the snapshotted product name; we go to `products` only for
  // the delivery fields the producer may have set on the catalogue.
  const [item] = await services.db.db
    .select({
      name: schema.orderItems.name,
      productId: schema.orderItems.productId,
      deliveryUrl: schema.products.deliveryUrl,
      deliveryInstructions: schema.products.deliveryInstructions,
    })
    .from(schema.orderItems)
    .leftJoin(schema.products, eq(schema.products.id, schema.orderItems.productId))
    .where(eq(schema.orderItems.orderId, orderId))
    .limit(1);

  const brand = row.workspaceCompanyName?.trim() || row.workspaceName;
  const amountFormatted = new Intl.NumberFormat(row.currency === 'BRL' ? 'pt-BR' : 'en-US', {
    style: 'currency',
    currency: row.currency,
    minimumFractionDigits: 2,
  }).format(Number(row.total) / 100);
  const productName = item?.name ?? 'seu pedido';
  const deliveryUrl = item?.deliveryUrl ?? null;
  const deliveryInstructions = item?.deliveryInstructions ?? null;

  // -- 1. Receipt email -----------------------------------------------------
  // First-name + access block resolved here so both the workspace-
  // custom template and the legacy fallback render with the same
  // values. `acesso` packs URL + instructions into a single string
  // because the producer's template body is plain text — formatting
  // is the producer's call.
  const buyerFirstNameForEmail = (row.name.split(/\s+/)[0] ?? row.name).trim();
  const accessBlock = [deliveryUrl, deliveryInstructions].filter(Boolean).join('\n');
  try {
    await dispatchEmailNotification({
      services,
      workspaceId: row.workspaceId,
      eventKey: 'order_paid_buyer',
      to: row.email,
      brand,
      vars: {
        brand,
        nome: buyerFirstNameForEmail,
        produto: productName,
        valor: amountFormatted,
        codigo: row.ref,
        acesso: accessBlock,
      },
      fallback: () =>
        services.emails.sendOrderPaid({
          to: row.email,
          customerName: row.name,
          publicReference: row.ref,
          productName,
          amountFormatted,
          brand,
          deliveryUrl,
          deliveryInstructions,
        }),
    });
  } catch (cause) {
    process.stdout.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'orderPaid.email.failed',
        orderId,
        error: cause instanceof Error ? cause.message : String(cause),
      })}\n`,
    );
  }

  // -- 2/3. WhatsApp dispatch ------------------------------------------------
  // Both buyer + producer pings ride the same workspace WAHA session.
  // If the workspace hasn't connected one we skip silently — the
  // email still went out.
  const [sessionRow] = await services.db.db
    .select({ sessionName: schema.whatsappSessions.wahaSessionId })
    .from(schema.whatsappSessions)
    .where(eq(schema.whatsappSessions.workspaceId, row.workspaceId))
    .limit(1);
  if (!sessionRow) {
    // Surface structured warn so ops can correlate "buyer got email
    // but no WhatsApp" reports against a missing session config. The
    // previous silent `return` made this invisible to monitoring.
    process.stdout.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'orderPaid.whatsapp.skipped',
        reason: 'no_whatsapp_session_configured',
        orderId,
        workspaceId: row.workspaceId,
      })}\n`,
    );
    return;
  }
  const sessionName = sessionRow.sessionName;

  const firstName = row.name.split(/\s+/)[0] ?? row.name;
  const deliveryLine = deliveryUrl
    ? `\n\n👉 Acesso: ${deliveryUrl}${deliveryInstructions ? `\n\n${deliveryInstructions}` : ''}`
    : deliveryInstructions
      ? `\n\n${deliveryInstructions}`
      : '';
  const buyerText =
    `Oi ${firstName}! Pagamento de *${productName}* confirmado ✅\n` +
    `Pedido ${row.ref} · ${amountFormatted}.${deliveryLine}\n\n— ${brand}`;

  const buyerVars = {
    brand,
    nome: firstName,
    produto: productName,
    valor: amountFormatted,
    codigo: row.ref,
    cliente: row.name,
  };

  if (row.customerWahaChatId) {
    try {
      await dispatchWhatsappNotification({
        services,
        workspaceId: row.workspaceId,
        eventKey: 'order_paid_buyer',
        sessionName,
        chatId: row.customerWahaChatId as `${string}@c.us`,
        fallbackText: buyerText,
        linkPreview: !!deliveryUrl,
        vars: buyerVars,
      });
    } catch (cause) {
      process.stdout.write(
        `${JSON.stringify({
          level: 'warn',
          event: 'orderPaid.buyerWhatsapp.failed',
          orderId,
          error: cause instanceof Error ? cause.message : String(cause),
        })}\n`,
      );
    }
  }

  if (row.notificationPhoneE164) {
    const producerChatId = `${row.notificationPhoneE164.replace(/\D+/g, '')}@c.us` as const;
    const producerText =
      `💰 Venda nova em *${brand}*\n` +
      `${row.name} comprou *${productName}* por ${amountFormatted}.\n` +
      `Pedido ${row.ref}.`;
    try {
      await dispatchWhatsappNotification({
        services,
        workspaceId: row.workspaceId,
        eventKey: 'order_paid_producer',
        sessionName,
        chatId: producerChatId,
        fallbackText: producerText,
        linkPreview: false,
        vars: buyerVars,
      });
    } catch (cause) {
      process.stdout.write(
        `${JSON.stringify({
          level: 'warn',
          event: 'orderPaid.producerWhatsapp.failed',
          orderId,
          error: cause instanceof Error ? cause.message : String(cause),
        })}\n`,
      );
    }
  }
}

/**
 * Subscription activation fan-out — same shape as `dispatchPaidFanOut`
 * but reads from `subscriptions` instead of `orders`. Fires when the
 * recurring engine transitions a subscription from pending → active or
 * trialing for the first time. Sends:
 *
 *   1. Welcome / receipt email to the buyer (delivery link if set).
 *   2. WhatsApp confirmation to the buyer.
 *   3. Producer ping for the new MRR signal.
 *
 * Renewal events (`subscription_authorized_payment` topic) currently log
 * only; if we ever start creating per-cycle `subscription_charges` rows
 * we can add a thinner "renewal" fan-out from here.
 */
export async function dispatchSubscriptionActivatedFanOut(
  services: AppServices,
  subscriptionId: string,
): Promise<void> {
  const [row] = await services.db.db
    .select({
      email: schema.subscriptions.customerEmail,
      name: schema.subscriptions.customerName,
      ref: schema.subscriptions.publicReference,
      customerWahaChatId: schema.subscriptions.customerWahaChatId,
      workspaceId: schema.subscriptions.workspaceId,
      productId: schema.subscriptions.productId,
      planAmount: schema.subscriptionPlans.amountCents,
      planPeriod: schema.subscriptionPlans.billingPeriod,
      productName: schema.products.name,
      deliveryUrl: schema.products.deliveryUrl,
      deliveryInstructions: schema.products.deliveryInstructions,
      workspaceName: schema.workspaces.name,
      workspaceCompanyName: schema.workspaces.companyName,
      notificationPhoneE164: schema.workspaces.notificationPhoneE164,
    })
    .from(schema.subscriptions)
    .innerJoin(
      schema.subscriptionPlans,
      eq(schema.subscriptionPlans.id, schema.subscriptions.planId),
    )
    .innerJoin(schema.products, eq(schema.products.id, schema.subscriptions.productId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.subscriptions.workspaceId))
    .where(eq(schema.subscriptions.id, subscriptionId))
    .limit(1);
  if (!row) return;

  const brand = row.workspaceCompanyName?.trim() || row.workspaceName;
  const amountFormatted = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  }).format(Number(row.planAmount) / 100);
  const periodLabel = row.planPeriod === 'yearly' ? '/ano' : '/mês';
  const productName = row.productName;
  const deliveryUrl = row.deliveryUrl ?? null;
  const deliveryInstructions = row.deliveryInstructions ?? null;

  // -- 1. Welcome / activation email ---------------------------------------
  const buyerFirstNameForEmail = (row.name.split(/\s+/)[0] ?? row.name).trim();
  const accessBlock = [deliveryUrl, deliveryInstructions].filter(Boolean).join('\n');
  try {
    await dispatchEmailNotification({
      services,
      workspaceId: row.workspaceId,
      eventKey: 'subscription_activated_buyer',
      to: row.email,
      brand,
      vars: {
        brand,
        nome: buyerFirstNameForEmail,
        produto: productName,
        valor: `${amountFormatted}${periodLabel}`,
        codigo: row.ref,
        acesso: accessBlock,
      },
      fallback: () =>
        services.emails.sendOrderPaid({
          to: row.email,
          customerName: row.name,
          publicReference: row.ref,
          productName,
          amountFormatted: `${amountFormatted}${periodLabel}`,
          brand,
          deliveryUrl,
          deliveryInstructions,
        }),
    });
  } catch (cause) {
    process.stdout.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'subscription.activation.email.failed',
        subscriptionId,
        error: cause instanceof Error ? cause.message : String(cause),
      })}\n`,
    );
  }

  // -- 2/3. WhatsApp dispatch ----------------------------------------------
  const [sessionRow] = await services.db.db
    .select({ sessionName: schema.whatsappSessions.wahaSessionId })
    .from(schema.whatsappSessions)
    .where(eq(schema.whatsappSessions.workspaceId, row.workspaceId))
    .limit(1);
  if (!sessionRow) {
    process.stdout.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'subscription.activation.whatsapp.skipped',
        reason: 'no_whatsapp_session_configured',
        subscriptionId,
        workspaceId: row.workspaceId,
      })}\n`,
    );
    return;
  }
  const sessionName = sessionRow.sessionName;

  const firstName = row.name.split(/\s+/)[0] ?? row.name;
  const deliveryLine = deliveryUrl
    ? `\n\n👉 Acesso: ${deliveryUrl}${deliveryInstructions ? `\n\n${deliveryInstructions}` : ''}`
    : deliveryInstructions
      ? `\n\n${deliveryInstructions}`
      : '';
  const buyerText =
    `Oi ${firstName}! Assinatura de *${productName}* ativada ✅\n` +
    `Plano ${amountFormatted}${periodLabel} · Pedido ${row.ref}.${deliveryLine}\n\n— ${brand}`;

  const subVars = {
    brand,
    nome: firstName,
    produto: productName,
    valor: `${amountFormatted}${periodLabel}`,
    codigo: row.ref,
    cliente: row.name,
  };

  if (row.customerWahaChatId) {
    try {
      await dispatchWhatsappNotification({
        services,
        workspaceId: row.workspaceId,
        eventKey: 'subscription_activated_buyer',
        sessionName,
        chatId: row.customerWahaChatId as `${string}@c.us`,
        fallbackText: buyerText,
        linkPreview: !!deliveryUrl,
        vars: subVars,
      });
    } catch (cause) {
      process.stdout.write(
        `${JSON.stringify({
          level: 'warn',
          event: 'subscription.activation.buyerWhatsapp.failed',
          subscriptionId,
          error: cause instanceof Error ? cause.message : String(cause),
        })}\n`,
      );
    }
  }

  if (row.notificationPhoneE164) {
    const producerChatId = `${row.notificationPhoneE164.replace(/\D+/g, '')}@c.us` as const;
    const producerText =
      `💰 Nova assinatura em *${brand}*\n` +
      `${row.name} assinou *${productName}* por ${amountFormatted}${periodLabel}.\n` +
      `Pedido ${row.ref}.`;
    try {
      await dispatchWhatsappNotification({
        services,
        workspaceId: row.workspaceId,
        eventKey: 'subscription_activated_producer',
        sessionName,
        chatId: producerChatId,
        fallbackText: producerText,
        linkPreview: false,
        vars: subVars,
      });
    } catch (cause) {
      process.stdout.write(
        `${JSON.stringify({
          level: 'warn',
          event: 'subscription.activation.producerWhatsapp.failed',
          subscriptionId,
          error: cause instanceof Error ? cause.message : String(cause),
        })}\n`,
      );
    }
  }
}

/**
 * Materialise an `orders` row (+ `order_items`) from a subscription
 * charge cycle. Used by:
 *   - subscribe route on activation (cycleNumber = 1)
 *   - subscription_authorized_payment webhook on each renewal
 *     (cycleNumber = N+1, computed from existing rows)
 *
 * Why orders, not a dedicated `subscription_charges` table:
 * analytics + Pedidos UI already read from `orders`. Materialising
 * the cycle as an order makes every report (GMV, conversion, top
 * products, payment method split, recent orders feed) work without
 * touching the metrics router.
 *
 * Idempotency: the partial unique index `orders_subscription_cycle_unique`
 * blocks duplicate rows for the same (subscription, cycle). The function
 * swallows the unique-violation as a no-op so MP webhook retries don't
 * 500. Returns the materialised order id on success, null on dedupe.
 */
export async function materializeSubscriptionOrder(
  services: AppServices,
  args: {
    subscriptionId: string;
    cycleNumber: number;
    /** Optional: tag the order with the gateway charge id for traceability. */
    gatewayChargeId?: string;
  },
): Promise<string | null> {
  const { db } = services.db;

  const [sub] = await db
    .select({
      id: schema.subscriptions.id,
      workspaceId: schema.subscriptions.workspaceId,
      productId: schema.subscriptions.productId,
      planId: schema.subscriptions.planId,
      publicReference: schema.subscriptions.publicReference,
      customerName: schema.subscriptions.customerName,
      customerEmail: schema.subscriptions.customerEmail,
      customerDocument: schema.subscriptions.customerDocument,
      customerPhoneRaw: schema.subscriptions.customerPhoneRaw,
      customerPhoneE164: schema.subscriptions.customerPhoneE164,
      customerWahaChatId: schema.subscriptions.customerWahaChatId,
      productName: schema.products.name,
      planAmount: schema.subscriptionPlans.amountCents,
      planCurrency: schema.subscriptionPlans.currency,
    })
    .from(schema.subscriptions)
    .innerJoin(schema.products, eq(schema.products.id, schema.subscriptions.productId))
    .innerJoin(
      schema.subscriptionPlans,
      eq(schema.subscriptionPlans.id, schema.subscriptions.planId),
    )
    .where(eq(schema.subscriptions.id, args.subscriptionId))
    .limit(1);
  if (!sub) return null;

  const now = new Date();
  const orderRef =
    args.cycleNumber === 1 ? sub.publicReference : `${sub.publicReference}-C${args.cycleNumber}`;

  try {
    const [inserted] = await db
      .insert(schema.orders)
      .values({
        workspaceId: sub.workspaceId,
        subscriptionId: sub.id,
        cycleNumber: args.cycleNumber,
        publicReference: orderRef,
        status: 'paid',
        customerName: sub.customerName,
        customerEmail: sub.customerEmail,
        customerDocument: sub.customerDocument,
        customerPhoneRaw: sub.customerPhoneRaw,
        customerPhoneE164: sub.customerPhoneE164,
        customerWahaChatId: sub.customerWahaChatId,
        subtotalCents: BigInt(sub.planAmount),
        totalCents: BigInt(sub.planAmount),
        currency: sub.planCurrency,
        metadata: args.gatewayChargeId
          ? { gatewayChargeId: args.gatewayChargeId, cycle: args.cycleNumber }
          : { cycle: args.cycleNumber },
        paidAt: now,
      })
      .returning({ id: schema.orders.id });

    if (!inserted) return null;

    await db.insert(schema.orderItems).values({
      orderId: inserted.id,
      productId: sub.productId,
      name:
        args.cycleNumber === 1
          ? sub.productName
          : `${sub.productName} (renovação #${args.cycleNumber})`,
      quantity: 1,
      unitAmountCents: BigInt(sub.planAmount),
      totalCents: BigInt(sub.planAmount),
    });

    return inserted.id;
  } catch (cause) {
    const code =
      cause && typeof cause === 'object' && 'code' in cause
        ? String((cause as { code: unknown }).code)
        : null;
    if (code === '23505') return null;
    throw cause;
  }
}

/**
 * Compute the next cycle number for a subscription. Reads MAX(cycle)
 * from `orders` filtered by subscriptionId, defaults to 1 when no
 * prior charge has been materialised.
 */
export async function nextSubscriptionCycle(
  services: AppServices,
  subscriptionId: string,
): Promise<number> {
  const [row] = await services.db.db
    .select({ cycle: schema.orders.cycleNumber })
    .from(schema.orders)
    .where(eq(schema.orders.subscriptionId, subscriptionId))
    .orderBy(desc(schema.orders.cycleNumber))
    .limit(1);
  return (row?.cycle ?? 0) + 1;
}

/**
 * Refund side-effects: reverse any affiliate commission that accrued
 * from this order AND revoke the partner-side entitlement when the
 * order had granted one. Best-effort — failures are logged and
 * swallowed so the gateway webhook ack still goes out (the order's
 * `status='refunded'` is the source of truth either way).
 *
 * Commission reversal flips every `affiliate_commissions` row tied
 * to the order to `status='reversed'` with a reason. Worker that
 * runs payouts already filters out reversed rows.
 *
 * Entitlement revoke fires the Connect dispatcher with
 * `entitlement.revoked` — the partner SaaS receives the webhook and
 * yanks access on their side.
 */
async function handleOrderRefundedSideEffects(
  services: AppServices,
  orderId: string,
): Promise<void> {
  try {
    const reversed = await services.db.db
      .update(schema.affiliateCommissions)
      .set({
        status: 'reversed',
        reversalReason: 'order_refunded',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.affiliateCommissions.orderId, orderId),
          // Reversal only makes sense from pending/available. Paid
          // commissions can't be clawed back via flip — that's a
          // payout-reversal flow (manual / separate worker).
          inArray(schema.affiliateCommissions.status, ['pending', 'available']),
        ),
      )
      .returning({ id: schema.affiliateCommissions.id });
    if (reversed.length > 0) {
      process.stdout.write(
        `${JSON.stringify({
          level: 'info',
          event: 'refund.commissions.reversed',
          orderId,
          count: reversed.length,
        })}\n`,
      );
    }
  } catch (cause) {
    process.stdout.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'refund.commissions.reverse.failed',
        orderId,
        error: cause instanceof Error ? cause.message : String(cause),
      })}\n`,
    );
  }

  // Find subscription tied to this order (if any) and dispatch
  // entitlement.revoked via Connect. One-time orders without a sub
  // skip this branch.
  try {
    const [orderRow] = await services.db.db
      .select({ subscriptionId: schema.orders.subscriptionId })
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);
    if (orderRow?.subscriptionId) {
      const dispatcher = new ConnectDispatcher(services);
      await dispatcher.dispatch({
        type: 'entitlement.revoked',
        subscriptionId: orderRow.subscriptionId,
      });
    }
  } catch (cause) {
    process.stdout.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'refund.entitlement.revoke.failed',
        orderId,
        error: cause instanceof Error ? cause.message : String(cause),
      })}\n`,
    );
  }
}

/**
 * Promote a subscription from `pending` to `active` when its
 * underlying order gets paid. Used by the PIX-recurring flow: the
 * buyer pays the QR, the gateway fires `payment.updated`, the order
 * row flips to `paid`, and we then need to mirror that into the
 * subscription state machine + schedule the next charge.
 *
 * Idempotent: if the subscription is already `active`, we only refresh
 * the `currentCycleStatus`/`nextChargeAt` fields. A second webhook for
 * the same payment is therefore safe.
 *
 * Card-recurring is NOT served by this helper — MP's preapproval
 * webhook hits the existing `handlePreapprovalEvent` path which
 * already owns the card lifecycle.
 */
async function activateSubscriptionFromPaidOrder(
  services: AppServices,
  orderId: string,
  paidAt: Date,
): Promise<void> {
  const { db } = services.db;
  const [order] = await db
    .select({
      subscriptionId: schema.orders.subscriptionId,
      cycleNumber: schema.orders.cycleNumber,
    })
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);
  if (!order?.subscriptionId) return; // one-time order — nothing to do

  const [sub] = await db
    .select({
      id: schema.subscriptions.id,
      status: schema.subscriptions.status,
      startedAt: schema.subscriptions.startedAt,
      planBillingPeriod: schema.subscriptionPlans.billingPeriod,
    })
    .from(schema.subscriptions)
    .innerJoin(
      schema.subscriptionPlans,
      eq(schema.subscriptionPlans.id, schema.subscriptions.planId),
    )
    .where(eq(schema.subscriptions.id, order.subscriptionId))
    .limit(1);
  if (!sub) return;

  // Compute next charge: +1 month for monthly plans, +1 year for yearly.
  const next = new Date(paidAt);
  if (sub.planBillingPeriod === 'yearly') {
    next.setFullYear(next.getFullYear() + 1);
  } else {
    next.setMonth(next.getMonth() + 1);
  }

  await db
    .update(schema.subscriptions)
    .set({
      status: 'active',
      startedAt: sub.startedAt ?? paidAt,
      lastChargedAt: paidAt,
      nextChargeAt: next,
      currentCycleStatus: 'paid',
      pixCurrentChargeId: null,
      updatedAt: paidAt,
    })
    .where(eq(schema.subscriptions.id, sub.id));

  // Fire activation fan-out (email + WhatsApp + Connect entitlement)
  // only on the FIRST cycle — renewal payments shouldn't re-send the
  // welcome message. `cycleNumber === 1` matches the row that
  // subscribePix inserted at signup.
  if (order.cycleNumber === 1 && sub.status !== 'active') {
    try {
      await dispatchSubscriptionActivatedFanOut(services, sub.id);
    } catch (cause) {
      process.stdout.write(
        `${JSON.stringify({
          level: 'warn',
          event: 'subscription.activate.fanout.failed',
          subscriptionId: sub.id,
          error: cause instanceof Error ? cause.message : String(cause),
        })}\n`,
      );
    }
  }
}
