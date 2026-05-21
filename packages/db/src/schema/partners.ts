import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, fk, id, timestampTzNullable, updatedAt } from './common';

/**
 * "Univercart Connect" — partner SaaS integration domain.
 *
 * A `partnerAccount` represents a 3rd-party SaaS company (e.g. ZapGrup)
 * whose subscriptions are billed through the Univercart platform.
 * Producers on Univercart can attach their subscription plans to a
 * partner + role; once the buyer pays, we provision access in the
 * partner's app via signed webhook + magic-link JWT.
 *
 * This file owns the partner-side identity, credentials and
 * configuration. `entitlements.ts` owns the event/token records that
 * track per-subscription provisioning state.
 */

export const partnerStatusEnum = pgEnum('partner_status', ['pending', 'active', 'suspended']);

export const partnerKeyModeEnum = pgEnum('partner_key_mode', ['test', 'live']);

/**
 * `partner_accounts` — one row per SaaS company that integrates with
 * Univercart Connect. The `slug` is the public identifier used in
 * dashboard URLs and JWT `aud` claims.
 */
export const partnerAccounts = pgTable(
  'partner_accounts',
  {
    id: id(),
    /** URL-safe identifier. Becomes the JWT `aud` claim for magic links. */
    slug: text().notNull(),
    name: text().notNull(),
    contactEmail: text().notNull(),
    status: partnerStatusEnum().notNull().default('pending'),
    /**
     * If true, dispatches `entitlement.granted` the moment the subscription
     * is created (even during trial). If false, waits for the first real
     * charge. Per-SaaS preference because some partners (e.g. ZapGrup)
     * deliberately keep access closed until money lands.
     */
    trialAccessEnabled: boolean().notNull().default(true),
    /**
     * JWT signing secret (HS256) for magic links targeted at this partner.
     * Rotated by Univercart staff; partner reads via dashboard.
     */
    jwtSigningSecret: text().notNull(),
    /**
     * Base URL on the partner's own infra that handles the magic-link
     * setup flow. Univercart appends `?t=<JWT>` and embeds the result
     * in the buyer's email + WhatsApp. Example:
     *   `https://zapgrup.com.br/connect/setup`
     * The partner controls the entire setup UX (password form, session
     * issuance) at this URL — Univercart never sees the buyer's
     * password.
     */
    setupBaseUrl: text().notNull().default('https://example.com/setup'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('partner_accounts_slug_unique').on(table.slug)],
);

/**
 * `partner_api_keys` — bearer tokens partner servers use to call
 * `/v1/entitlements/*` and `/v1/tokens/:jti/redeem`. We store only the
 * bcrypt hash; the cleartext is shown to the user exactly once when
 * generated and can never be recovered.
 *
 * Test vs live mode is a hard boundary: a test key cannot touch live
 * data, and vice-versa. The `prefix` column holds the first 12 chars
 * of the cleartext (e.g. `sk_test_AbCd`) so the dashboard can show
 * which key is which without ever decrypting.
 */
export const partnerApiKeys = pgTable(
  'partner_api_keys',
  {
    id: id(),
    partnerId: fk()
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    mode: partnerKeyModeEnum().notNull(),
    /** First 12 chars of the cleartext key — display-only. */
    prefix: text().notNull(),
    /** bcrypt hash of the full cleartext key. */
    hash: text().notNull(),
    lastUsedAt: timestampTzNullable(),
    revokedAt: timestampTzNullable(),
    createdAt: createdAt(),
  },
  (table) => [
    index('partner_api_keys_partner_idx').on(table.partnerId),
    index('partner_api_keys_active_idx').on(table.partnerId, table.revokedAt),
    uniqueIndex('partner_api_keys_prefix_unique').on(table.prefix),
  ],
);

/**
 * `partner_webhook_endpoints` — partner-controlled URLs that receive
 * Univercart Connect event deliveries. Each endpoint owns its own
 * HMAC signing secret so partners can rotate without affecting other
 * endpoints (e.g. staging vs production).
 *
 * `eventTypes` is a JSONB array of event names the partner cares
 * about; deliveries for non-subscribed events are dropped at
 * dispatcher time.
 */
export const partnerWebhookEndpoints = pgTable(
  'partner_webhook_endpoints',
  {
    id: id(),
    partnerId: fk()
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: 'cascade' }),
    url: text().notNull(),
    mode: partnerKeyModeEnum().notNull(),
    description: text(),
    eventTypes: jsonb()
      .notNull()
      .default([
        'entitlement.granted',
        'entitlement.role_changed',
        'entitlement.suspended',
        'entitlement.reactivated',
        'entitlement.revoked',
      ]),
    /** HMAC SHA-256 secret used to sign the `X-Univercart-Signature` header. */
    signingSecret: text().notNull(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('partner_webhook_endpoints_partner_idx').on(table.partnerId),
    index('partner_webhook_endpoints_active_idx').on(table.partnerId, table.isActive),
  ],
);

/**
 * `partner_roles` — taxonomy of access tiers a partner exposes. Producer
 * picks one of these slugs when attaching a subscription plan to the
 * partner. The `slug` is opaque to Univercart — partner decides its
 * own naming convention (e.g. `entry` / `medium` / `ultra`).
 */
export const partnerRoles = pgTable(
  'partner_roles',
  {
    id: id(),
    partnerId: fk()
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    displayName: text().notNull(),
    description: text(),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('partner_roles_slug_unique').on(table.partnerId, table.slug)],
);
