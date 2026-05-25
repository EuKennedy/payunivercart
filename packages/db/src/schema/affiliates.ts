import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import {
  createdAt,
  currencyEnum,
  deletedAt,
  fk,
  id,
  timestampTzNullable,
  updatedAt,
} from './common';
import { orders } from './orders';
import { products } from './products';
import { subscriptions } from './subscriptions';
import { workspaces } from './workspaces';

/**
 * Affiliate system — Hotmart / Kiwify-tier multi-tenant.
 *
 * Domain split:
 *   - `affiliate_programs`     producer-side rule: which products are
 *                              open for affiliation, commission shape.
 *   - `affiliates`             person/account that joined the platform
 *                              as an affiliate (one per user across the
 *                              whole platform — affiliating to multiple
 *                              workspaces happens via memberships).
 *   - `affiliate_memberships`  affiliate ↔ program (status machine).
 *   - `affiliate_links`        unique tracking slug per affiliate +
 *                              optional product target.
 *   - `affiliate_clicks`       hit-level events — fed by the /a/:slug
 *                              public redirect, dedupe on (ip_hash,
 *                              fingerprint, link_id, day).
 *   - `affiliate_attributions` resolved click → sale / subscription
 *                              within the attribution window.
 *   - `affiliate_commissions`  computed commission row per attribution
 *                              (one-time, recurring, or lifetime).
 *   - `affiliate_payouts`      withdrawal workflow (requested → paid).
 *   - `affiliate_invitations`  email-based invites (pending acceptance).
 *   - `affiliate_fraud_signals`detected fraud cues (ip velocity, self
 *                              attribution, blacklist). Drives manual
 *                              review queue.
 *   - `affiliate_audit_log`    immutable trace of every status change
 *                              for compliance + customer support.
 *
 * Multi-tenant guarantee: every row keyed by `workspace_id` (producer
 * owns the program) PLUS `affiliate_id` (cross-workspace identity).
 * RLS policies in `packages/db/sql/02_rls_policies.sql` filter every
 * tenant query by `workspace_id`. Cross-tenant joins (e.g. "show me
 * every program I'm affiliated to") go through `affiliate_memberships`
 * which is the only table indexed by `affiliate_id` first.
 */

// ─── Enums ──────────────────────────────────────────────────────────────────

/** Stage in the affiliate's lifecycle within a single workspace. */
export const affiliateMembershipStatusEnum = pgEnum('affiliate_membership_status', [
  'pending', // applied / invited, waiting for producer review
  'approved', // active — links work, commissions accrue
  'rejected', // producer said no; affiliate can re-apply if invited
  'suspended', // approved then paused (fraud / policy violation)
  'left', // affiliate voluntarily quit
]);

/**
 * Approval policy on a program.
 *   - `automatic`   anyone who clicks "afiliar" is immediately approved.
 *   - `manual`      every application sits in a producer queue.
 *   - `invite_only` no public application; producer issues invites by email.
 */
export const affiliateApprovalPolicyEnum = pgEnum('affiliate_approval_policy', [
  'automatic',
  'manual',
  'invite_only',
]);

/**
 * Commission compute strategy.
 *   - `percent`    a % of the order total.
 *   - `flat`       a fixed amount in cents.
 *   - `recurring`  % applied to every renewal of a subscription, capped
 *                  by `recurring_cycle_limit`.
 *   - `lifetime`   % applied to every renewal, forever. Producer
 *                  warned heavily before flipping this on.
 */
export const affiliateCommissionTypeEnum = pgEnum('affiliate_commission_type', [
  'percent',
  'flat',
  'recurring',
  'lifetime',
]);

/** Commission row state — drives payout eligibility. */
export const affiliateCommissionStatusEnum = pgEnum('affiliate_commission_status', [
  'pending', // attributed but inside the refund window
  'available', // refund window passed, payout-eligible
  'paid', // included in a paid payout row
  'reversed', // chargeback / refund landed → commission clawed back
  'void', // fraud verdict / producer cancellation
]);

/** Payout request workflow. */
export const affiliatePayoutStatusEnum = pgEnum('affiliate_payout_status', [
  'requested', // affiliate clicked "withdraw"
  'reviewing', // producer/operator validating
  'approved', // ready to dispatch
  'processing', // payment provider executing
  'paid', // money landed
  'failed', // dispatch failed; retryable
  'cancelled', // producer rejected
]);

