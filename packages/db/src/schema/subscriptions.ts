import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  currencyEnum,
  fk,
  gatewayIdEnum,
  id,
  timestampTzNullable,
  updatedAt,
} from './common';
import { partnerAccounts } from './partners';
import { products } from './products';
import { workspaces } from './workspaces';

/**
 * Payment method allowed for a subscription. `card` = MP preapproval
 * (auto-debit), `pix` = manual cycle (new PIX per renewal, worker
 * generates + dispatches via WhatsApp/email), `both` = buyer chooses
 * at checkout time.
 */
export const subscriptionPaymentMethodEnum = pgEnum('subscription_payment_method', [
  'card',
  'pix',
  'both',
]);

/**
 * Cycle state for PIX subscriptions. Cards use `subscriptions.status`
 * directly (active/past_due/cancelled). PIX needs an extra axis because
 * the producer's grace period sits between "buyer didn't pay yet" and
 * "we gave up + cancelled".
 *   - `paid`               current cycle settled, nextChargeAt is the
 *                          due date for the next cycle.
 *   - `pending_pix`        worker generated a fresh PIX for the cycle;
 *                          buyer hasn't paid yet.
 *   - `overdue`            past due date + still unpaid + inside grace.
 *   - `cancelled_by_grace` grace window expired without payment; sub
 *                          flipped to cancelled + entitlement revoked.
 */
export const subscriptionCycleStatusEnum = pgEnum('subscription_cycle_status', [
  'paid',
  'pending_pix',
  'overdue',
  'cancelled_by_grace',
]);

/**
 * Subscription plans — producer-defined recurring offers attached to
 * a product. One product can have many plans (e.g. "Mensal" vs "Anual")
 * so the buyer picks at checkout time. We mirror the gateway's plan
 * primitives where possible: `mpPreapprovalPlanId` is lazily populated
 * the first time we POST to MP's /preapproval_plan so subsequent
 * subscribers reuse the same template.
 *
 * Pricing model: each plan has its own `amountCents` and
 * `billingPeriod` (monthly | yearly). Yearly plans typically carry
 * a discount the producer encodes manually in `amountCents` — we
 * surface that discount on the buyer's plan picker as "economize X%".
 */
export const subscriptionPlans = pgTable(
  'subscription_plans',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /**
     * Billing cadence. `monthly` = MP `frequency=1 frequency_type=months`,
     * `yearly` = `frequency=12 frequency_type=months` (MP doesn't have
     * a native "years" type; we collapse to 12 months at the API
     * boundary).
     */
    billingPeriod: text().notNull().default('monthly'),
    amountCents: bigint({ mode: 'bigint' }).notNull(),
    currency: currencyEnum().notNull().default('BRL'),
    /**
     * MP `preapproval_plan` id minted on first POST. We cache it so
     * every subscriber for the same plan reuses the same template —
     * keeps the producer's MP dashboard clean.
     */
    mpPreapprovalPlanId: text(),
    /** Free trial in days. 0 = no trial. */
    trialDays: integer().notNull().default(0),
    /** Producer can soft-deactivate without deleting — open subscribers
     *  on this plan stay active, but new buyers can't pick it. */
    isActive: boolean().notNull().default(true),
    /** Render order on the public plan picker. Smaller = first. */
    sortOrder: integer().notNull().default(0),
    /**
     * Payment method this plan supports. Card-only is the default
     * (preserves Hotmart-style auto-renew). PIX needs a worker to
     * generate a fresh charge each cycle. `both` lets the buyer
     * choose at checkout time.
     */
    paymentMethod: subscriptionPaymentMethodEnum().notNull().default('card'),
    /** Optional flag rendered as "Mais escolhido" badge on the picker. */
    isHighlighted: boolean().notNull().default(false),
    /**
     * Univercart Connect — partner SaaS this plan provisions access
     * to. Null on plans that don't gate any external app (the producer
     * delivers value some other way, e.g. course platform link). When
     * set, every successful subscription cycle dispatches entitlement
     * events to the partner's webhook with `partnerRoleSlug` as the
     * `role` field.
     */
    partnerAccountId: fk().references(() => partnerAccounts.id, { onDelete: 'set null' }),
    /**
     * Slug from `partner_roles.slug` — the partner's own taxonomy
     * (e.g. `entry`, `medium`, `ultra`). Plain text instead of FK
     * because partner role definitions can change without invalidating
     * historical plans; we only care that the value matches what the
     * partner expects today.
     */
    partnerRoleSlug: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('subscription_plans_workspace_idx').on(table.workspaceId),
    index('subscription_plans_product_idx').on(table.productId),
    index('subscription_plans_partner_idx').on(table.partnerAccountId),
  ],
);

/**
 * Subscriptions — one row per buyer × plan. The gateway holds the
 * recurring engine (MP `/preapproval`), we keep a local mirror so
 * the producer can list / cancel / inspect without round-tripping the
 * gateway every time. `nextChargeAt` + `lastChargedAt` are advanced
 * by the webhook that listens to `subscription_authorized_payment`
 * events from MP.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    planId: fk()
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: 'restrict' }),
    publicReference: text().notNull(),
    customerName: text().notNull(),
    customerEmail: text().notNull(),
    customerDocument: text().notNull(),
    customerPhoneRaw: text().notNull(),
    customerPhoneE164: text().notNull(),
    customerWahaChatId: text(),
    gatewayId: gatewayIdEnum().notNull(),
    /** MP `preapproval.id` — the recurring engine handle. */
    gatewaySubscriptionId: text().notNull(),
    status: text().notNull().default('pending'),
    /** Cycle date driven by the gateway's recurring engine. */
    nextChargeAt: timestampTzNullable(),
    lastChargedAt: timestampTzNullable(),
    startedAt: timestampTzNullable(),
    cancelledAt: timestampTzNullable(),
    cancelReason: text(),
    /** Bound to the gateway credential row that authorised the
     *  recurring engine. Stays referentially independent so the
     *  producer can rotate credentials without orphaning the row. */
    gatewayCredentialId: fk(),
    /**
     * Effective payment method for this row (denormalised from plan
     * because `both` plans collapse to a single method once the buyer
     * picks at checkout time). Card subs ignore the cycle/grace
     * fields below.
     */
    paymentMethod: subscriptionPaymentMethodEnum().notNull().default('card'),
    /** Set when payment_method=pix: id of the transactions row that
     *  holds the active PIX qr/copy-paste for the current cycle. */
    pixCurrentChargeId: fk(),
    /** Days the producer tolerates an unpaid PIX cycle before we flip
     *  the subscription to cancelled + revoke entitlement. 3 is the
     *  empirical sweet spot for BR — long enough for the buyer to
     *  notice the WhatsApp reminder, short enough that the producer
     *  doesn't carry month-long delinquency. */
    gracePeriodDays: integer().notNull().default(3),
    /** PIX-only cycle state (see enum docblock). Card subs stay 'paid'. */
    currentCycleStatus: subscriptionCycleStatusEnum().notNull().default('paid'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('subscriptions_gateway_unique').on(table.gatewayId, table.gatewaySubscriptionId),
    index('subscriptions_workspace_idx').on(table.workspaceId),
    index('subscriptions_product_idx').on(table.productId),
    index('subscriptions_plan_idx').on(table.planId),
    index('subscriptions_status_next_idx').on(table.status, table.nextChargeAt),
    // Hot path for the pix-subscription-cycle sweeper.
    index('subscriptions_pix_cycle_idx').on(
      table.paymentMethod,
      table.currentCycleStatus,
      table.nextChargeAt,
    ),
  ],
);
