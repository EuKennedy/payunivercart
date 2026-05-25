import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  TrackingAdapter,
  TrackingAdapterCallResult,
  TrackingEvent,
  TrackingUserContext,
} from '../types';

/**
 * Kwai Pixel API (Kwai for Business) adapter.
 *
 * Endpoint:
 *   POST https://www.kwai.com/business/api/openapi/pixel/track
 *
 * Auth: `access_token` in body (NOT header) per Kwai's Brazilian
 * platform spec. Mirrors TikTok's data shape closely — easier path
 * because Kwai forked their Events API from the early TikTok one.
 *
 * Identity model: email/phone sha256 lowercased, IP/UA passthrough,
 * `kwai_click_id` (kclid) deep-link param when present in the URL.
 */

const CredentialsSchema = z.object({
  /** Kwai pixel id (Pixels → seu pixel → "Pixel ID"). */
  pixelId: z.string().trim().min(8).max(64),
  /** Long-lived access token (Pixels → "Generate Access Token"). */
  accessToken: z.string().trim().min(20).max(512),
  /** Optional — test event code for Kwai's debug panel. */
  testEventCode: z.string().trim().min(3).max(80).optional(),
});

export type KwaiCredentials = z.infer<typeof CredentialsSchema>;

const KWAI_EVENT_NAME: Record<TrackingEvent['eventType'], string> = {
  page_view: 'CONTENT_VIEW',
  view_content: 'CONTENT_VIEW',
  add_to_cart: 'ADD_TO_CART',
  initiate_checkout: 'INITIATED_CHECKOUT',
  add_payment_info: 'ADD_PAYMENT_INFO',
  purchase: 'PURCHASE',
  subscribe: 'SUBSCRIBE',
  subscription_renew: 'PURCHASE',
  lead: 'COMPLETE_REGISTRATION',
  complete_registration: 'COMPLETE_REGISTRATION',
};

const ENDPOINT = 'https://www.kwai.com/business/api/openapi/pixel/track';

export const kwaiAdapter: TrackingAdapter<KwaiCredentials> = {
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
  credentials: KwaiCredentials,
  pixel: { publicPixelId: string; testMode: boolean },
  event: TrackingEvent,
): Promise<TrackingAdapterCallResult> {
  const body = {
    access_token: credentials.accessToken,
    pixel_id: credentials.pixelId,
    test_event_code: pixel.testMode ? credentials.testEventCode : undefined,
    event_name: KWAI_EVENT_NAME[event.eventType],
    event_time: event.eventTimeSeconds,
    event_id: event.eventId,
    event_source_url: event.sourceUrl ?? undefined,
    user_data: buildUserData(event.user),
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
    },
  };

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as {
      code?: number;
      message?: string;
      request_id?: string;
    } | null;
    // Kwai mirrors TikTok's status pattern: HTTP 200 + code:0 = success.
    if (!res.ok || (json?.code !== 0 && json?.code !== undefined)) {
      return {
        ok: false,
        httpStatus: res.status,
        providerEventId: null,
        response: json,
        errorMessage: json?.message ?? `Kwai Pixel returned HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      httpStatus: res.status,
      providerEventId: json?.request_id ?? event.eventId,
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
  if (user.clientIpAddress) out.ip = user.clientIpAddress;
  if (user.clientUserAgent) out.user_agent = user.clientUserAgent;
  return out;
}

function hashLower(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}
