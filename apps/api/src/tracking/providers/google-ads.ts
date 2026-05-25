import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  TrackingAdapter,
  TrackingAdapterCallResult,
  TrackingEvent,
  TrackingUserContext,
} from '../types';

/**
 * Google Ads Enhanced Conversions for Web (server-side).
 *
 * Endpoint:
 *   POST https://googleads.googleapis.com/v18/customers/{customer_id}:uploadClickConversions
 *
 * Auth: OAuth 2.0 access token derived from a long-lived refresh
 * token + developer token header. We exchange refresh → access per
 * call (Google's spec); access tokens live ~1h but the cost of
 * caching them across worker ticks is not worth the complexity for
 * v1 — we re-mint on every dispatch.
 *
 * Identity model: Google's "enhanced conversions" require either:
 *   - a `gclid` (Google Click ID) captured from the landing URL, OR
 *   - sha256-hashed user identifiers (email/phone) so Google can
 *     match against signed-in Google accounts.
 *
 * We send BOTH when present (most-restrictive match wins).
 */

const CredentialsSchema = z.object({
  /** Google Ads customer id — 10-digit no dashes (e.g. 1234567890). */
  customerId: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'Customer ID: 10 dígitos sem hífen.'),
  /** Conversion action resource name segment, e.g. `123456789`. */
  conversionActionId: z
    .string()
    .trim()
    .regex(/^\d{6,12}$/),
  /** Long-lived OAuth 2.0 refresh token issued by Google. */
  oauthRefreshToken: z.string().trim().min(40).max(512),
  /** OAuth 2.0 client id of the producer's Google Cloud project. */
  oauthClientId: z.string().trim().min(20).max(160),
  /** OAuth 2.0 client secret. */
  oauthClientSecret: z.string().trim().min(20).max(160),
  /** Google Ads developer token from your MCC / standard account. */
  developerToken: z.string().trim().min(10).max(60),
  /** Optional — login customer id when accessing through an MCC. */
  loginCustomerId: z
    .string()
    .trim()
    .regex(/^\d{10}$/)
    .optional(),
});

export type GoogleAdsCredentials = z.infer<typeof CredentialsSchema>;

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ADS_API_BASE = 'https://googleads.googleapis.com/v18';

export const googleAdsAdapter: TrackingAdapter<GoogleAdsCredentials> = {
  parseCredentials(raw) {
    return CredentialsSchema.parse(raw);
  },

  async send(credentials, pixel, event) {
    return dispatch(credentials, pixel, event);
  },

  async test(credentials, pixel) {
    // Unused param kept so the adapter signature stays stable across
    // providers; OAuth exchange itself is the cheapest health probe.
    void pixel;
    // Cheapest sanity check: exchange refresh→access. If that works,
    // creds are valid; if not, we surface the OAuth error directly.
    try {
      await mintAccessToken(credentials);
      return {
        ok: true,
        httpStatus: 200,
        providerEventId: `gads-test-${Date.now()}`,
        response: { validated: 'oauth_exchange_ok' },
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
  },
};

async function dispatch(
  credentials: GoogleAdsCredentials,
  _pixel: { publicPixelId: string; testMode: boolean },
  event: TrackingEvent,
): Promise<TrackingAdapterCallResult> {
  try {
    const accessToken = await mintAccessToken(credentials);
    const url = `${ADS_API_BASE}/customers/${credentials.customerId}:uploadClickConversions`;
    const body = {
      conversions: [
        {
          conversionAction: `customers/${credentials.customerId}/conversionActions/${credentials.conversionActionId}`,
          conversionDateTime: formatConversionDateTime(event.eventTimeSeconds),
          conversionValue: event.value,
          currencyCode: event.currency,
          orderId: event.eventId,
          gclid: event.user.gclid ?? undefined,
          userIdentifiers: buildUserIdentifiers(event.user),
        },
      ],
      partialFailure: true,
      validateOnly: false,
    };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      'developer-token': credentials.developerToken,
    };
    if (credentials.loginCustomerId) {
      headers['login-customer-id'] = credentials.loginCustomerId;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as {
      results?: unknown[];
      partialFailureError?: { message?: string };
    } | null;
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        providerEventId: null,
        response: json,
        errorMessage:
          (json as { error?: { message?: string } } | null)?.error?.message ??
          `Google Ads returned HTTP ${res.status}`,
      };
    }
    const partial = json?.partialFailureError?.message;
    if (partial) {
      return {
        ok: false,
        httpStatus: res.status,
        providerEventId: null,
        response: json,
        errorMessage: `Google Ads partialFailureError: ${partial}`,
      };
    }
    return {
      ok: (json?.results?.length ?? 0) > 0,
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

/**
 * Exchange the producer's stored refresh token for a short-lived
 * access token. Google's `oauth2.googleapis.com/token` endpoint is
 * the canonical path; client_id + client_secret + refresh_token go
 * in the form body.
 */
async function mintAccessToken(credentials: GoogleAdsCredentials): Promise<string> {
  const params = new URLSearchParams({
    client_id: credentials.oauthClientId,
    client_secret: credentials.oauthClientSecret,
    refresh_token: credentials.oauthRefreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const json = (await res.json().catch(() => null)) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  } | null;
  if (!res.ok || !json?.access_token) {
    throw new Error(
      json?.error_description ?? json?.error ?? `OAuth exchange failed (HTTP ${res.status})`,
    );
  }
  return json.access_token;
}

/**
 * Google Ads Enhanced Conversions identifier list. Email + phone get
 * sha256 hashed normalized form per spec; address fields go in raw
 * (Google hashes server-side).
 */
function buildUserIdentifiers(user: TrackingUserContext): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (user.email) out.push({ hashedEmail: hashLower(user.email) });
  if (user.phoneE164) {
    out.push({ hashedPhoneNumber: hashLower(user.phoneE164.replace(/\D/g, '')) });
  }
  if (user.name && (user.city || user.zip || user.country)) {
    const [first, ...rest] = user.name.trim().split(/\s+/);
    out.push({
      addressInfo: {
        hashedFirstName: first ? hashLower(first) : undefined,
        hashedLastName: rest.length ? hashLower(rest.join(' ')) : undefined,
        city: user.city ?? undefined,
        state: user.state ?? undefined,
        postalCode: user.zip ?? undefined,
        countryCode: user.country ?? undefined,
      },
    });
  }
  return out;
}

/**
 * Google Ads conversionDateTime format:
 *   `yyyy-MM-dd HH:mm:ss+HH:MM` (TIMEZONE OFFSET REQUIRED)
 * We always emit UTC.
 */
function formatConversionDateTime(eventTimeSeconds: number): string {
  const d = new Date(eventTimeSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`;
}

function hashLower(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}
