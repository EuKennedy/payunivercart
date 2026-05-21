import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

/**
 * API-key + webhook-secret + JWT-secret minting + verification.
 *
 * Naming conventions (Stripe-style):
 *   - Publishable key   : pk_test_*  / pk_live_*    (32 chars random body)
 *   - Secret key        : sk_test_*  / sk_live_*    (32 chars random body)
 *   - Webhook secret    : whsec_*                   (32 chars, single mode)
 *   - JWT signing secret: jwtsec_*                  (32 chars, single mode)
 *
 * We hand back cleartext exactly once at creation time, then store the
 * bcrypt hash. The `prefix` (first 12 chars) is kept in plain text so
 * the dashboard can show `sk_live_AbCd` without breaking secrecy.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomBody(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    // Bias is negligible at 57 alphabet symbols vs 256 byte values for
    // a 32-char body; the keys are HMAC-grade, not lottery numbers.
    const byte = bytes[i] as number;
    const ch = ALPHABET[byte % ALPHABET.length] as string;
    out += ch;
  }
  return out;
}

export type KeyKind = 'publishable' | 'secret';
export type KeyMode = 'test' | 'live';

export interface MintedApiKey {
  /** Full cleartext (`sk_test_xxxxxxxx...`). Show user ONCE. */
  cleartext: string;
  /** First 12 chars, safe to display indefinitely. */
  prefix: string;
  /** bcrypt hash — store this in `partner_api_keys.hash`. */
  hash: string;
}

export function mintApiKey(kind: KeyKind, mode: KeyMode): MintedApiKey {
  const prefixToken = kind === 'publishable' ? 'pk' : 'sk';
  const body = randomBody(32);
  const cleartext = `${prefixToken}_${mode}_${body}`;
  const prefix = cleartext.slice(0, 12);
  const hash = bcrypt.hashSync(cleartext, 12);
  return { cleartext, prefix, hash };
}

export function mintWebhookSecret(): string {
  return `whsec_${randomBody(32)}`;
}

export function mintJwtSecret(): string {
  return `jwtsec_${randomBody(32)}`;
}

/**
 * Verify a cleartext API key against a stored bcrypt hash.
 * Returns `true` if the key matches and was minted with the expected
 * kind/mode prefix.
 */
export function verifyApiKey(
  cleartext: string,
  hash: string,
  expected: { kind: KeyKind; mode: KeyMode },
): boolean {
  const prefixToken = expected.kind === 'publishable' ? 'pk' : 'sk';
  const expectedPrefix = `${prefixToken}_${expected.mode}_`;
  if (!cleartext.startsWith(expectedPrefix)) return false;
  return bcrypt.compareSync(cleartext, hash);
}

/**
 * Lightweight parser to extract (kind, mode) from a cleartext key
 * without touching the hash. Useful for routing the lookup to the
 * right table partition / cache shard before the bcrypt cost is paid.
 */
export function parseApiKey(cleartext: string): { kind: KeyKind; mode: KeyMode } | null {
  const match = cleartext.match(/^(pk|sk)_(test|live)_/);
  if (!match) return null;
  return {
    kind: match[1] === 'pk' ? 'publishable' : 'secret',
    mode: match[2] as KeyMode,
  };
}
