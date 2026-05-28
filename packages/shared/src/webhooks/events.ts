import { z } from 'zod';

/**
 * Univercart webhook event registry.
 *
 * Single source of truth for every event type the platform emits to
 * producers' registered endpoints. New events MUST land here first;
 * the worker dispatcher rejects unknown types so a typo at the call
 * site never ships an event into the wild.
 *
 * Naming convention: `<resource>.<verb_past_or_state>`. Use snake_case
 * INSIDE the verb portion (`order.pending_payment`) but never inside
 * the resource — that lets producers grep `^order\.` to subscribe to
 * everything order-related.
 *
 * API version pinned per release. The envelope embeds `api_version`
 * so a producer can branch on schema migrations without breaking on
 * the deploy that changes them.
 */

export const WEBHOOK_API_VERSION = '2026-05-28';

export const WEBHOOK_EVENT_TYPES = [
  // Orders — one-time purchases lifecycle.
  'order.created',
  'order.pending_payment',
  'order.paid',
  'order.cancelled',
  'order.expired',
  'order.refunded',
  'order.partially_refunded',
  'order.chargedback',

  // Transactions — payment-level state machine (gateway-side).
  'transaction.authorized',
  'transaction.captured',
  'transaction.failed',
  'transaction.refunded',
  'transaction.chargeback',

  // Subscriptions — recurring billing lifecycle.
  'subscription.created',
  'subscription.activated',
  'subscription.renewed',
  'subscription.payment_failed',
  'subscription.pending_pix',
  'subscription.overdue',
  'subscription.grace_expired',
  'subscription.cancelled',
  'subscription.reactivated',

  // Affiliates — commission + payout lifecycle.
  'affiliate.commission.created',
  'affiliate.commission.available',
  'affiliate.commission.reversed',
  'affiliate.payout.requested',
  'affiliate.payout.paid',

  // Marketplace — discovery surface.
  'marketplace.listing.published',
  'marketplace.click.recorded',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WebhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

/**
 * Envelope sent on every webhook POST. The `data.object` field carries
 * the resource snapshot — its shape depends on the event type, validated
 * separately by the call site that emits the event.
 *
 * Modeled on Stripe's event envelope so producers who integrated with
 * Stripe in the past have a near-zero learning curve.
 */
export interface WebhookEventEnvelope<TObject = unknown> {
  /** Stable delivery identifier — UUID. Functions as the producer's
   *  idempotency key (`Idempotency-Key` header mirrors this value). */
  id: string;
  /** Always `'event'` to stay compatible with Stripe-style clients
   *  that branch on `object === 'event'`. */
  object: 'event';
  /** API version pinned at emit time. */
  api_version: typeof WEBHOOK_API_VERSION;
  /** Unix seconds when the event was created server-side. */
  created: number;
  /** Event type — see `WEBHOOK_EVENT_TYPES`. */
  type: WebhookEventType;
  /** Workspace that owns the resource. Producers receiving the webhook
   *  ALREADY know their workspace, but echoing it is useful for
   *  consumers that route by tenant on the receiving side. */
  workspace_id: string;
  /** Sandbox vs production. False during test events + sandbox
   *  gateways; producers branch on this to skip live side effects. */
  livemode: boolean;
  /** Resource snapshot. */
  data: {
    object: TObject;
    /** Previous values for `*.updated` events, mirrors Stripe's
     *  `previous_attributes`. Null for pure-create events. */
    previous_attributes?: Partial<TObject>;
  };
}

export const WebhookEventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  object: z.literal('event'),
  api_version: z.literal(WEBHOOK_API_VERSION),
  created: z.number().int().positive(),
  type: WebhookEventTypeSchema,
  workspace_id: z.string().uuid(),
  livemode: z.boolean(),
  data: z.object({
    object: z.unknown(),
    previous_attributes: z.unknown().optional(),
  }),
});

/**
 * Resource shapes — minimum stable surface promised to producers. The
 * dispatcher serialises orders/subs/etc into these projections before
 * emitting, never the raw DB rows (which include internal columns).
 *
 * Adding a field here is a non-breaking change.
 * Removing/renaming a field is a breaking change — bump
 * `WEBHOOK_API_VERSION` and document migration in CHANGELOG.
 */

