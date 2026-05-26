import { boolean, index, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, fk, id, updatedAt } from './common';
import { workspaces } from './workspaces';

/**
 * Per-workspace notification template overrides.
 *
 * The platform ships hard-coded defaults for every transactional
 * notification (see `packages/notifications/src/defaults.ts`). Each row
 * in this table represents one producer-customised template — when a
 * send path resolves a template the lookup is:
 *
 *   1. SELECT from notification_templates WHERE workspace + event +
 *      channel AND is_active = true
 *   2. If found, render the producer's subject/body with the same
 *      variable map the default uses.
 *   3. If absent (or row is disabled), fall back to the platform
 *      default.
 *
 * Why a single table and not one column per template:
 *   - Producers ask for new events constantly (sub renewed, refund
 *     issued, affiliate approved, …). A wide table forces a schema
 *     migration each time; a key-based table just adds an enum value.
 *   - The `(workspace_id, event_key, channel)` composite is the
 *     natural unique key — exactly one override per channel/event.
 *
 * Tenant isolation: every read MUST predicate on `workspace_id`. The
 * RLS policies in `02_rls_policies.sql` enforce this; the API layer
 * adds the explicit predicate as defence-in-depth.
 *
 * Subject is nullable because WhatsApp / SMS channels don't have one.
 * The renderer treats `subject = null` as "no subject" rather than
 * "empty subject"; setting it to an empty string instead would silently
 * dispatch transactional emails with no subject line.
 */

/**
 * Closed set of every transactional notification the platform can
 * customise. We intentionally don't expose `otp_*` here — login codes
 * stay platform-controlled so a hostile producer can't dilute the
 * security message.
 */
export const notificationEventEnum = pgEnum('notification_event', [
  'order_paid_buyer',
  'order_paid_producer',
  'subscription_activated_buyer',
  'subscription_activated_producer',
  'entitlement_granted',
  'cart_recovery',
]);

export const notificationChannelEnum = pgEnum('notification_channel', ['email', 'whatsapp']);

export const notificationTemplates = pgTable(
  'notification_templates',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    eventKey: notificationEventEnum().notNull(),
    channel: notificationChannelEnum().notNull(),
    /** Subject line — required for email channel, ignored for whatsapp. */
    subject: text(),
    /** Plain-text body. For email the platform wraps this in the
     *  brand shell; for whatsapp it's sent verbatim. Placeholder
     *  syntax is `{var}` (no double braces) for parity with the
     *  recovery campaign templates already in production. */
    body: text().notNull(),
    /** Soft toggle — producer can keep the customised copy in DB but
     *  fall back to the platform default by flipping this off. */
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One row per (workspace, event, channel). UPSERT collapses on
    // this index; the API uses ON CONFLICT DO UPDATE to keep the
    // mutation idempotent.
    uniqueIndex('notification_templates_workspace_event_channel_unique').on(
      table.workspaceId,
      table.eventKey,
      table.channel,
    ),
    index('notification_templates_workspace_idx').on(table.workspaceId),
  ],
);
