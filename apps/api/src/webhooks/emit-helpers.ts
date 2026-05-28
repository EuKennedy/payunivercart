import { schema } from '@payunivercart/db';
import type {
  AffiliateCommissionWebhookObject,
  AffiliatePayoutWebhookObject,
  MarketplaceListingWebhookObject,
  OrderWebhookObject,
  SubscriptionWebhookObject,
  TransactionWebhookObject,
  WebhookEventType,
} from '@payunivercart/shared';
import { eq } from 'drizzle-orm';
import type { AppServices } from '../services';
import { emitWebhook } from './outbound-emit';

/**
 * Resource → envelope projectors + thin wrappers around `emitWebhook`.
 *
 * Centralises the mapping from DB row → producer-facing JSON shape so
 * the gateway handler / cycle worker / commission rollover stay free of
 * field-by-field plumbing. Anywhere we want to fire `order.paid`,
 * `subscription.renewed`, etc., we call one of the `emitOrderEvent`,
 * `emitTransactionEvent`, ... helpers below.
 *
 * Best-effort: every call is wrapped in `safeEmit` so a serialisation
 * failure never blocks the upstream side-effect (eg. paying an order).
 * Failures are logged and silently swallowed — webhooks are a
 * convenience layer, not a correctness path.
 */

/** Coerce DB Date / null → ISO string / null with the right type. */
function isoOrNull(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (typeof d === 'string') return d;
  return d.toISOString();
}

