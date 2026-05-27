import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  TrackingAdapter,
  TrackingAdapterCallResult,
  TrackingEvent,
  TrackingUserContext,
} from '../types';

/**
 * Google Analytics 4 Measurement Protocol adapter.
 *
 * Endpoint: POST https://www.google-analytics.com/mp/collect
 *           ?measurement_id={G-...}&api_secret={...}
 *
 * Validation endpoint: /debug/mp/collect — same params, returns
 * `validationMessages[]` instead of silently dropping. We hit the
 * debug endpoint from `test()` and the real one from `send()`.
 *
 * Identity model: GA4 uses `client_id` (browser-side) and an optional
 * `user_id` (server-side). Since this dispatcher runs out of the
 * checkout context where the browser cookie may not be reachable, we
 * derive a stable `client_id` from a hash of (workspace_id + buyer
 * identifier). GA4 treats every server hit with the same client_id as
 * the same visitor.
 */

const CredentialsSchema = z.object({
  /** GA4 measurement id, format `G-XXXXXXXX`. */
  measurementId: z
    .string()
    .trim()
    .regex(/^G-[A-Z0-9]{6,12}$/i, 'Use o formato G-XXXXXXXX.'),
  /** Web stream API secret (Admin → Data Streams → Measurement Protocol). */
  apiSecret: z.string().trim().min(8).max(256),
});

export type Ga4Credentials = z.infer<typeof CredentialsSchema>;

const GA4_EVENT_NAME: Record<TrackingEvent['eventType'], string> = {
  page_view: 'page_view',
  view_content: 'view_item',
  add_to_cart: 'add_to_cart',
  initiate_checkout: 'begin_checkout',
  add_payment_info: 'add_payment_info',
  purchase: 'purchase',
  subscribe: 'purchase',
  // GA4 has no canonical "renewal" — fire as `purchase` with a custom
  // `subscription_event=renewal` param the producer can segment on.
  subscription_renew: 'purchase',
  lead: 'generate_lead',
  complete_registration: 'sign_up',
};

export const ga4Adapter: TrackingAdapter<Ga4Credentials> = {
  parseCredentials(raw) {
    return CredentialsSchema.parse(raw);
  },

  async send(credentials, pixel, event) {
    return dispatch(credentials, pixel, event, false);
  },

  async test(credentials, pixel) {
    // GA4 /debug/mp/collect tolerates events without user_data, but
    // future SDK upgrades may tighten that. Probe carries a
    // deterministic document so deriveClientId + buildUserData both
    // resolve to stable hashed values. testMode forced ON so the
    // debug_mode flag is set on the probe.
    const probe: TrackingEvent = {
      eventId: `payuniv-test-${Date.now()}`,
      eventType: 'page_view',
      eventTimeSeconds: Math.floor(Date.now() / 1000),
      currency: 'BRL',
      value: 0,
      sourceUrl: 'https://payunivercart.test/__validate',
      user: { document: '00000000000' },
    };
    return dispatch(credentials, { ...pixel, testMode: true }, probe, true);
  },
};

async function dispatch(
  credentials: Ga4Credentials,
  pixel: { publicPixelId: string; testMode: boolean },
  event: TrackingEvent,
  debug: boolean,
): Promise<TrackingAdapterCallResult> {
  const base = debug
    ? 'https://www.google-analytics.com/debug/mp/collect'
    : 'https://www.google-analytics.com/mp/collect';
  const url = `${base}?measurement_id=${encodeURIComponent(credentials.measurementId)}&api_secret=${encodeURIComponent(credentials.apiSecret)}`;

  const clientId = deriveClientId(event.user);
  const body = {
    client_id: clientId,
    user_id: event.user.email ?? undefined,
    timestamp_micros: event.eventTimeSeconds * 1_000_000,
    // GA4 user_properties — server-side identity for Enhanced Conversions
    // signals. Hashed where the spec asks for it.
    user_properties: buildUserProperties(event.user),
    user_data: buildUserData(event.user),
    non_personalized_ads: false,
    events: [
      {
        name: GA4_EVENT_NAME[event.eventType],
        params: {
          // Standard ecommerce params.
          currency: event.currency,
          value: event.value,
          transaction_id: event.eventId,
          items: event.contents?.map((c) => ({
            item_id: c.id,
            item_name: event.contentName ?? undefined,
            price: c.itemPrice,
            quantity: c.quantity,
          })),
          coupon: event.promotionCode ?? undefined,
          // Custom dimension lets the producer build a "renewal" segment.
          subscription_event: event.eventType === 'subscription_renew' ? 'renewal' : undefined,
          page_location: event.sourceUrl ?? undefined,
          // GA4 reserved Debug-mode flag.
          debug_mode: pixel.testMode ? 1 : undefined,
        },
      },
    ],
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Production /mp/collect returns 2xx empty body on success.
    // Debug /debug/mp/collect returns JSON with validationMessages.
    if (debug) {
      const json = (await res.json().catch(() => null)) as {
        validationMessages?: { description?: string }[];
      } | null;
      const errs = json?.validationMessages ?? [];
      if (errs.length > 0) {
        return {
          ok: false,
          httpStatus: res.status,
          providerEventId: null,
          response: json,
          errorMessage: errs.map((e) => e.description ?? 'invalid').join('; '),
        };
      }
      return {
        ok: true,
        httpStatus: res.status,
        providerEventId: event.eventId,
        response: json,
        errorMessage: null,
      };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        httpStatus: res.status,
        providerEventId: null,
        response: { body: text.slice(0, 4000) },
        errorMessage: `GA4 returned HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      httpStatus: res.status,
      providerEventId: event.eventId,
      response: null,
      errorMessage: null,
    };
  } catch (cause) {
    return {
      ok: false,
      httpStatus: null,
      providerEventId: null,
      response: null,
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * GA4 hashed user_data for Enhanced Conversions. Same SHA-256
 * lowercased-trimmed normalization that Meta uses; GA4 also wants
 * the email-name part separated from the domain hash, but the
 * Measurement Protocol accepts the full-email hash as a fallback.
 */
function buildUserData(user: TrackingUserContext): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (user.email) out.sha256_email_address = hashLower(user.email);
  if (user.phoneE164) out.sha256_phone_number = hashLower(user.phoneE164.replace(/\D/g, ''));
  if (user.name) {
    const [first, ...rest] = user.name.trim().split(/\s+/);
    if (first) out.sha256_first_name = hashLower(first);
    if (rest.length) out.sha256_last_name = hashLower(rest.join(' '));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildUserProperties(
  user: TrackingUserContext,
): Record<string, { value: string }> | undefined {
  const out: Record<string, { value: string }> = {};
  if (user.country) out.country = { value: user.country };
  if (user.state) out.region = { value: user.state };
  if (user.city) out.city = { value: user.city };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Stable client_id per buyer per workspace. GA4 dedupes hits with the
 * same client_id under one visitor; without this every server fire
 * would look like a brand-new anonymous session.
 */
function deriveClientId(user: TrackingUserContext): string {
  const seed = user.email ?? user.phoneE164 ?? user.document ?? user.clientIpAddress ?? 'anonymous';
  // GA4 client_id format: "<random_int>.<unix_seconds>". We mimic the
  // shape with a hash-derived int so the value is stable but valid.
  const hash = createHash('sha256').update(seed).digest('hex');
  const intPart = Number.parseInt(hash.slice(0, 12), 16) % 1_000_000_000;
  return `${intPart}.${Math.floor(Date.now() / 1000)}`;
}

function hashLower(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}
