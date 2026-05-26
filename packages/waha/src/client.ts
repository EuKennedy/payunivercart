import { PayunivercartError } from '@payunivercart/shared';
import {
  type WahaCheckExistsResponse,
  type WahaSendTextInput,
  type WahaSendTextResponse,
  type WahaSessionStatus,
  wahaCheckExistsResponseSchema,
  wahaSendTextInputSchema,
  wahaSendTextResponseSchema,
  wahaSessionStatusSchema,
} from './types';

/**
 * WAHA HTTP client with hardening (Bloco 5):
 *
 *   - Constructor validates `baseUrl` is well-formed AND uses `http:`/`https:`
 *     so a misconfigured env can't redirect the API key to a `file://`
 *     or `gopher://` target (SSRF / credential exfil).
 *   - Per-method timeout overrides. `checkExists` is on the checkout hot
 *     path; defaulting to 15s would block customer-facing requests during
 *     a WAHA outage. We use 5s there and 15s for everything else.
 *   - HTTP error mapping separates 4xx (client error, caller bug or bad
 *     creds) from 5xx + 429 (upstream issue, retryable). Previously every
 *     non-200 became `GATEWAY_ERROR` with `httpStatus: 502`, which made
 *     retries amplify whatever was actually a 422 from us.
 */

export interface WahaClientConfig {
  baseUrl: string;
  apiKey: string;
  defaultSession?: string;
  fetchImpl?: typeof fetch;
  /** Default per-request timeout. Individual methods override; see TIMEOUTS_MS. */
  timeoutMs?: number;
}

interface RequestOptions {
  url: string;
  init: RequestInit;
  /** Override `timeoutMs` for this call. Smaller for hot-path reads. */
  timeoutMs?: number;
}

