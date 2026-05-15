import { CryptoError } from './errors.js';

/**
 * KEK store. Each entry maps an opaque `keyId` (small ASCII string, e.g.
 * `v1`, `v2`, `prod-2026-q2`) to a 32-byte AES-256 key.
 *
 * The registry is read-only at runtime; rotation = restart with a new env
 * value that includes both the old and new entries, then re-encrypt rows
 * to the new keyId on read, then drop the old entry on the following
 * deploy. The registry never serializes the key material.
 */
export interface KeyRegistry {
  /** Returns the 32-byte key for the given keyId or `undefined` if absent. */
  get(keyId: string): Uint8Array | undefined;
  /** All keyIds known to this registry. Stable order (insertion). */
  list(): readonly string[];
  /** The keyId new writes should use. */
  activeKeyId(): string;
}

const REQUIRED_KEY_BYTES = 32;

/**
 * Build a KeyRegistry from `{ keyId -> base64 key }` pairs. Validates each
 * key is exactly 32 bytes; rejects empty maps; first key becomes active
 * unless `activeKeyId` is supplied.
 */
export function createKeyRegistry(
  entries: Record<string, string>,
  activeKeyId?: string,
): KeyRegistry {
  const decoded = new Map<string, Uint8Array>();
  for (const [keyId, b64] of Object.entries(entries)) {
    if (!keyId || keyId.length > 63) {
      throw new CryptoError('BAD_KEY_ID', `keyId must be 1..63 chars: "${keyId}"`);
    }
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
    } catch (cause) {
      throw new CryptoError('ENV_MALFORMED', `key "${keyId}" is not valid base64`, cause);
    }
    if (bytes.length !== REQUIRED_KEY_BYTES) {
      throw new CryptoError(
        'KEY_WRONG_LENGTH',
        `key "${keyId}" must decode to ${REQUIRED_KEY_BYTES} bytes (got ${bytes.length})`,
      );
    }
    decoded.set(keyId, bytes);
  }
  if (decoded.size === 0) {
    throw new CryptoError('ENV_MALFORMED', 'KeyRegistry requires at least one key');
  }

  const insertionOrder = Array.from(decoded.keys());
  const firstKey = insertionOrder[0];
  if (firstKey === undefined) {
    // Unreachable — `decoded.size === 0` is caught above. The assignment is
    // here so the type system can see `active` is a `string`.
    throw new CryptoError('ENV_MALFORMED', 'KeyRegistry requires at least one key');
  }
  const active = activeKeyId ?? firstKey;
  if (!decoded.has(active)) {
    throw new CryptoError(
      'KEY_NOT_FOUND',
      `activeKeyId "${active}" is not present in the registry`,
    );
  }

  return {
    get: (keyId) => decoded.get(keyId),
    list: () => insertionOrder,
    activeKeyId: () => active,
  };
}

/**
 * Parses the `ENCRYPTION_KEYS` env value. Format:
 *
 *     <keyId>:<base64>[,<keyId>:<base64>]...
 *
 * Optionally an `ENCRYPTION_ACTIVE_KEY_ID` env var selects which keyId new
 * writes use; defaults to the first entry. Both env vars are read by name
 * so callers can wire alternate names (e.g. `AUDIT_KEYS`).
 *
 * Throws `CryptoError('ENV_MALFORMED' | 'KEY_WRONG_LENGTH')` so a misconfig
 * fails the app boot loudly instead of silently writing garbage.
 */
export function loadKeyRegistryFromEnv(opts: {
  keysEnv: string | undefined;
  activeKeyIdEnv?: string | undefined;
  envVarName?: string;
}): KeyRegistry {
  const { keysEnv, activeKeyIdEnv } = opts;
  const envName = opts.envVarName ?? 'ENCRYPTION_KEYS';
  if (!keysEnv || keysEnv.trim() === '') {
    throw new CryptoError('ENV_MALFORMED', `${envName} is empty or not set`);
  }
  const entries: Record<string, string> = {};
  for (const raw of keysEnv.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const colon = part.indexOf(':');
    if (colon <= 0 || colon === part.length - 1) {
      throw new CryptoError('ENV_MALFORMED', `${envName} entry "${part}" must be "keyId:base64"`);
    }
    const keyId = part.slice(0, colon).trim();
    const b64 = part.slice(colon + 1).trim();
    if (entries[keyId] !== undefined) {
      throw new CryptoError('ENV_MALFORMED', `${envName} contains duplicate keyId "${keyId}"`);
    }
    entries[keyId] = b64;
  }
  return createKeyRegistry(entries, activeKeyIdEnv);
}
