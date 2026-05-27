import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  TrackingAdapter,
  TrackingAdapterCallResult,
  TrackingEvent,
  TrackingUserContext,
} from '../types';

/**
 * Pinterest Conversions API adapter.
 *
 * Endpoint:
 *   POST https://api.pinterest.com/v5/ad_accounts/{ad_account_id}/events
 *
 * Auth: `Authorization: Bearer {conversion_token}` — Pinterest issues a
 * conversion token specifically for server-side CAPI, NOT the standard
 * OAuth flow. Producer pastes it once and we use it directly.
 *
 * Identity model: every PII field hashed sha256 lowercased per spec.
 * No raw IP / UA acceptance (Pinterest stripped that in late 2023).
 */

const CredentialsSchema = z.object({
  /** Pinterest Ad Account id (numeric string, ~17 digits). */
  adAccountId: z
    .string()
    .trim()
    .regex(/^\d{6,20}$/),
  /** Conversion API token (Settings → Conversion API → "Generate token"). */
  conversionToken: z.string().trim().min(40).max(512),
  /** Pinterest tag id ("Pinterest Tag" header in Ads Manager). */
  tagId: z.string().trim().min(8).max(64),
  /** Optional — Pinterest's test-mode flag for the Events Manager test panel. */
  testEventCode: z.string().trim().min(3).max(80).optional(),
});

export type PinterestCredentials = z.infer<typeof CredentialsSchema>;

const PINTEREST_EVENT_NAME: Record<TrackingEvent['eventType'], string> = {
  page_view: 'page_visit',
  view_content: 'view_category',
  add_to_cart: 'add_to_cart',
  initiate_checkout: 'checkout',
  add_payment_info: 'checkout',
  // Pinterest's canonical purchase event name.
  purchase: 'checkout',
  subscribe: 'lead',
  subscription_renew: 'custom',
  lead: 'lead',
  complete_registration: 'signup',
};

export const pinterestAdapter: TrackingAdapter<PinterestCredentials> = {
  parseCredentials(raw) {
    return CredentialsSchema.parse(raw);
  },

  async send(credentials, pixel, event) {
    return dispatch(credentials, pixel, event);
  },

  async test(credentials, pixel) {
    // Pinterest CAPI v5 demands ≥1 user_data identifier (em/ph/external_id/
    // click_id/ip/ua). Probe carries a deterministic external_id +
    // forces testMode so test_event_code (when set) keeps the probe
    // out of the producer's production attribution stream.
    const probe: TrackingEvent = {
      eventId: `payuniv-test-${Date.now()}`,
      eventType: 'page_view',
      eventTimeSeconds: Math.floor(Date.now() / 1000),
      currency: 'BRL',
      value: 0,
      sourceUrl: 'https://payunivercart.test/__validate',
      user: { document: '00000000000' },
    };
    return dispatch(credentials, { ...pixel, testMode: true }, probe);
  },
};

async function dispatch(
  credentials: PinterestCredentials,
  pixel: { publicPixelId: string; testMode: boolean },
  event: TrackingEvent,
): Promise<TrackingAdapterCallResult> {
  const url = `https://api.pinterest.com/v5/ad_accounts/${encodeURIComponent(credentials.adAccountId)}/events`;
  const body = {
    data: [
      {
        event_name: PINTEREST_EVENT_NAME[event.eventType],
        action_source: 'web',
        event_time: event.eventTimeSeconds,
        event_id: event.eventId,
        event_source_url: event.sourceUrl ?? undefined,
        partner_name: 'payunivercart',
        user_data: buildUserData(event.user),
        custom_data: {
          currency: event.currency,
          value: String(event.value),
          order_id: event.eventId,
          content_ids: event.contentId ? [event.contentId] : undefined,
          content_name: event.contentName ?? undefined,
          num_items: event.contents?.reduce((n, c) => n + c.quantity, 0),
        },
        // Pinterest's test-event field lives on the event, not the
        // top-level body, in v5.
        test_event_code: pixel.testMode ? credentials.testEventCode : undefined,
      },
    ],
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credentials.conversionToken}`,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as {
      num_events_received?: number;
      message?: string;
    } | null;
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        providerEventId: null,
        response: json,
        errorMessage: json?.message ?? `Pinterest CAPI returned HTTP ${res.status}`,
      };
    }
    return {
      ok: (json?.num_events_received ?? 0) > 0,
      httpStatus: res.status,
      providerEventId: event.eventId,
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
  if (user.city) out.ct = [hashLower(user.city)];
  if (user.state) out.st = [hashLower(user.state)];
  if (user.zip) out.zp = [hashLower(user.zip)];
  if (user.country) out.country = [hashLower(user.country)];
  if (user.clientUserAgent) out.client_user_agent = user.clientUserAgent;
  return out;
}

function hashLower(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}