export interface OrderWebhookObject {
  id: string;
  workspace_id: string;
  public_reference: string;
  status: string;
  total_cents: number;
  currency: 'BRL' | 'USD' | 'EUR';
  customer: {
    name: string;
    email: string;
    document: string;
    phone_e164: string | null;
  };
  payment_method: string | null;
  subscription_id: string | null;
  cycle_number: number | null;
  created_at: string;
  paid_at: string | null;
  cancelled_at: string | null;
}

export interface TransactionWebhookObject {
  id: string;
  workspace_id: string;
  order_id: string;
  gateway_id: string;
  gateway_charge_id: string | null;
  method: 'pix' | 'credit_card' | 'boleto' | 'stripe_card_usd';
  status: string;
  amount_cents: number;
  currency: 'BRL' | 'USD' | 'EUR';
  installments: number | null;
  card_brand: string | null;
  card_last4: string | null;
  pix_copy_paste: string | null;
  pix_expires_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  authorized_at: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  chargedback_at: string | null;
  created_at: string;
}

export interface SubscriptionWebhookObject {
  id: string;
  workspace_id: string;
  public_reference: string;
  product_id: string;
  plan_id: string;
  status: 'pending' | 'active' | 'paused' | 'cancelled' | 'expired';
  payment_method: 'card' | 'pix' | 'both';
  current_cycle_status: 'paid' | 'pending_pix' | 'overdue' | 'cancelled_by_grace';
  amount_cents: number;
  currency: 'BRL' | 'USD' | 'EUR';
  customer: {
    name: string;
    email: string;
    document: string;
    phone_e164: string | null;
  };
  started_at: string | null;
  next_charge_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

export interface AffiliateCommissionWebhookObject {
  id: string;
  workspace_id: string;
  affiliate_id: string;
  order_id: string;
  status: 'pending' | 'available' | 'paid' | 'reversed' | 'cancelled';
  commission_amount_cents: number;
  currency: 'BRL' | 'USD' | 'EUR';
  cycle_number: number | null;
  available_at: string | null;
  paid_at: string | null;
  created_at: string;
}

export interface AffiliatePayoutWebhookObject {
  id: string;
  workspace_id: string;
  affiliate_id: string;
  total_amount_cents: number;
  currency: 'BRL' | 'USD' | 'EUR';
  status: 'requested' | 'reviewing' | 'approved' | 'processing' | 'paid' | 'rejected' | 'cancelled';
  requested_at: string;
  paid_at: string | null;
  gateway_transaction_id: string | null;
}

export interface MarketplaceListingWebhookObject {
  id: string;
  workspace_id: string;
  product_id: string;
  product_slug: string;
  category: string;
  headline: string;
  pitch: string;
  status: string;
  published_at: string | null;
}

/**
 * `is*` narrowers — make consumers' switch statements clean.
 */
export const ORDER_EVENT_TYPES: readonly WebhookEventType[] = WEBHOOK_EVENT_TYPES.filter(
  (t): t is WebhookEventType => t.startsWith('order.'),
);

export const TRANSACTION_EVENT_TYPES: readonly WebhookEventType[] = WEBHOOK_EVENT_TYPES.filter(
  (t): t is WebhookEventType => t.startsWith('transaction.'),
);

export const SUBSCRIPTION_EVENT_TYPES: readonly WebhookEventType[] = WEBHOOK_EVENT_TYPES.filter(
  (t): t is WebhookEventType => t.startsWith('subscription.'),
);

export const AFFILIATE_EVENT_TYPES: readonly WebhookEventType[] = WEBHOOK_EVENT_TYPES.filter(
  (t): t is WebhookEventType => t.startsWith('affiliate.'),
);

export const MARKETPLACE_EVENT_TYPES: readonly WebhookEventType[] = WEBHOOK_EVENT_TYPES.filter(
  (t): t is WebhookEventType => t.startsWith('marketplace.'),
);
