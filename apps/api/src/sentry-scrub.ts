import type { ErrorEvent } from '@sentry/node';

/**
 * Sentry PII scrubber — LGPD compliance.
 *
 * Walks every reachable corner of a Sentry event (request body,
 * breadcrumbs, extra, contexts, user, exception messages) and:
 *
 *   1. Drops keys whose name matches `SENSITIVE_KEYS` (tokens,
 *      passwords, authorization headers, raw credit cards).
 *   2. Replaces matched PII patterns (email, BR phone, CPF, CNPJ)
 *      inside any leftover string with `[REDACTED]`.
 *
 * The walker is depth-limited (`MAX_DEPTH`) so a cyclic object never
 * stalls Sentry's request hook.
 */

const REDACT = '[REDACTED]';
const FILTERED = '[Filtered]';
const MAX_DEPTH = 5;

const SENSITIVE_KEYS = new Set([
  'password',
  'newpassword',
  'oldpassword',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'apikey',
  'api_key',
  'secret',
  'jwtsecret',
  'webhooksecret',
  'authorization',
  'cookie',
  'set-cookie',
  'creditcard',
  'cardnumber',
  'cvc',
  'cvv',
  'cpf',
  'cnpj',
  'rg',
  'ssn',
  'pan',
]);

const PII_PATTERNS: [RegExp, string][] = [
  // Email
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, REDACT],
  // BR phone (with or without country code + optional 9)
  [/\b\+?55?\s?\(?\d{2}\)?\s?9?\d{4}-?\d{4}\b/g, REDACT],
  // CPF
  [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, REDACT],
  // CNPJ
  [/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, REDACT],
  // Generic 13-19 digit card number (cards never appear server-side after
  // tokenization, but defence-in-depth).
  [/\b\d{13,19}\b/g, REDACT],
];

export function redactString(s: string): string {
  return PII_PATTERNS.reduce((acc, [pat, rep]) => acc.replace(pat, rep), s);
}

export function scrubObject(obj: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactString(obj);
  if (Array.isArray(obj)) return obj.map((item) => scrubObject(item, depth + 1));
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = FILTERED;
      } else {
        out[k] = scrubObject(v, depth + 1);
      }
    }
    return out;
  }
  return obj;
}

/**
 * Drop-in `beforeSend` for `Sentry.init({...})`. Returns the scrubbed
 * event or null to drop entirely. Currently never drops — always
 * returns the scrubbed version.
 */
export function sentryBeforeSend(event: ErrorEvent): ErrorEvent {
  if (event.request?.headers) {
    const h = event.request.headers as Record<string, string>;
    for (const k of ['cookie', 'authorization', 'x-api-key', 'x-auth-token']) {
      if (k in h) delete h[k];
    }
  }
  if (event.request) {
    const req = event.request;
    if (req.data !== undefined) {
      req.data = scrubObject(req.data) as typeof req.data;
    }
    const qs = req.query_string;
    if (typeof qs === 'string') req.query_string = redactString(qs);
  }
  if (event.message) {
    event.message = redactString(event.message);
  }
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) ex.value = redactString(ex.value);
    }
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((b) => {
      if (b.data) b.data = scrubObject(b.data) as typeof b.data;
      if (b.message) b.message = redactString(b.message);
      return b;
    });
  }
  if (event.extra) {
    event.extra = scrubObject(event.extra) as typeof event.extra;
  }
  if (event.contexts) {
    event.contexts = scrubObject(event.contexts) as typeof event.contexts;
  }
  if (event.user) {
    event.user.email = undefined;
    event.user.username = undefined;
    event.user.ip_address = undefined;
  }
  return event;
}
