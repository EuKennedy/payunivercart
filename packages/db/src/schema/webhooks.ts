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
import { createdAt, fk, gatewayIdEnum, id, timestampTzNullable, updatedAt } from './common.js';
import { workspaces } from './workspaces.js';

export const webhookDirectionEnum = pgEnum('webhook_direction', ['inbound', 'outbound']);

export const webhookStatusEnum = pgEnum('webhook_status', [
  'pending',
  'processing',
  'delivered',
  'failed',
  'dead_letter',
]);

/**
 * Tri-state for inbound webhook signature verification:
 *   `valid`   — HMAC verified by the relevant gateway adapter.
 *   `invalid` — signature present but did not verify.
 *   `unknown` — no signature header, or verifier not yet available
 *               (e.g. payload landed before the adapter was deployed).
 *
 * Stored as a Postgres enum so `WHERE signature_valid = 'valid'` filters
 * work as expected, and so the column cannot drift into free-form strings.
 */
export const webhookSignatureStateEnum = pgEnum('webhook_signature_state', [
  'unknown',
  'valid',
  'invalid',
]);

/**
 * Inbound webhooks received from gateways and WAHA are recorded for dedupe
 * (by signature/event id), debugging, and replay.
 */
export const webhooksInbound = pgTable(
  'webhooks_inbound',
  {
    id: id(),
    workspaceId: fk().references(() => workspaces.id, { onDelete: 'set null' }),
    source: text().notNull(),
    eventId: text().notNull(),
    eventType: text().notNull(),
    rawHeaders: jsonb().notNull(),
    rawBody: text().notNull(),
    signatureValid: webhookSignatureStateEnum().notNull().default('unknown'),
    /** Set when the worker finishes processing this event; null = still pending. */
    processedAt: timestampTzNullable(),
    error: text(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('webhooks_inbound_source_event_unique').on(table.source, table.eventId),
    index('webhooks_inbound_workspace_idx').on(table.workspaceId),
    index('webhooks_inbound_processed_idx').on(table.processedAt),
  ],
);

/**
 * Outbound webhook delivery queue (transactional outbox pattern).
 */
export const webhooksOutbox = pgTable(
  'webhooks_outbox',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    endpoint: text().notNull(),
    eventType: text().notNull(),
    payload: jsonb().notNull(),
    signature: text().notNull(),
    status: webhookStatusEnum().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    /** Null until the first attempt completes. */
    lastAttemptAt: timestampTzNullable(),
    /** App computes (e.g. now() + backoff) at insert; null until scheduled. */
    nextAttemptAt: timestampTzNullable(),
    lastResponseStatus: integer(),
    lastResponseBody: text(),
    deliveredAt: timestampTzNullable(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('webhooks_outbox_workspace_idx').on(table.workspaceId),
    index('webhooks_outbox_status_idx').on(table.status, table.nextAttemptAt),
  ],
);

/**
 * Gateway-specific webhook endpoints the producer wants to receive on their
 * own systems (after we normalize and re-emit).
 */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    url: text().notNull(),
    description: text(),
    eventTypes: jsonb().notNull().default([]),
    secret: text().notNull(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('webhook_endpoints_workspace_idx').on(table.workspaceId),
    index('webhook_endpoints_active_idx').on(table.workspaceId, table.isActive),
  ],
);

/** Reference to whichever gateway each inbound webhook came from. */
export const webhooksInboundGateway = pgTable('webhooks_inbound_gateway', {
  id: id(),
  inboundId: fk()
    .notNull()
    .references(() => webhooksInbound.id, { onDelete: 'cascade' }),
  gatewayId: gatewayIdEnum().notNull(),
});