/** Severity tier for a fraud signal — drives auto-suspend thresholds. */
export const affiliateFraudSeverityEnum = pgEnum('affiliate_fraud_severity', [
  'info', // worth noting (e.g. ip velocity slightly above mean)
  'warn', // probable abuse (self-attribution by IP overlap)
  'critical', // confirmed fraud (chargeback ring, stolen card pattern)
]);

// ─── Tables ─────────────────────────────────────────────────────────────────

/**
 * Cross-workspace identity. One affiliate row per platform user; the
 * actual relationship to a producer is in `affiliate_memberships`.
 *
 * `publicCode` is the buyer-facing short identifier (`?ref=ABC123`) when
 * the producer prefers a single canonical code over per-product links.
 */
export const affiliates = pgTable(
  'affiliates',
  {
    id: id(),
    /** Better-Auth user that owns this affiliate identity. */
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Display name (defaults to user.name; editable). */
    displayName: text().notNull(),
    /** Public short code for `?ref=ABC123` URLs. 6-12 chars [A-Z0-9]. */
    publicCode: text().notNull(),
    /**
     * Payout configuration encrypted at rest. Bank account / pix key /
     * paypal id depending on method. NULL until the affiliate fills in
     * "Como vou receber".
     */
    payoutMethodEncrypted: text(),
    payoutMethodType: text(), // 'pix' | 'bank' | 'paypal' | etc
    /** Total earned across every workspace, in cents. Materialised by
     *  worker on each commission status flip. Optimisation only. */
    lifetimeEarnedCents: bigint({ mode: 'bigint' }).notNull().default(sql`0`),
    /** Total paid out (sum of paid payouts). */
    lifetimePaidCents: bigint({ mode: 'bigint' }).notNull().default(sql`0`),
    metadata: jsonb().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('affiliates_user_unique').on(table.userId),
    uniqueIndex('affiliates_public_code_unique').on(table.publicCode),
    index('affiliates_lifetime_earned_idx').on(table.lifetimeEarnedCents),
  ],
);

/**
 * Affiliate program — producer-defined rule for affiliating to a
 * product (or to the whole workspace catalogue when `product_id` is
 * null, which means "any product, default commission").
 *
 * Marketplace later filters by `is_public` + `approval_policy` to
 * surface programs open for application.
 */
export const affiliatePrograms = pgTable(
  'affiliate_programs',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Null = workspace-wide default. Set = product-specific override. */
    productId: fk().references(() => products.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text(),
    approvalPolicy: affiliateApprovalPolicyEnum().notNull().default('manual'),
    /** Whether the program is discoverable in the public marketplace. */
    isPublic: jsonb().notNull().default(false),
    /** Commission shape — see enum for semantics. */
    commissionType: affiliateCommissionTypeEnum().notNull(),
    /** Used when type = `percent` / `recurring` / `lifetime`. 0-100. */
    commissionPercent: integer(),
    /** Used when type = `flat`. Cents. */
    commissionFlatCents: bigint({ mode: 'bigint' }),
    /** For `recurring`: cap how many cycles the affiliate earns on. */
    recurringCycleLimit: integer(),
    /** Refund window (days) — commissions stay `pending` until this
     *  passes since the order/charge `paid_at`. Default 30 = the
     *  Brazilian e-commerce "lei do arrependimento" maximum. */
    refundWindowDays: integer().notNull().default(30),
    /** Cookie attribution window. Defaults to 60 days (Hotmart-style). */
    attributionWindowDays: integer().notNull().default(60),
    /** Whether affiliates can promote on paid ads. False = brand control. */
    allowPaidTraffic: jsonb().notNull().default(true),
    /** Optional: forbidden URL keywords ('cupom desconto', '-desconto') */
    forbiddenKeywords: jsonb().notNull().default([]),
    metadata: jsonb().notNull().default({}),
    isActive: jsonb().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    index('affiliate_programs_workspace_idx').on(table.workspaceId),
    index('affiliate_programs_product_idx').on(table.productId),
    // Workspace-default program (productId null) is unique per workspace.
    uniqueIndex('affiliate_programs_workspace_default_unique')
      .on(table.workspaceId)
      .where(sql`${table.productId} IS NULL`),
  ],
);

