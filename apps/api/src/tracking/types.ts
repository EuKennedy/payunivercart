/**
 * Shared types for the server-side tracking dispatcher. Provider
 * adapters live in `./providers/*` and conform to `TrackingAdapter`.
 *
 * Event model is intentionally provider-agnostic; the adapter is
 * responsible for translating a `TrackingEvent` into the body shape
 * the provider's HTTP endpoint accepts (Meta CAPI, GA4 MP, etc.).
 */

export type TrackingProvider = 'meta' | 'google_ads' | 'ga4' | 'tiktok' | 'pinterest' | 'kwai';

export type TrackingEventType =
  | 'page_view'
  | 'view_content'
  | 'add_to_cart'
  | 'initiate_checkout'
  | 'add_payment_info'
  | 'purchase'
  | 'subscribe'
  | 'subscription_renew'
  | 'lead'
  | 'complete_registration';

/**
 * Buyer signals collected at the moment the event fires. Every field
 * is OPTIONAL because we never want a missing IP / fingerprint to
 * block a Purchase event — the adapter will hash whatever's present
 * and pass it to the provider for ad-attribution matching.
 */
export interface TrackingUserContext {
  /** Buyer email — gets sha256-hashed inside the adapter. */
  email?: string | null;
  /** Buyer phone in E.164 — sha256-hashed inside the adapter. */
  phoneE164?: string | null;
  /** Buyer full name — split into fn/ln + hashed by the adapter. */
  name?: string | null;
  /** Buyer document — sha256-hashed (CPF/CNPJ for BR adapters). */
  document?: string | null;
  /** Buyer city. NOT hashed (Meta accepts raw). */
  city?: string | null;
  /** Buyer state. NOT hashed. */
  state?: string | null;
  /** Buyer zip. NOT hashed. */
  zip?: string | null;
  /** Buyer country (ISO-2). NOT hashed. */
  country?: string | null;
  /** Client IP at the moment of conversion. */
  clientIpAddress?: string | null;
  /** Browser user-agent at the moment of conversion. */
  clientUserAgent?: string | null;
  /** Meta's first-party cookie value (`_fbp`). */
  fbp?: string | null;
  /** Meta's click id (`_fbc` / `fbclid`). */
  fbc?: string | null;
  /** Google click id (`gclid`). */
  gclid?: string | null;
  /** TikTok click id (`ttclid`). */
  ttclid?: string | null;
}

/**
 * Provider-agnostic event payload. The dispatcher constructs one of
 * these per (event, pixel) pair and hands it to the adapter.
 */
export interface TrackingEvent {
  /** Unique id we mint for dedupe across browser + server fires. */
  eventId: string;
  /** Event type — see `TrackingEventType`. */
  eventType: TrackingEventType;
  /** Unix epoch seconds (NOT ms) — that's what every provider expects. */
  eventTimeSeconds: number;
  /** Public URL where the conversion happened (checkout page). */
  sourceUrl?: string | null;
  /** Currency ISO-4217 (e.g. BRL, USD). */
  currency: string;
  /** Total value of the conversion in MAJOR units (e.g. R$ 99,90 → 99.90). */
  value: number;
  /** Single SKU id for the conversion (orderItems[0].productId). */
  contentId?: string | null;
  /** SKU label — human-readable, shown in the provider's Events Manager. */
  contentName?: string | null;
  /** Producer-side number of units in the conversion. Default 1. */
  contents?: { id: string; quantity: number; itemPrice: number }[];
  /** Affiliate / coupon code applied — surfaced as a custom parameter. */
  promotionCode?: string | null;
  /** Buyer signals. */
  user: TrackingUserContext;
}

export interface TrackingAdapterCallResult {
  ok: boolean;
  httpStatus: number | null;
  /** Echo of the provider event id when accepted, NULL on failure. */
  providerEventId: string | null;
  /** Parsed response body — capped to 8 KB to keep the dispatch ledger tidy. */
  response: unknown;
  /** Human-readable failure reason. */
  errorMessage: string | null;
}

export interface TrackingAdapter<TCredentials = unknown> {
  /** Coerce + validate the producer's credential blob. Throws on shape mismatch. */
  parseCredentials(raw: unknown): TCredentials;
  /** Fire a single event. MUST be idempotent (dispatcher reuses eventId on retries). */
  send(
    credentials: TCredentials,
    pixel: { publicPixelId: string; testMode: boolean },
    event: TrackingEvent,
  ): Promise<TrackingAdapterCallResult>;
  /** Cheap synthetic event to validate credentials. Same retry semantics. */
  test(
    credentials: TCredentials,
    pixel: { publicPixelId: string; testMode: boolean },
  ): Promise<TrackingAdapterCallResult>;
}
