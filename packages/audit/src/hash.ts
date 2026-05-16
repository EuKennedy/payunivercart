import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuditError } from './errors';

/**
 * HMAC-SHA256 over the chain input. The chain input is:
 *
 *     previousHashHex ⌐ canonical(payload)
 *
 * where `⌐` is the literal byte `0x1f` (ASCII "Unit Separator"), an
 * unambiguous boundary that cannot appear inside the hex digest or inside
 * canonical JSON. This prevents extension attacks where a malicious payload
 * tries to embed the boundary character to alter chain semantics.
 *
 * Genesis row (no predecessor) uses the empty string as `previousHashHex`.
 * The boundary byte is still emitted, so the genesis input is
 * `0x1f || canonical(payload)` — never equal to a continuation row's
 * input regardless of payload.
 */

const REQUIRED_KEY_BYTES = 32;
const BOUNDARY = 0x1f;
const BOUNDARY_BUFFER = Buffer.of(BOUNDARY);

export function computeChainHash(
  key: Uint8Array,
  previousHashHex: string | null,
  canonicalPayload: string,
): string {
  assertKey(key);
  const hmac = createHmac('sha256', key);
  if (previousHashHex !== null) {
    hmac.update(previousHashHex, 'utf8');
  }
  hmac.update(BOUNDARY_BUFFER);
  hmac.update(canonicalPayload, 'utf8');
  return hmac.digest('hex');
}

/**
 * Constant-time hex comparison of two hashes. Used by the chain verifier
 * so a tampered chain cannot reveal the location of the mismatch via
 * timing.
 */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function assertKey(key: Uint8Array): void {
  if (key.length !== REQUIRED_KEY_BYTES) {
    throw new AuditError(
      'KEY_WRONG_LENGTH',
      `audit HMAC key must be ${REQUIRED_KEY_BYTES} bytes (got ${key.length})`,
    );
  }
}
