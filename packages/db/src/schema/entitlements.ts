import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, fk, id, timestampTzNullable, updatedAt } from './common';
import { partnerAccounts, partnerWebhookEndpoints } from './partners';
import { subscriptions } from './subscriptions';
import { workspaces } from './workspaces';

/**
 * Entitlement events + magic-link tokens for Univercart Connect.
 *
 * Separated from `partners.ts` because the lifecycle is different:
 * partner accounts / API keys live forever; events and tokens churn
 * with every subscription cycle. Splitting the files keeps the
 * audit-style append-only tables out of the partner CRUD path.
 */

export const partnerEventTypeEnum = pgEnum('partner_event_type', [
  'entitlement.granted',
  'entitlement.role_changed',
  'entitlement.suspended',
  'entitlement.reactivated',
  'entitlement.revoked',
]);

export const partnerDeliveryStatusEnum = pgEnum('partner_delivery_status', [
  'pending',
  'delivered',
  'failed',
  'dead_letter',
]);

/**
 * `entitlement_tokens` — single-use JWT magic links sent to the buyer
 * by email + WhatsApp. The token's `jti` claim matches the primary
 * key here so the partner can call `POST /v1/tokens/:jti/redeem`
 * before accepting it, and a stolen-link replay attempt returns
 * HTTP 410.
 *
 * Cleanup: a daily job purges rows where `expiresAt < now() - 30d`.
 */
export const entitlementTokens = pgTable(
  'entitlement_tokens',
  {
    jti: uuid().primaryKey().defaultRandom(),
    subscriptionId: fk()
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    partnerId: fk()
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: 'cascade' }),
    issuedAt: timestamp({ mode: 'date', withTimezone: true, precision: 3 })
      .notNull()
      .default(sql`now()`),
    expiresAt: timestamp({ mode: 'date', withTimezone: true, precision: 3 }).notNull(),
    redeemedAt: timestampTzNullable(),
  },
  (table) => [
    index('entitlement_tokens_subscription_idx').on(table.subscriptionId),
    index('entitlement_tokens_partner_idx').on(table.partnerId),
    index('entitlement_tokens_expires_idx').on(table.expiresAt),
  ],
);

/**
 * `connect_events` — append-only log of every entitlement event we
 * dispatched (or attempted to). Lets the partner replay history and
 * lets us reconcile the partner state when their webhook handler has
 * been down for a while.
 *
 * The `payload` mirrors the JSON body that goes over the wire to the
 * partner endpoint — never mutated after insert.
 */
export const connectEvents = pgTable(
  'connect_events',
  {
    id: id(),
    partnerId: fk()
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: 'cascade' }),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    subscriptionId: fk().references(() => subscriptions.id, { onDelete: 'set null' }),
    type: partnerEventTypeEnum().notNull(),
    payload: jsonb().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('connect_events_partner_idx').on(table.partnerId),
    index('connect_events_workspace_idx').on(table.workspaceId),
    index('connect_events_subscription_idx').on(table.subscriptionId),
    index('connect_events_type_created_idx').on(table.type, table.createdAt),
  ],
);

/**
 * `connect_webhook_deliveries` — one row per (event, endpoint) pair.
 * BullMQ worker drives the retry schedule using `nextAttemptAt` and
 * `attempts`. Status transitions:
 *
 *   pending → delivered                 (2xx response)
 *   pending → failed → pending (retry)  (5xx / network error, attempts<9)
 *   pending → dead_letter               (attempts>=9 after ~72h)
 *
 * `lastResponseStatus` + `lastResponseBody` give the partner a
 * delivery-log view in their dashboard.
 */
export const connectWebhookDeliveries = pgTable(
  'connect_webhook_deliveries',
  {
    id: id(),
    eventId: fk()
      .notNull()
      .references(() => connectEvents.id, { onDelete: 'cascade' }),
    endpointId: fk()
      .notNull()
      .references(() => partnerWebhookEndpoints.id, { onDelete: 'cascade' }),
    status: partnerDeliveryStatusEnum().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    lastAttemptAt: timestampTzNullable(),
    nextAttemptAt: timestampTzNullable(),
    lastResponseStatus: integer(),
    lastResponseBody: text(),
    deliveredAt: timestampTzNullable(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('connect_deliveries_event_idx').on(table.eventId),
    index('connect_deliveries_endpoint_idx').on(table.endpointId),
    index('connect_deliveries_status_next_idx').on(table.status, table.nextAttemptAt),
  ],
);