const TIMEOUTS_MS = {
  /** Hot path on checkout. WAHA `check-exists` is fast on a healthy session. */
  checkExists: 5_000,
  /** Background send (OTP, recovery). Tolerates slow WAHA. */
  sendText: 15_000,
  /** Admin/diagnostic reads. */
  session: 5_000,
  /** Admin write (start/stop). */
  sessionWrite: 15_000,
  /** QR fetch — WAHA can take a few seconds to render the PNG. */
  qr: 10_000,
} as const;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export class WahaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultSession: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;

  constructor(config: WahaClientConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiKey = config.apiKey;
    this.defaultSession = config.defaultSession ?? 'default';
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.defaultTimeoutMs = config.timeoutMs ?? 15_000;
  }

  /**
   * Resolve the actual WhatsApp chatId for a phone number.
   * Critical for BR pre-2012 accounts where the trailing "9" must be stripped.
   */
  async checkExists(
    phoneDigits: string,
    session = this.defaultSession,
  ): Promise<WahaCheckExistsResponse> {
    const url = `${this.baseUrl}/api/contacts/check-exists?phone=${encodeURIComponent(phoneDigits)}&session=${encodeURIComponent(session)}`;
    const response = await this.request({
      url,
      init: { method: 'GET' },
      timeoutMs: TIMEOUTS_MS.checkExists,
    });
    const data = (await response.json()) as unknown;
    return wahaCheckExistsResponseSchema.parse(data);
  }

  async sendText(input: WahaSendTextInput): Promise<WahaSendTextResponse> {
    const parsed = wahaSendTextInputSchema.parse(input);
    const response = await this.request({
      url: `${this.baseUrl}/api/sendText`,
      init: { method: 'POST', body: JSON.stringify(parsed) },
      timeoutMs: TIMEOUTS_MS.sendText,
    });
    const data = (await response.json()) as unknown;
    return wahaSendTextResponseSchema.parse(data);
  }

  /**
   * Send-with-retry. Built for the recovery worker + webhook fan-out
   * paths where a single transient WAHA blip should not silently drop
   * a notification.
   *
   * Retries only on errors flagged `retryable: true` in the
   * `PayunivercartError.details` — i.e. 5xx, 429, and network/timeout.
   * 4xx errors (bad chatId, malformed body, invalid session) skip retry
   * because re-sending an identical bad request can't recover.
   *
   * Backoff: 500ms → 2s → 8s. Total budget ≤ 26s (3 attempts × 15s
   * sendText timeout + 10.5s sleep). Single retry layer for the entire
   * codebase so behaviour is consistent regardless of caller.
   *
   * Caveat: WhatsApp's own delivery layer can drop messages even after
   * WAHA returns 200. This helper only guarantees the HTTP send
   * completes — not that the buyer's phone rang. Inspecting WhatsApp
   * delivery acks is a separate feature (and requires a webhook from
   * WAHA back into us).
   */
  async sendTextWithRetry(
    input: WahaSendTextInput,
    options: {
      maxAttempts?: number;
      onAttempt?: (attempt: number, error: unknown) => void;
    } = {},
  ): Promise<WahaSendTextResponse> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    const delays = [500, 2_000, 8_000];
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.sendText(input);
      } catch (cause) {
        lastError = cause;
        if (!isRetryableError(cause) || attempt === maxAttempts) {
          throw cause;
        }
        options.onAttempt?.(attempt, cause);
        const delay = delays[attempt - 1] ?? 8_000;
        await sleep(delay);
      }
    }
    // Unreachable — loop either returns or throws on the last attempt.
    throw lastError;
  }

  async getSessionStatus(session = this.defaultSession): Promise<WahaSessionStatus> {
    const response = await this.request({
      url: `${this.baseUrl}/api/sessions/${encodeURIComponent(session)}`,
      init: { method: 'GET' },
      timeoutMs: TIMEOUTS_MS.session,
    });
    const data = (await response.json()) as { status?: string };
    return wahaSessionStatusSchema.parse(data.status);
  }

  async startSession(session = this.defaultSession): Promise<void> {
    await this.request({
      url: `${this.baseUrl}/api/sessions/${encodeURIComponent(session)}/start`,
      init: { method: 'POST' },
      timeoutMs: TIMEOUTS_MS.sessionWrite,
    });
  }

  /**
   * Create AND auto-start a session in one round-trip. Use this when
   * the session doesn't exist yet (startSession on a missing session
   * returns 404 on WAHA Plus). Idempotent at the API level — calling
   * twice yields 422 which the caller can swallow.
   *
   * `engine` defaults to `WEBJS` because that's what the production
   * WAHA instance runs and it's the most feature-complete engine for
   * BR-default flows (typing indicators, presence, message ack).
   */
  async createSession(
    session = this.defaultSession,
    options: { autoStart?: boolean; engine?: 'WEBJS' | 'NOWEB' | 'GOWS' } = {},
  ): Promise<void> {
    const { autoStart = true, engine = 'WEBJS' } = options;
    await this.request({
      url: `${this.baseUrl}/api/sessions`,
      init: {
        method: 'POST',
        body: JSON.stringify({
          name: session,
          start: autoStart,
          config: { engine },
        }),
      },
      timeoutMs: TIMEOUTS_MS.sessionWrite,
    });
  }

  /**
   * Hard-delete a WAHA session — clears its store, certificates and
   * config. Used by the "Recomeçar" path after a FAILED state so the
   * producer can scan a fresh QR without WAHA returning the stale one.
   * Tolerates 404 silently (caller may not know the session exists).
   */
  async deleteSession(session = this.defaultSession): Promise<void> {
    try {
      await this.request({
        url: `${this.baseUrl}/api/sessions/${encodeURIComponent(session)}`,
        init: { method: 'DELETE' },
        timeoutMs: TIMEOUTS_MS.sessionWrite,
      });
    } catch (cause) {
      const err = cause as { details?: { status?: number } };
      if (err?.details?.status === 404) return;
      throw cause;
    }
  }

  async stopSession(session = this.defaultSession): Promise<void> {
    await this.request({
      url: `${this.baseUrl}/api/sessions/${encodeURIComponent(session)}/stop`,
      init: { method: 'POST' },
      timeoutMs: TIMEOUTS_MS.sessionWrite,
    });
  }

  async getQr(session = this.defaultSession): Promise<{ value: string; mimetype?: string }> {
    // No `?format=image` — that variant returns binary PNG (which the
    // wrapper would corrupt through response.json()). The default
    // response is JSON-encoded base64 image with shape
    // `{ mimetype: 'image/png', data: '<base64>' }` on WAHA NOWEB and
    // `{ value: '<base64>', mimetype: 'image/png' }` on older WPP/
    // WEBJS. We accept either shape and normalize to `value`.
    const response = await this.request({
      url: `${this.baseUrl}/api/${encodeURIComponent(session)}/auth/qr`,
      init: { method: 'GET' },
      timeoutMs: TIMEOUTS_MS.qr,
    });
    const raw = (await response.json()) as {
      value?: string;
      data?: string;
      mimetype?: string;
    };
    const value = raw.value ?? raw.data ?? '';
    return { value, mimetype: raw.mimetype };
  }

  private async request(opts: RequestOptions): Promise<Response> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(opts.url, {
        ...opts.init,
        headers: {
          'X-Api-Key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(opts.init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (cause) {
      throw new PayunivercartError({
        code: 'GATEWAY_UNAVAILABLE',
        message: 'WAHA upstream unreachable',
        cause,
        httpStatus: 503,
        details: { url: opts.url, timeoutMs },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw await mapWahaHttpError(opts.url, response);
    }
    return response;
  }
}

function normalizeBaseUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new PayunivercartError({
      code: 'INTERNAL',
      message: 'WahaClient baseUrl is empty',
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new PayunivercartError({
      code: 'INTERNAL',
      message: `WahaClient baseUrl is not a valid URL: "${raw}"`,
      cause,
    });
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new PayunivercartError({
      code: 'INTERNAL',
      message: `WahaClient baseUrl protocol "${parsed.protocol}" is not allowed (use http: or https:)`,
    });
  }
  // Strip trailing slash so callers concatenate paths predictably.
  return parsed.toString().replace(/\/+$/, '');
}

/**
 * Map a non-2xx WAHA response to a structured `PayunivercartError`.
 *
 * The previous implementation collapsed every 4xx and 5xx into a generic
 * `GATEWAY_ERROR` with `httpStatus: 502`, which (a) misled retry logic into
 * pounding WAHA on what was actually a 4xx caller bug, and (b) made
 * dashboards show 502s in places that were really 4xx.
 */
async function mapWahaHttpError(url: string, response: Response): Promise<PayunivercartError> {
  const body = await safeReadBody(response);
  const status = response.status;

  if (status === 401 || status === 403) {
    return new PayunivercartError({
      code: 'GATEWAY_INVALID_CREDENTIALS',
      message: `WAHA rejected credentials (${status})`,
      httpStatus: 401,
      details: { url, status, body },
    });
  }

  if (status === 429 || status >= 500) {
    return new PayunivercartError({
      code: 'GATEWAY_UNAVAILABLE',
      message: `WAHA upstream error (${status})`,
      httpStatus: 503,
      details: { url, status, body, retryable: true },
    });
  }

  if (status >= 400) {
    return new PayunivercartError({
      code: 'GATEWAY_ERROR',
      message: `WAHA rejected the request (${status})`,
      httpStatus: 400,
      details: { url, status, body, retryable: false },
    });
  }

  return new PayunivercartError({
    code: 'GATEWAY_ERROR',
    message: `Unexpected WAHA response status ${status}`,
    httpStatus: 502,
    details: { url, status, body },
  });
}

async function safeReadBody(response: Response): Promise<unknown> {
  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) return await response.json();
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Decide whether a WAHA error should be retried. Mirrors the contract
 * of `mapWahaHttpError`: 5xx, 429, network errors, and timeouts carry
 * `details.retryable = true` (or are `GATEWAY_UNAVAILABLE`, which is
 * always transient by definition).
 *
 * Exported so callers building their own retry loops (e.g. recovery
 * worker's outer claim/process loop) classify errors identically.
 */
export function isRetryableError(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false;
  const err = cause as { code?: string; details?: { retryable?: boolean } };
  if (err.code === 'GATEWAY_UNAVAILABLE') return true;
  return err.details?.retryable === true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
