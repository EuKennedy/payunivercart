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
} from './types.js';

export interface WahaClientConfig {
  baseUrl: string;
  apiKey: string;
  defaultSession?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class WahaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultSession: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: WahaClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.defaultSession = config.defaultSession ?? 'default';
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  /**
   * Resolve the actual WhatsApp chatId for a phone number.
   * Critical for BR pre-2012 accounts where the trailing "9" must be stripped.
   */
  async checkExists(phoneDigits: string, session = this.defaultSession): Promise<WahaCheckExistsResponse> {
    const url = `${this.baseUrl}/api/contacts/check-exists?phone=${encodeURIComponent(phoneDigits)}&session=${encodeURIComponent(session)}`;
    const response = await this.request(url, { method: 'GET' });
    const data = (await response.json()) as unknown;
    return wahaCheckExistsResponseSchema.parse(data);
  }

  async sendText(input: WahaSendTextInput): Promise<WahaSendTextResponse> {
    const parsed = wahaSendTextInputSchema.parse(input);
    const response = await this.request(`${this.baseUrl}/api/sendText`, {
      method: 'POST',
      body: JSON.stringify(parsed),
    });
    const data = (await response.json()) as unknown;
    return wahaSendTextResponseSchema.parse(data);
  }

  async getSessionStatus(session = this.defaultSession): Promise<WahaSessionStatus> {
    const response = await this.request(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(session)}`,
      { method: 'GET' },
    );
    const data = (await response.json()) as { status?: string };
    return wahaSessionStatusSchema.parse(data.status);
  }

  async startSession(session = this.defaultSession): Promise<void> {
    await this.request(`${this.baseUrl}/api/sessions/${encodeURIComponent(session)}/start`, {
      method: 'POST',
    });
  }

  async stopSession(session = this.defaultSession): Promise<void> {
    await this.request(`${this.baseUrl}/api/sessions/${encodeURIComponent(session)}/stop`, {
      method: 'POST',
    });
  }

  async getQr(session = this.defaultSession): Promise<{ value: string; mimetype?: string }> {
    const response = await this.request(
      `${this.baseUrl}/api/${encodeURIComponent(session)}/auth/qr?format=image`,
      { method: 'GET' },
    );
    return (await response.json()) as { value: string; mimetype?: string };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: {
          'X-Api-Key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await safeReadBody(response);
        throw new PayunivercartError({
          code: response.status === 401 ? 'GATEWAY_INVALID_CREDENTIALS' : 'GATEWAY_ERROR',
          message: `WAHA request failed with ${response.status}`,
          httpStatus: 502,
          details: { url, status: response.status, body },
        });
      }

      return response;
    } catch (cause) {
      if (cause instanceof PayunivercartError) throw cause;
      throw new PayunivercartError({
        code: 'GATEWAY_UNAVAILABLE',
        message: 'WAHA upstream unreachable',
        cause,
        httpStatus: 503,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
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
