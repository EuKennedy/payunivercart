import {
  type AnyEntitlementEvent,
  type EntitlementEventType,
  type EntitlementGrantedData,
  type EntitlementReactivatedData,
  type EntitlementRevokedData,
  type EntitlementRoleChangedData,
  type EntitlementSuspendedData,
  signMagicLink,
} from '@payunivercart/connect';
import { schema } from '@payunivercart/db';
import { and, eq } from 'drizzle-orm';
import type { AppServices } from '../services';

/**
 * Entitlement event dispatcher.
 *
 * Called from the MP webhook handler whenever a subscription state
 * transition is detected. Persists a `connect_events` row, then fans
 * out one `connect_webhook_deliveries` row per active partner
 * endpoint that subscribed to the event type. The worker picks
 * pending deliveries off the queue and POSTs them.
 *
 * For `entitlement.granted` we ALSO mint a magic-link JWT, persist
 * the jti in `entitlement_tokens`, and enqueue email + WhatsApp jobs
 * carrying the link to the buyer.
 *
 * This module owns the "transactional outbox" boundary — once the
 * event row is committed, the worker is guaranteed to dispatch.
 */

export interface DispatchInput {
  type: EntitlementEventType;
  subscriptionId: string;
  /** Set by callers that already have the resolved partner row. */
  partnerId?: string;
}

export class ConnectDispatcher {
  constructor(private readonly services: AppServices) {}

