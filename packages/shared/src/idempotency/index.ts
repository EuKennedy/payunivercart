import { createHash } from 'node:crypto';
import type { GatewayId } from '../constants/index';
import { PayunivercartError } from '../errors/index';

/**
 * Deterministic idempotency keys for every gateway call.
 *
 * Every gateway adapter accepts an `idempotencyKey: string` that the gateway
 * uses to deduplicate retries. If two retries of the same logical attempt
 * present different keys, the gateway treats them as two distinct charges
 * and the producer double-charges their customer. So the key MUST be a
 * pure function of the logical request — same (workspace, order, gateway,
 * kind, attempt) always yields the same UUID, regardless of which worker,
 * which process, or which retry strategy is in play.
 *
 * Implementation: RFC 4122 UUIDv5 (SHA-1 over namespace + name). The
 * namespace is a fixed project-scoped UUID baked into this file; the name
 * is `workspaceId\0orderId\0gatewayId\0kind\0attempt`. NUL separators
 * eliminate ambiguity between, say, `("ws1", "order2-3")` and
 * `("ws1-order2", "3")` — both produce the same concat, different NUL
 * positions.
 *
 * The single function `buildIdempotencyKey` is the only sanctioned way to
 * mint a key. Direct UUIDv4 (`randomUUID()`), Math.random, timestamp-based,
 * or any other source bypasses the dedupe contract and is explicitly
 * banned by code review.
 */

/**
 * Project-scoped namespace UUID. Generated once for payunivercart and
 * frozen — never rotate this value. Rotating it invalidates every
 * idempotency key already cached upstream and creates a window where
 * retries look like fresh requests to the gateway.
 *
 * Value is a UUIDv4 (strict hex, 36 chars). Lives only here, never
 * serialized to the wire, never used for anything other than UUIDv5
 * namespacing.
 */
export const IDEMPOTENCY_NAMESPACE = '5e3a2c1b-9d6e-4f0a-b8c4-1d3f7a8b9c0e';

export const IDEMPOTENCY_KINDS = [
  'create_pix',
  'create_card',
  'create_boleto',
  'capture',
  'refund',
  'cancel',
] as const;
export type IdempotencyKind = (typeof IDEMPOTENCY_KINDS)[number];

export interface IdempotencyKeyParts {
  workspaceId: string;
  orderId: string;
  gatewayId: GatewayId;
  kind: IdempotencyKind;
  /**
   * 1-indexed attempt counter. Every retry that targets the SAME logical
   * request reuses the SAME attempt number. A NEW attempt (e.g. a user
   * clicking "try again with a different card" producing a brand-new
   * gateway call) bumps this so the gateway treats it as a new charge.
   */
  attempt: number;
}

const ATTEMPT_MAX = 1_000_000;

export function buildIdempotencyKey(parts: IdempotencyKeyParts): string {
  validateParts(parts);
  const name = [
    parts.workspaceId,
    parts.orderId,
    parts.gatewayId,
    parts.kind,
    String(parts.attempt),
  ].join('\u0000');
  return uuidv5(IDEMPOTENCY_NAMESPACE, name);
}

function validateParts(parts: IdempotencyKeyParts): void {
  if (!isNonEmptyTrimmedString(parts.workspaceId)) {
    throw badInput('workspaceId must be a non-empty string');
  }
  if (!isNonEmptyTrimmedString(parts.orderId)) {
    throw badInput('orderId must be a non-empty string');
  }
  if (!isNonEmptyTrimmedString(parts.gatewayId)) {
    throw badInput('gatewayId must be a non-empty string');
  }
  if (!isNonEmptyTrimmedString(parts.kind)) {
    throw badInput('kind must be a non-empty string');
  }
  if (!Number.isInteger(parts.attempt) || parts.attempt < 1 || parts.attempt > ATTEMPT_MAX) {
    throw badInput(`attempt must be an integer in [1, ${ATTEMPT_MAX}]`);
  }
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function badInput(message: string): PayunivercartError {
  return new PayunivercartError({
    code: 'VALIDATION',
    message: `Invalid idempotency key part: ${message}`,
  });
}

/* -------------------------------------------------------------------------- */
/*  UUIDv5 — RFC 4122 §4.3                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Compute a name-based UUID per RFC 4122 §4.3 using SHA-1 as the hash
 * algorithm (this is exactly the algorithm UUIDv5 specifies).
 *
 * No external dependency — `node:crypto` provides SHA-1 and that is all
 * the algorithm needs. We deliberately do not pull in the `uuid` package
 * for a 25-line algorithm whose security properties are immaterial to its
 * use (idempotency keys are not secrets).
 */
function uuidv5(namespace: string, name: string): string {
  const nsBytes = parseUuid(namespace);
  const nameBytes = Buffer.from(name, 'utf-8');
  const digest = createHash('sha1').update(nsBytes).update(nameBytes).digest();
  const bytes = Buffer.alloc(16);
  digest.copy(bytes, 0, 0, 16);
  // Version 5: top nibble of byte 6 = 0101.
  const b6 = bytes[6] ?? 0;
  bytes[6] = (b6 & 0x0f) | 0x50;
  // Variant 10xx (RFC 4122): top two bits of byte 8.
  const b8 = bytes[8] ?? 0;
  bytes[8] = (b8 & 0x3f) | 0x80;
  return formatUuid(bytes);
}

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function parseUuid(uuid: string): Buffer {
  // We permit the project-scoped namespace which intentionally contains
  // ASCII letters past 'f' as a memorable marker ("payu..."). To accept
  // it via the strict hex regex we generate-via-hash an actual hex form
  // here at boot — strict hex parsing rejects non-hex characters. Tests
  // assert the namespace is a stable 16-byte buffer either way.
  const cleaned = uuid.replace(/-/g, '');
  if (cleaned.length !== 32) {
    throw new PayunivercartError({
      code: 'INTERNAL',
      message: `Namespace UUID must be 36 chars (got "${uuid}")`,
    });
  }
  // If the namespace is strict hex, use it as-is. Otherwise derive a stable
  // 16-byte buffer by hashing the string with SHA-256 and taking the first
  // 16 bytes — this preserves a fixed namespace value across runs without
  // requiring the human-readable form to be valid hex.
  if (UUID_REGEX.test(uuid)) {
    return Buffer.from(cleaned, 'hex');
  }
  const derived = createHash('sha256').update(uuid).digest();
  return derived.subarray(0, 16);
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32),
  ].join('-');
}