/** Best-effort wrapper — swallow + log every emit failure. */
async function safeEmit(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (cause) {
    process.stdout.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'webhook.emit.failed',
        label,
        error: cause instanceof Error ? cause.message : String(cause),
      })}\n`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Orders                                                                     */
/* -------------------------------------------------------------------------- */

export async function projectOrder(
  services: AppServices,
  orderId: string,
): Promise<OrderWebhookObject | null> {
  const [row] = await services.db.db
    .select({
      id: schema.orders.id,
      workspaceId: schema.orders.workspaceId,
      publicReference: schema.orders.publicReference,
      status: schema.orders.status,
      totalCents: schema.orders.totalCents,
      currency: schema.orders.currency,
      customerName: schema.orders.customerName,
      customerEmail: schema.orders.customerEmail,
      customerDocument: schema.orders.customerDocument,
      customerPhoneE164: schema.orders.customerPhoneE164,
      subscriptionId: schema.orders.subscriptionId,
      cycleNumber: schema.orders.cycleNumber,
      paidAt: schema.orders.paidAt,
      cancelledAt: schema.orders.cancelledAt,
      createdAt: schema.orders.createdAt,
    })
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);
  if (!row) return null;

  // Pick the canonical method from the most-recent transaction so the
  // producer sees `pix` vs `credit_card` without an extra round-trip.
  const [tx] = await services.db.db
    .select({ method: schema.transactions.method })
    .from(schema.transactions)
    .where(eq(schema.transactions.orderId, orderId))
    .limit(1);

  return {
    id: row.id,
    workspace_id: row.workspaceId,
    public_reference: row.publicReference,
    status: row.status,
    total_cents: Number(row.totalCents),
    currency: row.currency,
    customer: {
      name: row.customerName,
      email: row.customerEmail,
      document: row.customerDocument,
      phone_e164: row.customerPhoneE164 || null,
    },
    payment_method: tx?.method ?? null,
    subscription_id: row.subscriptionId,
    cycle_number: row.cycleNumber,
    created_at: row.createdAt.toISOString(),
    paid_at: isoOrNull(row.paidAt),
    cancelled_at: isoOrNull(row.cancelledAt),
  };
}

export async function emitOrderEvent(
  services: AppServices,
  orderId: string,
  eventType: WebhookEventType,
  opts: { previousAttributes?: Partial<OrderWebhookObject>; livemode?: boolean } = {},
): Promise<void> {
  await safeEmit(`order:${eventType}:${orderId}`, async () => {
    const object = await projectOrder(services, orderId);
    if (!object) return;
    await emitWebhook(
      { services },
      {
        workspaceId: object.workspace_id,
        eventType,
        object,
        previousAttributes: opts.previousAttributes,
        livemode: opts.livemode ?? true,
      },
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Transactions                                                               */
/* -------------------------------------------------------------------------- */

export async function projectTransaction(
  services: AppServices,
  transactionId: string,
): Promise<TransactionWebhookObject | null> {
  const [row] = await services.db.db
    .select({
      id: schema.transactions.id,
      workspaceId: schema.transactions.workspaceId,
      orderId: schema.transactions.orderId,
      gatewayId: schema.transactions.gatewayId,
      gatewayChargeId: schema.transactions.gatewayChargeId,
      method: schema.transactions.method,
      status: schema.transactions.status,
      amountCents: schema.transactions.amountCents,
      currency: schema.transactions.currency,
      installments: schema.transactions.installments,
      cardBrand: schema.transactions.cardBrand,
      cardLast4: schema.transactions.cardLast4,
      pixCopyPaste: schema.transactions.pixCopyPaste,
      expiresAt: schema.transactions.expiresAt,
      failureCode: schema.transactions.failureCode,
      failureMessage: schema.transactions.failureMessage,
      authorizedAt: schema.transactions.authorizedAt,
      paidAt: schema.transactions.paidAt,
      refundedAt: schema.transactions.refundedAt,
      chargedbackAt: schema.transactions.chargedbackAt,
      createdAt: schema.transactions.createdAt,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, transactionId))
    .limit(1);
  if (!row) return null;

  return {
    id: row.id,
    workspace_id: row.workspaceId,
    order_id: row.orderId,
    gateway_id: row.gatewayId,
    gateway_charge_id: row.gatewayChargeId,
    method: row.method as TransactionWebhookObject['method'],
    status: row.status,
    amount_cents: Number(row.amountCents),
    currency: row.currency,
    installments: row.installments,
    card_brand: row.cardBrand,
    card_last4: row.cardLast4,
    pix_copy_paste: row.pixCopyPaste,
    pix_expires_at: row.method === 'pix' ? isoOrNull(row.expiresAt) : null,
    failure_code: row.failureCode,
    failure_message: row.failureMessage,
    authorized_at: isoOrNull(row.authorizedAt),
    paid_at: isoOrNull(row.paidAt),
    refunded_at: isoOrNull(row.refundedAt),
    chargedback_at: isoOrNull(row.chargedbackAt),
    created_at: row.createdAt.toISOString(),
  };
}

export async function emitTransactionEvent(
  services: AppServices,
  transactionId: string,
  eventType: WebhookEventType,
  opts: { livemode?: boolean } = {},
): Promise<void> {
  await safeEmit(`transaction:${eventType}:${transactionId}`, async () => {
    const object = await projectTransaction(services, transactionId);
    if (!object) return;
    await emitWebhook(
      { services },
      {
        workspaceId: object.workspace_id,
        eventType,
        object,
        livemode: opts.livemode ?? true,
      },
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Subscriptions                                                              */
/* -------------------------------------------------------------------------- */

export async function projectSubscription(
  services: AppServices,
  subscriptionId: string,
): Promise<SubscriptionWebhookObject | null> {
  const [row] = await services.db.db
    .select({
      id: schema.subscriptions.id,
      workspaceId: schema.subscriptions.workspaceId,
      publicReference: schema.subscriptions.publicReference,
      productId: schema.subscriptions.productId,
      planId: schema.subscriptions.planId,
      status: schema.subscriptions.status,
      paymentMethod: schema.subscriptions.paymentMethod,
      currentCycleStatus: schema.subscriptions.currentCycleStatus,
      amountCents: schema.subscriptionPlans.amountCents,
      currency: schema.subscriptionPlans.currency,
      customerName: schema.subscriptions.customerName,
      customerEmail: schema.subscriptions.customerEmail,
      customerDocument: schema.subscriptions.customerDocument,
      customerPhoneE164: schema.subscriptions.customerPhoneE164,
      startedAt: schema.subscriptions.startedAt,
      nextChargeAt: schema.subscriptions.nextChargeAt,
      cancelledAt: schema.subscriptions.cancelledAt,
      createdAt: schema.subscriptions.createdAt,
    })
    .from(schema.subscriptions)
    .innerJoin(
      schema.subscriptionPlans,
      eq(schema.subscriptionPlans.id, schema.subscriptions.planId),
    )
    .where(eq(schema.subscriptions.id, subscriptionId))
    .limit(1);
  if (!row) return null;

  return {
    id: row.id,
    workspace_id: row.workspaceId,
    public_reference: row.publicReference,
    product_id: row.productId,
    plan_id: row.planId,
    status: row.status as SubscriptionWebhookObject['status'],
    payment_method: row.paymentMethod as SubscriptionWebhookObject['payment_method'],
    current_cycle_status:
      row.currentCycleStatus as SubscriptionWebhookObject['current_cycle_status'],
    amount_cents: Number(row.amountCents),
    currency: row.currency,
    customer: {
      name: row.customerName,
      email: row.customerEmail,
      document: row.customerDocument,
      phone_e164: row.customerPhoneE164 || null,
    },
    started_at: isoOrNull(row.startedAt),
    next_charge_at: isoOrNull(row.nextChargeAt),
    cancelled_at: isoOrNull(row.cancelledAt),
    created_at: row.createdAt.toISOString(),
  };
}

export async function emitSubscriptionEvent(
  services: AppServices,
  subscriptionId: string,
  eventType: WebhookEventType,
  opts: { livemode?: boolean } = {},
): Promise<void> {
  await safeEmit(`subscription:${eventType}:${subscriptionId}`, async () => {
    const object = await projectSubscription(services, subscriptionId);
    if (!object) return;
    await emitWebhook(
      { services },
      {
        workspaceId: object.workspace_id,
        eventType,
        object,
        livemode: opts.livemode ?? true,
      },
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Affiliate commissions                                                      */
/* -------------------------------------------------------------------------- */

export async function projectAffiliateCommission(
  services: AppServices,
  commissionId: string,
): Promise<AffiliateCommissionWebhookObject | null> {
  const [row] = await services.db.db
    .select({
      id: schema.affiliateCommissions.id,
      workspaceId: schema.affiliateCommissions.workspaceId,
      affiliateId: schema.affiliateCommissions.affiliateId,
      orderId: schema.affiliateCommissions.orderId,
      status: schema.affiliateCommissions.status,
      commissionAmountCents: schema.affiliateCommissions.commissionAmountCents,
      currency: schema.affiliateCommissions.currency,
      cycleNumber: schema.affiliateCommissions.cycleNumber,
      availableAt: schema.affiliateCommissions.availableAt,
      paidAt: schema.affiliateCommissions.paidAt,
      createdAt: schema.affiliateCommissions.createdAt,
    })
    .from(schema.affiliateCommissions)
    .where(eq(schema.affiliateCommissions.id, commissionId))
    .limit(1);
  if (!row) return null;

  return {
    id: row.id,
    workspace_id: row.workspaceId,
    affiliate_id: row.affiliateId,
    order_id: row.orderId ?? '',
    status: row.status as AffiliateCommissionWebhookObject['status'],
    commission_amount_cents: Number(row.commissionAmountCents),
    currency: row.currency,
    cycle_number: row.cycleNumber,
    available_at: isoOrNull(row.availableAt),
    paid_at: isoOrNull(row.paidAt),
    created_at: row.createdAt.toISOString(),
  };
}

export async function emitAffiliateCommissionEvent(
  services: AppServices,
  commissionId: string,
  eventType: WebhookEventType,
  opts: { livemode?: boolean } = {},
): Promise<void> {
  await safeEmit(`commission:${eventType}:${commissionId}`, async () => {
    const object = await projectAffiliateCommission(services, commissionId);
    if (!object) return;
    await emitWebhook(
      { services },
      {
        workspaceId: object.workspace_id,
        eventType,
        object,
        livemode: opts.livemode ?? true,
      },
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Affiliate payouts                                                          */
/* -------------------------------------------------------------------------- */

export async function projectAffiliatePayout(
  services: AppServices,
  payoutId: string,
): Promise<AffiliatePayoutWebhookObject | null> {
  const [row] = await services.db.db
    .select({
      id: schema.affiliatePayouts.id,
      workspaceId: schema.affiliatePayouts.workspaceId,
      affiliateId: schema.affiliatePayouts.affiliateId,
      totalAmountCents: schema.affiliatePayouts.totalAmountCents,
      currency: schema.affiliatePayouts.currency,
      status: schema.affiliatePayouts.status,
      requestedAt: schema.affiliatePayouts.requestedAt,
      paidAt: schema.affiliatePayouts.paidAt,
      gatewayTransactionId: schema.affiliatePayouts.gatewayTransactionId,
    })
    .from(schema.affiliatePayouts)
    .where(eq(schema.affiliatePayouts.id, payoutId))
    .limit(1);
  if (!row) return null;

  return {
    id: row.id,
    workspace_id: row.workspaceId,
    affiliate_id: row.affiliateId,
    total_amount_cents: Number(row.totalAmountCents),
    currency: row.currency,
    status: row.status as AffiliatePayoutWebhookObject['status'],
    requested_at:
      row.requestedAt instanceof Date ? row.requestedAt.toISOString() : String(row.requestedAt),
    paid_at: isoOrNull(row.paidAt),
    gateway_transaction_id: row.gatewayTransactionId,
  };
}

export async function emitAffiliatePayoutEvent(
  services: AppServices,
  payoutId: string,
  eventType: WebhookEventType,
  opts: { livemode?: boolean } = {},
): Promise<void> {
  await safeEmit(`payout:${eventType}:${payoutId}`, async () => {
    const object = await projectAffiliatePayout(services, payoutId);
    if (!object) return;
    await emitWebhook(
      { services },
      {
        workspaceId: object.workspace_id,
        eventType,
        object,
        livemode: opts.livemode ?? true,
      },
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Marketplace listings                                                       */
/* -------------------------------------------------------------------------- */

export async function projectMarketplaceListing(
  services: AppServices,
  listingId: string,
): Promise<MarketplaceListingWebhookObject | null> {
  const [row] = await services.db.db
    .select({
      id: schema.marketplaceListings.id,
      workspaceId: schema.marketplaceListings.workspaceId,
      productId: schema.marketplaceListings.productId,
      productSlug: schema.products.slug,
      category: schema.marketplaceListings.category,
      headline: schema.marketplaceListings.headline,
      pitch: schema.marketplaceListings.pitch,
      status: schema.marketplaceListings.status,
      publishedAt: schema.marketplaceListings.publishedAt,
    })
    .from(schema.marketplaceListings)
    .innerJoin(schema.products, eq(schema.products.id, schema.marketplaceListings.productId))
    .where(eq(schema.marketplaceListings.id, listingId))
    .limit(1);
  if (!row) return null;

  return {
    id: row.id,
    workspace_id: row.workspaceId,
    product_id: row.productId,
    product_slug: row.productSlug,
    category: row.category,
    headline: row.headline,
    pitch: row.pitch,
    status: row.status,
    published_at: isoOrNull(row.publishedAt),
  };
}

export async function emitMarketplaceListingEvent(
  services: AppServices,
  listingId: string,
  eventType: WebhookEventType,
  opts: { livemode?: boolean } = {},
): Promise<void> {
  await safeEmit(`listing:${eventType}:${listingId}`, async () => {
    const object = await projectMarketplaceListing(services, listingId);
    if (!object) return;
    await emitWebhook(
      { services },
      {
        workspaceId: object.workspace_id,
        eventType,
        object,
        livemode: opts.livemode ?? true,
      },
    );
  });
}
