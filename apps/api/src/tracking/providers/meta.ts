import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  TrackingAdapter,
  TrackingAdapterCallResult,
  TrackingEvent,
  TrackingUserContext,
} from '../types';

/**
 * Meta Conversions API (CAPI) adapter.
 *
 * Endpoint: POST https://graph.facebook.com/v19.0/{pixel_id}/events
 *           ?access_token=...
 *
 * Why server-side over the browser pixel:
 *   - ITP / browser ad-blockers eat ~30-60% of client-side fires.
 *   - CAPI accepts every conversion signal even on iOS 17 Safari.
 *   - Pairing a server-side event with a browser pixel (same eventId)
 *     gives Meta both signals to dedupe, which their attribution
 *     model treats as a higher-confidence conversion.
 *
 * PII hashing: every user identifier (em, ph, fn, ln, ge, ct, st, zp,
 * ct, country, external_id) is SHA-256 hashed of the LOWERCASED +
 * TRIMMED value, per Meta's spec. fbp / fbc / IP / UA pass raw.
 */

const CredentialsSchema = z.object({
  /** Meta's pixel id (same value the producer paste into <script>). */
  pixelId: z.string().trim().min(8).max(64),
  /** Server-side access token issued in Events Manager. */
  accessToken: z.string().trim().min(40).max(512),
  /** Optional — Meta's Test Events code; events sent with this go to
   *  the test panel and DO NOT count toward production attribution. */
  testEventCode: z.string().trim().min(3).max(80).optional(),
});

export type MetaCredentials = z.infer<typeof CredentialsSchema>;

const META_EVENT_NAME: Record<TrackingEvent['eventType'], string> = {
  page_view: 'PageView',
  view_content: 'ViewContent',
  add_to_cart: 'AddToCart',
  initiate_checkout: 'InitiateCheckout',
  add_payment_info: 'AddPaymentInfo',
  purchase: 'Purchase',
  subscribe: 'Subscribe',
  // Meta has no canonical "renewal" event — they recommend re-firing
  // Subscribe with a custom `subscription_event=renewal` parameter.
  subscription_renew: 'Subscribe',
  lead: 'Lead',
  complete_registration: 'CompleteRegistration',
};

export const metaAdapter: TrackingAdapter<MetaCredentials> = {
  parseCredentials(raw) {
    return CredentialsSchema.parse(raw);
  },

  async send(credentials, pixel, event) {
    return dispatch(credentials, pixel, event);
  },

  async test(credentials, pixel) {
    const probe: TrackingEvent = {
      eventId: `payuniv-test-${Date.now()}`,
      eventType: 'page_view',
      eventTimeSeconds: Math.floor(Date.now() / 1000),
      currency: 'BRL',
      value: 0,
      sourceUrl: 'https://payunivercart.test/__validate',
      user: {},
    };
    return dispatch(credentials, pixel, probe);
  },
};

async function dispatch(
  credentials: MetaCredentials,
  pixel: { publicPixelId: string; testMode: boolean },
  event: TrackingEvent,
): Promise<TrackingAdapterCallResult> {
  const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(pixel.publicPixelId)}/events?access_token=${encodeURIComponent(credentials.accessToken)}`;
  const body = {
    data: [
      {
        event_name: META_EVENT_NAME[event.eventType],
        event_time: event.eventTimeSeconds,
        event_id: event.eventId,
        action_source: 'website',
        event_source_url: event.sourceUrl ?? undefined,
        user_data: buildUserData(event.user),
        custom_data: {
          currency: event.currency,
          value: event.value,
          content_ids: event.contentId ? [event.contentId] : undefined,
          content_name: event.contentName ?? undefined,
          content_type: event.contentId ? 'product' : undefined,
          contents: event.contents,
          promotion_code: event.promotionCode ?? undefined,
        },
      },
    ],
    // Test events code: prefer the per-event override on pixel.testMode;
    // fall back to the producer-stored test code if present.
    test_event_code: pixel.testMode ? credentials.testEventCode : undefined,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as {
      events_received?: number;
      fbtrace_id?: string;
      error?: { message?: string };
    } | null;
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        providerEventId: null,
        response: json,
        errorMessage: json?.error?.message ?? `Meta CAPI returned HTTP ${res.status}`,
      };
    }
    return {
      ok: (json?.events_received ?? 0) > 0,
      httpStatus: res.status,
      // Meta echoes our event_id back as accepted — we already know it,
      // but recording the fbtrace_id is useful for Events Manager
      // deep-links from the producer UI.
      providerEventId: json?.fbtrace_id ?? event.eventId,
      response: json,
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

function buildUserData(user: TrackingUserContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (user.email) out.em = [hashLower(user.email)];
  if (user.phoneE164) out.ph = [hashLower(user.phoneE164.replace(/\D/g, ''))];
  if (user.name) {
    const [first, ...rest] = user.name.trim().split(/\s+/);
    if (first) out.fn = [hashLower(first)];
    if (rest.length) out.ln = [hashLower(rest.join(' '))];
  }
  if (user.document) out.external_id = [hashLower(user.document.replace(/\D/g, ''))];
  if (user.city) out.ct = [hashLower(user.city)];
  if (user.state) out.st = [hashLower(user.state)];
  if (user.zip) out.zp = [hashLower(user.zip)];
  if (user.country) out.country = [hashLower(user.country)];
  // These pass RAW per Meta spec.
  if (user.clientIpAddress) out.client_ip_address = user.clientIpAddress;
  if (user.clientUserAgent) out.client_user_agent = user.clientUserAgent;
  if (user.fbp) out.fbp = user.fbp;
  if (user.fbc) out.fbc = user.fbc;
  return out;
}

/**
 * SHA-256(lowercase(trim(value))) — Meta's required normalization. We
 * hash with hex output because that's what Meta accepts; base64 also
 * works but adds an unneeded ambiguity dimension on debugging.
 */
function hashLower(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}
