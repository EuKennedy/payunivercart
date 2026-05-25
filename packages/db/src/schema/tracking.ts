import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, fk, id, timestampTzNullable, updatedAt } from './common';
import { workspaces } from './workspaces';

/**
 * Sealed-box ciphertext for the provider access token / secret. Same
 * `bytea` pattern as gateway credentials so a key rotation only has to
 * walk one column type across all integrations.
 */
const bytea = customType<{ data: Uint8Array; default: false }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Universal server-side tracking. Producer plugs in their own pixel
 * ids + secrets; the API mirrors every relevant funnel event
 * (Purchase, InitiateCheckout, Subscription renewal, etc.) directly
 * to each provider's server-side API.
 *
 * Why server-side instead of injecting client tags into the checkout:
 *   - iOS 14+ + Safari ITP eat 30-60% of pixel-fires that ride the
 *     browser. Server-side bypasses that loss entirely.
 *   - Producer's ad accounts charge per event signal, not per landing
 *     load. Bigger signal volume = better optimization + lower CPA.
 *   - One central queue + dispatcher means we get retries, idempotency,
 *     audit log, and rate-limit awareness "for free" instead of every
 *     producer rolling their own gtm tag.
 *
 * Multi-pixel per workspace is intentional: agencies frequently run
 * one ad account per offer / one Meta pixel per campaign. The
 * `isDefault` flag picks the one to fire when an event source doesn't
 * specify a pixel id, but the producer can opt-in any subset.
 */
export const trackingProviderEnum = pgEnum('tracking_provider', [
  'meta',
  'google_ads',
  'ga4',
  'tiktok',
  'pinterest',
  'kwai',
]);

export const trackingDispatchStatusEnum = pgEnum('tracking_dispatch_status', [
  'pending',
  'sent',
  'failed',
  'dropped',
]);

export const trackingEventTypeEnum = pgEnum('tracking_event_type', [
  'page_view',
  'view_content',
  'add_to_cart',
  'initiate_checkout',
  'add_payment_info',
  'purchase',
  'subscribe',
  'subscription_renew',
  'lead',
  'complete_registration',
]);

/**
 * Pixel credentials per workspace per provider. One workspace can hold
 * N pixels (e.g. one Meta pixel per offer / one GA4 measurement id per
 * brand). `isDefault` picks the row the dispatcher fires when the
 * event source doesn't explicitly target a pixel id.
 *
 * Credentials shape (sealed JSON):
 *   - meta       : { pixelId, accessToken, testEventCode? }
 *   - google_ads : { customerId, conversionActionId, oauthRefreshToken, developerToken }
 *   - ga4        : { measurementId, apiSecret }
 *   - tiktok     : { pixelCode, accessToken, testEventCode? }
 *   - pinterest  : { adAccountId, conversionToken, tagId }
 *   - kwai       : { pixelId, accessToken }
 */
export const trackingPixels = pgTable(
  'tracking_pixels',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: trackingProviderEnum().notNull(),
    /** Producer-facing label, e.g. "Meta — Oferta Black Friday". */
    label: text().notNull(),
    /** Public id the producer would paste into <script>. NOT secret. */
    publicPixelId: text().notNull(),
    /** Sealed JSON of the credentials envelope (see comment above). */
    credentialsEncrypted: bytea().notNull(),
    /** Key version used to seal — drives rotation. */
    keyId: text().notNull(),
    encVersion: smallint().notNull().default(1),
    /** Default pixel for this provider in this workspace. UI guarantees
     *  at most one true per (workspace_id, provider). */
    isDefault: boolean().notNull().default(false),
    /** Producer toggle — off pauses dispatch without forcing delete. */
    enabled: boolean().notNull().default(true),
    /** Provider-specific test mode token (Meta `test_event_code`, etc.).
     *  When set, dispatched events fall under the provider's test pane
     *  and DO NOT count toward production optimization. */
    testMode: boolean().notNull().default(false),
    /** Per-event toggles. JSON map { [eventType]: boolean }. Missing
     *  keys default to true so adding new event types is opt-out. */
    eventsEnabled: jsonb().$type<Record<string, boolean>>().notNull().default({}),
    /** Last successful test call — drives a "validated X minutes ago"
     *  chip in the producer UI. NULL until the producer hits Test. */
    lastValidatedAt: timestampTzNullable(),
    /** Last failure message — surfaced in the producer UI so they can
     *  see WHY a pixel stopped firing without grepping the worker logs. */
    lastErrorMessage: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestampTzNullable(),
  },
  (table) => [
    index('tracking_pixels_workspace_idx').on(table.workspaceId),
    index('tracking_pixels_provider_idx').on(table.workspaceId, table.provider),
  ],
);

/**
 * Per-event dispatch ledger. One row per (pixel, source_event) — the
 * `(workspaceId, pixelId, sourceType, sourceId, eventType)` unique
 * index gives us idempotency for free: a webhook retry that re-fires
 * the same "order paid" event for the same pixel collapses into
 * `ON CONFLICT DO NOTHING`.
 *
 * Status machine: pending → sent | failed → (retry queue) → sent | dropped.
 * `attemptCount` caps at 6 — after that we mark `dropped` so the
 * dispatcher stops requeueing forever.
 */
export const trackingDispatches = pgTable(
  'tracking_dispatches',
  {
    id: id(),
    workspaceId: fk()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    pixelId: fk()
      .notNull()
      .references(() => trackingPixels.id, { onDelete: 'cascade' }),
    eventType: trackingEventTypeEnum().notNull(),
    /** What this dispatch is about — `order`, `subscription`, `checkout`.
     *  Free text instead of an enum so future event sources (cart,
     *  affiliate, refund) don't need a migration. */
    sourceType: text().notNull(),
    /** Foreign id of the source row (orderId, subscriptionId, etc.). */
    sourceId: text().notNull(),
    /** Provider-side event id we sent — Meta returns one on accept,
     *  GA4 echoes the one we sent. Stored for the producer's
     *  "show in Events Manager" deep link. */
    providerEventId: text(),
    /** Raw payload we POSTed. Useful for diff vs provider response when
     *  debugging "why didn't this event show up". */
    payload: jsonb().notNull(),
    /** Last provider response body. Truncated to 8 KB at write time. */
    response: jsonb(),
    /** HTTP status of the last attempt. NULL when we never got a reply
     *  (DNS, TLS, connect timeout). */
    httpStatus: integer(),
    status: trackingDispatchStatusEnum().notNull().default('pending'),
    attemptCount: smallint().notNull().default(0),
    /** Last error message — string-only so the UI can render it as-is. */
    lastError: text(),
    /** Next attempt time. NULL when terminal. */
    nextAttemptAt: timestampTzNullable(),
    sentAt: timestampTzNullable(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('tracking_dispatch_unique').on(
      table.workspaceId,
      table.pixelId,
      table.sourceType,
      table.sourceId,
      table.eventType,
    ),
    index('tracking_dispatch_workspace_status_idx').on(table.workspaceId, table.status),
    index('tracking_dispatch_next_attempt_idx').on(table.nextAttemptAt),
  ],
);