/**
 * Relationship table: affiliate ↔ program (workspace-scoped).
 * The status machine is intentionally explicit — no implicit "active"
 * derived from "approved + not suspended"; we want the audit log to
 * have an unambiguous current state at all times.
 */
export const affiliateMemberships = pgTable(
  'affiliate_memberships',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    programId: fk()
      .notNull()
      .references(() => affiliatePrograms.id, { onDelete: 'cascade' }),
    affiliateId: fk()
      .notNull()
      .references(() => affiliates.id, { onDelete: 'cascade' }),
    status: affiliateMembershipStatusEnum().notNull().default('pending'),
    /** Producer-facing free-form note attached during approval / rejection. */
    producerNote: text(),
    appliedAt: timestampTzNullable(),
    decidedAt: timestampTzNullable(),
    decidedByUserId: fk().references(() => users.id, { onDelete: 'set null' }),
    suspendedAt: timestampTzNullable(),
    suspendedReason: text(),
    leftAt: timestampTzNullable(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('affiliate_memberships_program_affiliate_unique').on(
      table.programId,
      table.affiliateId,
    ),
    index('affiliate_memberships_workspace_idx').on(table.workspaceId),
    index('affiliate_memberships_affiliate_idx').on(table.affiliateId),
    index('affiliate_memberships_status_idx').on(table.workspaceId, table.status),
  ],
);

/**
 * Tracking link. The buyer-facing URL is `pay.univercart.com/a/:slug`.
 * Slug is unique platform-wide so a click never resolves to two
 * different programs.
 */
export const affiliateLinks = pgTable(
  'affiliate_links',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    programId: fk()
      .notNull()
      .references(() => affiliatePrograms.id, { onDelete: 'cascade' }),
    affiliateId: fk()
      .notNull()
      .references(() => affiliates.id, { onDelete: 'cascade' }),
    /** Optional product override (when program is workspace-wide and
     *  the affiliate wants a product-targeted link). */
    productId: fk().references(() => products.id, { onDelete: 'set null' }),
    slug: text().notNull(),
    /** Producer-defined label (e.g. "Instagram bio"). */
    label: text(),
    /** UTM-style metadata baked into the link. */
    utmSource: text(),
    utmMedium: text(),
    utmCampaign: text(),
    /** Materialised counters refreshed by worker — cheaper than COUNT(*)
     *  on the click table for dashboard. */
    clickCount: bigint({ mode: 'bigint' }).notNull().default(sql`0`),
    attributionCount: bigint({ mode: 'bigint' }).notNull().default(sql`0`),
    expiresAt: timestampTzNullable(),
    isActive: jsonb().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('affiliate_links_slug_unique').on(table.slug),
    index('affiliate_links_program_idx').on(table.programId),
    index('affiliate_links_affiliate_idx').on(table.affiliateId),
    index('affiliate_links_workspace_idx').on(table.workspaceId),
  ],
);

/**
 * Click event — written by the /a/:slug public redirect. Heavy table;
 * partitioned by month in a future migration when row count justifies.
 *
 * `ip_hash` is HMAC-SHA-256(`ip`, `affiliate_fraud_secret`) so we can
 * compare velocity / self-click without storing PII. `fingerprint` is a
 * lightweight browser fingerprint (UA + accept-language + screen size,
 * hashed) used as the secondary dedupe key for cookieless clients.
 */
export const affiliateClicks = pgTable(
  'affiliate_clicks',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    linkId: fk()
      .notNull()
      .references(() => affiliateLinks.id, { onDelete: 'cascade' }),
    affiliateId: fk()
      .notNull()
      .references(() => affiliates.id, { onDelete: 'cascade' }),
    productId: fk().references(() => products.id, { onDelete: 'set null' }),
    ipHash: text().notNull(),
    fingerprint: text(),
    userAgent: text(),
    referrer: text(),
    /** ISO 3166-1 alpha-2 from Cloudflare / IP geo. NULL when unknown. */
    country: text(),
    /** Bucketed for cheap aggregation, day in workspace tz. */
    occurredAt: createdAt(),
  },
  (table) => [
    index('affiliate_clicks_workspace_idx').on(table.workspaceId, table.occurredAt),
    index('affiliate_clicks_link_idx').on(table.linkId, table.occurredAt),
    index('affiliate_clicks_affiliate_idx').on(table.affiliateId, table.occurredAt),
    index('affiliate_clicks_ip_hash_idx').on(table.ipHash, table.occurredAt),
  ],
);