  /**
   * Top-level entry. Loads the subscription + plan + partner + product,
   * builds the typed event payload, persists the row, and queues
   * deliveries + (for `granted`) magic-link notifications.
   */
  async dispatch(
    input: DispatchInput,
  ): Promise<{ eventId: string } | { skipped: true; reason: string }> {
    const { db } = this.services.db;

    // 1. Hydrate subscription context (single round-trip).
    const [row] = await db
      .select({
        sub: schema.subscriptions,
        plan: schema.subscriptionPlans,
        product: schema.products,
        partner: schema.partnerAccounts,
      })
      .from(schema.subscriptions)
      .innerJoin(
        schema.subscriptionPlans,
        eq(schema.subscriptionPlans.id, schema.subscriptions.planId),
      )
      .innerJoin(schema.products, eq(schema.products.id, schema.subscriptions.productId))
      .leftJoin(
        schema.partnerAccounts,
        eq(schema.partnerAccounts.id, schema.subscriptionPlans.partnerAccountId),
      )
      .where(eq(schema.subscriptions.id, input.subscriptionId))
      .limit(1);

    if (!row) return { skipped: true, reason: 'subscription_not_found' };
    if (!row.partner) return { skipped: true, reason: 'plan_has_no_partner_mapping' };
    if (row.partner.status !== 'active') {
      return { skipped: true, reason: `partner_${row.partner.status}` };
    }
    const roleSlug = row.plan.partnerRoleSlug;
    if (!roleSlug) return { skipped: true, reason: 'plan_has_no_partner_role' };

    // 2. Build the event payload by type.
    const created = Math.floor(Date.now() / 1000);
    const livemode = this.services.env.NODE_ENV === 'production';
    const validUntil = row.sub.nextChargeAt ?? row.sub.startedAt ?? new Date();

    let data:
      | EntitlementGrantedData
      | EntitlementRoleChangedData
      | EntitlementSuspendedData
      | EntitlementReactivatedData
      | EntitlementRevokedData;
    let magicLink: { url: string; jti: string } | null = null;

    switch (input.type) {
      case 'entitlement.granted': {
        // Mint magic link and persist jti BEFORE building payload so
        // the URL embedded in the webhook is the real one.
        magicLink = await this.mintMagicLink({
          subscriptionId: row.sub.id,
          email: row.sub.customerEmail,
          name: row.sub.customerName,
          partnerId: row.partner.id,
          partnerSlug: row.partner.slug,
          partnerRoleSlug: roleSlug,
          jwtSigningSecret: row.partner.jwtSigningSecret,
        });
        data = {
          externalUserId: row.sub.id,
          email: row.sub.customerEmail,
          name: row.sub.customerName,
          document: row.sub.customerDocument,
          phone: row.sub.customerPhoneE164,
          role: roleSlug,
          productSlug: row.product.slug,
          planId: row.plan.id,
          billingPeriod: row.plan.billingPeriod === 'yearly' ? 'yearly' : 'monthly',
          amountCents: Number(row.plan.amountCents),
          currency: 'BRL',
          validUntil: validUntil.toISOString(),
          trial: row.sub.status === 'trialing',
          trialEndsAt: row.sub.status === 'trialing' ? validUntil.toISOString() : null,
          magicLinkUrl: magicLink.url,
          magicLinkJti: magicLink.jti,
        };
        break;
      }
      case 'entitlement.role_changed':
        data = {
          externalUserId: row.sub.id,
          email: row.sub.customerEmail,
          previousRole: roleSlug, // previous role unknown at this layer — caller can override
          role: roleSlug,
          validUntil: validUntil.toISOString(),
          effectiveAt: 'immediate',
        };
        break;
      case 'entitlement.suspended':
        data = {
          externalUserId: row.sub.id,
          email: row.sub.customerEmail,
          role: roleSlug,
          reason: 'payment_failed',
          attemptsMade: 3,
          willRetryAt: row.sub.nextChargeAt?.toISOString() ?? null,
        };
        break;
      case 'entitlement.reactivated':
        data = {
          externalUserId: row.sub.id,
          email: row.sub.customerEmail,
          role: roleSlug,
          validUntil: validUntil.toISOString(),
        };
        break;
      case 'entitlement.revoked':
        data = {
          externalUserId: row.sub.id,
          email: row.sub.customerEmail,
          role: roleSlug,
          reason:
            row.sub.cancelReason === 'refunded'
              ? 'refunded'
              : row.sub.cancelReason === 'chargeback'
                ? 'chargeback'
                : 'cancelled_by_buyer',
          revokedAt: (row.sub.cancelledAt ?? new Date()).toISOString(),
        };
        break;
    }

    // 3. Insert event row (outbox) + delivery rows for matching endpoints.
    const event: AnyEntitlementEvent = {
      id: '', // filled after insert
      type: input.type as EntitlementEventType,
      version: 'v1',
      created,
      livemode,
      data,
    } as AnyEntitlementEvent;

    const [insertedEvent] = await db
      .insert(schema.connectEvents)
      .values({
        partnerId: row.partner.id,
        workspaceId: row.sub.workspaceId,
        subscriptionId: row.sub.id,
        type: input.type,
        payload: event,
      })
      .returning({ id: schema.connectEvents.id });

    if (!insertedEvent) {
      return { skipped: true, reason: 'event_insert_failed' };
    }
    const eventRow: { id: string } = insertedEvent;

    // Patch the event id in the persisted payload so deliveries carry the
    // same id we hand to the partner. One-shot UPDATE; deliveries are
    // queued from the patched row.
    const persistedPayload = { ...event, id: `evt_${eventRow.id}` };
    await db
      .update(schema.connectEvents)
      .set({ payload: persistedPayload })
      .where(eq(schema.connectEvents.id, eventRow.id));

    // 4. Fan out deliveries to active endpoints subscribed to this event type.
    const endpoints = await db
      .select({
        id: schema.partnerWebhookEndpoints.id,
        eventTypes: schema.partnerWebhookEndpoints.eventTypes,
        mode: schema.partnerWebhookEndpoints.mode,
      })
      .from(schema.partnerWebhookEndpoints)
      .where(
        and(
          eq(schema.partnerWebhookEndpoints.partnerId, row.partner.id),
          eq(schema.partnerWebhookEndpoints.isActive, true),
        ),
      );

    const expectedMode = livemode ? 'live' : 'test';
    const matchingEndpoints = endpoints.filter((ep) => {
      if (ep.mode !== expectedMode) return false;
      const list = Array.isArray(ep.eventTypes) ? (ep.eventTypes as string[]) : [];
      return list.includes(input.type);
    });

    if (matchingEndpoints.length > 0) {
      const nowMs = Date.now();
      await db.insert(schema.connectWebhookDeliveries).values(
        matchingEndpoints.map((ep) => ({
          eventId: eventRow.id,
          endpointId: ep.id,
          status: 'pending' as const,
          nextAttemptAt: new Date(nowMs),
        })),
      );
    }

    // 5. For `granted`, queue buyer notifications (email + WA).
    if (input.type === 'entitlement.granted' && magicLink) {
      await this.queueGrantedNotifications({
        workspaceId: row.sub.workspaceId,
        email: row.sub.customerEmail,
        name: row.sub.customerName,
        phoneE164: row.sub.customerPhoneE164,
        wahaChatId: row.sub.customerWahaChatId,
        partnerName: row.partner.name,
        productName: row.product.name,
        magicLinkUrl: magicLink.url,
      });
    }

    return { eventId: eventRow.id };
  }

