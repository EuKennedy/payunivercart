import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  TrackingAdapter,
  TrackingAdapterCallResult,
  TrackingEvent,
  TrackingUserContext,
} from '../types';

/**
 * TikTok Events API v1.3 adapter.
 *
 * Endpoint: POST https://business-api.tiktok.com/open_api/v1.3/event/track/
 * Auth:     Access-Token header
 *
 * TikTok mirrors Meta's CAPI shape closely (data array, event_id for
 * dedupe with the browser pixel, user fields hashed sha256 lower).
 * Differences worth noting:
 *   - `pixel_code` (their term for pixel id) is required as a body
 *     field, NOT a path param.
 *   - `test_event_code` lives at the top-level alongside `data`.
 *   - Their TikTok Click ID is `ttclid`, captured from the landing URL.
 */

const CredentialsSchema = z.object({
  /** TikTok pixel code (Events Manager → Settings → "Web Events" id). */
  pixelCode: z.string().trim().min(8).max(64),
  /** Long-lived access token (Events Manager → Access Token tab). */
  accessToken: z.string().trim().min(20).max(512),
  /** Optional — TikTok Test Events Code. Events with this go to the
   *  test panel only. */
  testEventCode: z.string().trim().min(3).max(80).optional(),
});

export type TikTokCredentials = z.infer<typeof CredentialsSchema>;

const TIKTOK_EVENT_NAME: Record<TrackingEvent['eventType'], string> = {
  page_view: 'Pageview',
  view_content: 'ViewContent',
  add_to_cart: 'AddToCart',
  initiate_checkout: 'InitiateCheckout',
  add_payment_info: 'AddPaymentInfo',
  purchase: 'CompletePayment',
  subscribe: 'Subscribe',
  // TikTok has no "renewal" — re-fire CompletePayment with a custom
  // `event_channel=renewal` so the producer can segment.
  subscription_renew: 'CompletePayment',
  lead: 'SubmitForm',
  complete_registration: 'CompleteRegistration',
};

const ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

export const tiktokAdapter: TrackingAdapter<TikTokCredentials> = {
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
  credentials: TikTokCredentials,
  pixel: { publicPixelId: string; testMode: boolean },
  event: TrackingEvent,
): Promise<TrackingAdapterCallResult> {
  const body = {
    event_source: 'web',
    event_source_id: credentials.pixelCode,
    // Test events bucket — TikTok ignores when omitted.
    test_event_code: pixel.testMode ? credentials.testEventCode : undefined,
    data: [
      {
        event: TIKTOK_EVENT_NAME[event.eventType],
        event_time: event.eventTimeSeconds,
        event_id: event.eventId,
        user: buildUserData(event.user),
        properties: {
          currency: event.currency,
          value: event.value,
          content_id: event.contentId ?? undefined,
          content_name: event.contentName ?? undefined,
          content_type: event.contentId ? 'product' : undefined,
          contents: event.contents?.map((c) => ({
            content_id: c.id,
            content_type: 'product',
            quantity: c.quantity,
            price: c.itemPrice,
          })),
          // Surfaces the renewal vs initial purchase distinction in
          // TikTok's segment builder.
          event_channel: event.eventType === 'subscription_renew' ? 'renewal' : undefined,
        },
        page: event.sourceUrl ? { url: event.sourceUrl } : undefined,
      },
    ],
  };

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Access-Token': credentials.accessToken,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as {
      code?: number;
      message?: string;
      request_id?: string;
    } | null;
    // TikTok returns HTTP 200 even on validation failure; the real
    // success signal is `code === 0`.
    if (!res.ok || json?.code !== 0) {
      return {
        ok: false,
        httpStatus: res.status,
        providerEventId: null,
        response: json,
        errorMessage: json?.message ?? `TikTok Events API returned HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      httpStatus: res.status,
      providerEventId: json.request_id ?? event.eventId,
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
  if (user.email) out.email = hashLower(user.email);
  if (user.phoneE164) out.phone = hashLower(user.phoneE164.replace(/\D/g, ''));
  if (user.document) out.external_id = hashLower(user.document.replace(/\D/g, ''));
  // TikTok accepts raw IP / UA per spec.
  if (user.clientIpAddress) out.ip = user.clientIpAddress;
  if (user.clientUserAgent) out.user_agent = user.clientUserAgent;
  if (user.ttclid) out.ttclid = user.ttclid;
  return out;
}

function hashLower(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}