/**
 * Sale ↔ click attribution. Resolved at checkout time: when an order
 * or subscription is created we search `affiliate_clicks` for the most
 * recent matching click within the program's `attribution_window_days`
 * and write a row here. The order/subscription row gets back-pointer
 * `affiliate_attribution_id`.
 */
export const affiliateAttributions = pgTable(
  'affiliate_attributions',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    programId: fk()
      .notNull()
      .references(() => affiliatePrograms.id, { onDelete: 'cascade' }),
    affiliateId: fk()
      .notNull()
      .references(() => affiliates.id, { onDelete: 'cascade' }),
    linkId: fk().references(() => affiliateLinks.id, { onDelete: 'set null' }),
    clickId: fk().references(() => affiliateClicks.id, { onDelete: 'set null' }),
    orderId: fk().references(() => orders.id, { onDelete: 'cascade' }),
    subscriptionId: fk().references(() => subscriptions.id, { onDelete: 'cascade' }),
    /** Window between click and sale, persisted to make audit easier. */
    attributedSeconds: integer().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('affiliate_attributions_workspace_idx').on(table.workspaceId, table.createdAt),
    index('affiliate_attributions_affiliate_idx').on(table.affiliateId, table.createdAt),
    // One sale = at most one attribution. Partial unique because
    // either orderId OR subscriptionId is populated, never both.
    uniqueIndex('affiliate_attributions_order_unique')
      .on(table.orderId)
      .where(sql`${table.orderId} IS NOT NULL`),
    uniqueIndex('affiliate_attributions_subscription_unique')
      .on(table.subscriptionId)
      .where(sql`${table.subscriptionId} IS NOT NULL`),
  ],
);

/**
 * Computed commission per attribution. One attribution can spawn
 * multiple commission rows when the program is `recurring` or
 * `lifetime` — each subscription renewal materialises a new row.
 *
 * `available_at` is `paid_at + refund_window_days` and drives the
 * payout-eligibility query.
 */
export const affiliateCommissions = pgTable(
  'affiliate_commissions',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    attributionId: fk()
      .notNull()
      .references(() => affiliateAttributions.id, { onDelete: 'cascade' }),
    affiliateId: fk()
      .notNull()
      .references(() => affiliates.id, { onDelete: 'cascade' }),
    programId: fk()
      .notNull()
      .references(() => affiliatePrograms.id, { onDelete: 'cascade' }),
    /** Source charge — orderId for one-time, orderId-per-cycle for sub. */
    orderId: fk().references(() => orders.id, { onDelete: 'set null' }),
    /** Set when commission tracks a subscription renewal. */
    subscriptionId: fk().references(() => subscriptions.id, { onDelete: 'set null' }),
    cycleNumber: integer(),
    grossAmountCents: bigint({ mode: 'bigint' }).notNull(),
    commissionAmountCents: bigint({ mode: 'bigint' }).notNull(),
    currency: currencyEnum().notNull().default('BRL'),
    status: affiliateCommissionStatusEnum().notNull().default('pending'),
    /** Refund window resolution. Worker flips status to `available` here. */
    availableAt: timestampTzNullable(),
    paidAt: timestampTzNullable(),
    /** When status = `reversed`, links back to the refund/chargeback. */
    reversalReason: text(),
    /** Set when this row is included in a paid payout. */
    payoutId: fk(),
    metadata: jsonb().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('affiliate_commissions_workspace_idx').on(table.workspaceId, table.status),
    index('affiliate_commissions_affiliate_status_idx').on(
      table.affiliateId,
      table.status,
      table.availableAt,
    ),
    index('affiliate_commissions_payout_idx').on(table.payoutId),
    // (attribution, cycle) is unique — recurring program produces one
    // row per cycle, attribution can't double-bill the same cycle.
    uniqueIndex('affiliate_commissions_attribution_cycle_unique').on(
      table.attributionId,
      table.cycleNumber,
    ),
  ],
);

/**
 * Payout — an affiliate requests their available commissions; producer
 * (or auto-policy worker) approves and dispatches.
 *
 * `included_commission_ids` is the materialised set of commission ids
 * folded into this payout, kept in jsonb so a reconciliation report
 * never needs a JOIN.
 */