  private async mintMagicLink(input: {
    subscriptionId: string;
    email: string;
    name: string;
    partnerId: string;
    partnerSlug: string;
    partnerRoleSlug: string;
    jwtSigningSecret: string;
  }): Promise<{ url: string; jti: string }> {
    const { db } = this.services.db;

    const result = signMagicLink({
      subscriptionId: input.subscriptionId,
      email: input.email,
      name: input.name,
      partnerSlug: input.partnerSlug,
      partnerRoleSlug: input.partnerRoleSlug,
      jwtSigningSecret: input.jwtSigningSecret,
    });

    await db.insert(schema.entitlementTokens).values({
      jti: result.jti,
      subscriptionId: input.subscriptionId,
      partnerId: input.partnerId,
      expiresAt: result.expiresAt,
    });

    // Default landing page is on the checkout app: `/connect/setup?t=<JWT>`.
    // Partner can override on their side by configuring a redirect from
    // the URL they expose. The first-line magic link always points at the
    // checkout host so we don't depend on partner DNS being up.
    const baseUrl = (
      this.services.env.CHECKOUT_PUBLIC_URL ?? 'https://check.univercart.com'
    ).replace(/\/$/, '');
    return {
      url: `${baseUrl}/connect/setup?t=${result.jwt}`,
      jti: result.jti,
    };
  }

  private async queueGrantedNotifications(input: {
    workspaceId: string;
    email: string;
    name: string;
    phoneE164: string;
    wahaChatId: string | null;
    partnerName: string;
    productName: string;
    magicLinkUrl: string;
  }): Promise<void> {
    // Email: fire via Resend wrapper. Plain text + HTML.
    try {
      await this.services.emails.sendEntitlementGranted({
        to: input.email,
        customerName: input.name,
        partnerName: input.partnerName,
        productName: input.productName,
        magicLinkUrl: input.magicLinkUrl,
      });
    } catch {
      /* swallow — let dispatcher continue, retries handled at infra level */
    }

    // WhatsApp (best-effort, requires WAHA session for the workspace).
    if (!input.wahaChatId) return;
    const [sessionRow] = await this.services.db.db
      .select({ sessionName: schema.whatsappSessions.wahaSessionId })
      .from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.workspaceId, input.workspaceId))
      .limit(1);
    if (!sessionRow) return;
    try {
      await this.services.waha.sendText({
        session: sessionRow.sessionName,
        chatId: input.wahaChatId as `${string}@c.us`,
        text: `Olá, ${input.name}! 👋\n\nSua assinatura de *${input.productName}* foi confirmada.\nAcesse o ${input.partnerName} aqui e defina sua senha:\n${input.magicLinkUrl}\n\n_Link válido por 72 horas._`,
        linkPreview: true,
      });
    } catch {
      /* swallow */
    }
  }
}