export const affiliatePayouts = pgTable(
  'affiliate_payouts',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    affiliateId: fk()
      .notNull()
      .references(() => affiliates.id, { onDelete: 'cascade' }),
    status: affiliatePayoutStatusEnum().notNull().default('requested'),
    totalAmountCents: bigint({ mode: 'bigint' }).notNull(),
    currency: currencyEnum().notNull().default('BRL'),
    /** Snapshot of the payout method at request time (encrypted). */
    payoutMethodSnapshotEncrypted: text(),
    payoutMethodType: text(),
    includedCommissionIds: jsonb().notNull().default([]),
    requestedAt: createdAt(),
    reviewedAt: timestampTzNullable(),
    reviewedByUserId: fk().references(() => users.id, { onDelete: 'set null' }),
    paidAt: timestampTzNullable(),
    /** Provider transaction id (Pix end-to-end id, bank wire ref, etc). */
    gatewayTransactionId: text(),
    failureReason: text(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('affiliate_payouts_workspace_idx').on(table.workspaceId, table.status),
    index('affiliate_payouts_affiliate_idx').on(table.affiliateId, table.requestedAt),
  ],
);

/**
 * Invitation — producer emails an external person to join a program.
 * When accepted, materialises a `affiliate_memberships` row in
 * approved state and we create an `affiliates` row if the user signs up.
 */
export const affiliateInvitations = pgTable(
  'affiliate_invitations',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    programId: fk()
      .notNull()
      .references(() => affiliatePrograms.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    /** Single-use token for the email's accept link. */
    tokenHash: text().notNull(),
    invitedByUserId: fk().references(() => users.id, { onDelete: 'set null' }),
    /** Note shown on the accept page. */
    message: text(),
    expiresAt: timestampTzNullable(),
    acceptedAt: timestampTzNullable(),
    revokedAt: timestampTzNullable(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('affiliate_invitations_token_unique').on(table.tokenHash),
    index('affiliate_invitations_program_email_idx').on(table.programId, table.email),
    index('affiliate_invitations_workspace_idx').on(table.workspaceId),
  ],
);

/**
 * Fraud signal — append-only ledger of automated + manual detections.
 * Worker job aggregates signals to decide auto-suspend of an affiliate
 * (`severity = critical` triggers immediately; multiple `warn` within
 * 7 days triggers).
 */
export const affiliateFraudSignals = pgTable(
  'affiliate_fraud_signals',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    affiliateId: fk()
      .notNull()
      .references(() => affiliates.id, { onDelete: 'cascade' }),
    /** Optional ties to specific events. */
    clickId: fk().references(() => affiliateClicks.id, { onDelete: 'set null' }),
    attributionId: fk().references(() => affiliateAttributions.id, { onDelete: 'set null' }),
    /** Machine-friendly cue id, e.g. 'ip_self_click', 'velocity_high'. */
    signalType: text().notNull(),
    severity: affiliateFraudSeverityEnum().notNull().default('info'),
    /** Free-form payload (rule-specific data, e.g. ip count). */
    payload: jsonb().notNull().default({}),
    /** Resolution audit. NULL = open. */
    resolvedAt: timestampTzNullable(),
    resolvedByUserId: fk().references(() => users.id, { onDelete: 'set null' }),
    resolutionNote: text(),
    createdAt: createdAt(),
  },
  (table) => [
    index('affiliate_fraud_signals_workspace_idx').on(
      table.workspaceId,
      table.severity,
      table.createdAt,
    ),
    index('affiliate_fraud_signals_affiliate_idx').on(table.affiliateId, table.createdAt),
  ],
);

/**
 * Append-only audit ledger of every status change in the affiliate
 * subsystem. Mirrors `events_audit` but lives separate so a producer
 * can scan their affiliate compliance without pulling the firehose.
 */
export const affiliateAuditLog = pgTable(
  'affiliate_audit_log',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorUserId: fk().references(() => users.id, { onDelete: 'set null' }),
    /** Which row this audit entry concerns. */
    targetTable: text().notNull(),
    targetId: text().notNull(),
    action: text().notNull(),
    /** State before + after, redacted of any encrypted fields. */
    payload: jsonb().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    index('affiliate_audit_log_workspace_idx').on(table.workspaceId, table.createdAt),
    index('affiliate_audit_log_target_idx').on(table.targetTable, table.targetId),
  ],
);
