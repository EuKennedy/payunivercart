import { CryptoError } from './errors';

/**
 * Binary layout of a sealed credential blob written to the
 * `gateway_credentials.credentials_encrypted` column (Postgres `bytea`).
 *
 *   byte 0..1 : magic ASCII bytes `s`, `b`        (0x73 0x62)
 *   byte 2    : major version                     (currently 0x01 = "v1")
 *   byte 3    : minor version reserved            (currently 0x00)
 *   byte 4    : keyId length in bytes (1..63)
 *   byte 5..  : keyId UTF-8 bytes
 *   next 12   : AES-GCM IV (random per encryption)
 *   rest      : ciphertext + 16-byte GCM auth tag (appended by node:crypto)
 *
 * The leading "sb" magic lets the Postgres CHECK (and any greppable
 * forensics) confirm at a glance that the column holds sealed-box data and
 * not, for example, an accidentally-stored JSON string. Bump `versionMajor`
 * if the layout or cipher changes — never reinterpret an existing version.
 */

const MAGIC_0 = 0x73; // 's'
const MAGIC_1 = 0x62; // 'b'
const VERSION_MAJOR = 0x01;
const VERSION_MINOR = 0x00;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_FIXED = 5; // magic(2) + version(2) + keyIdLen(1)
const MIN_BLOB_SIZE = HEADER_FIXED + 1 /* keyId */ + IV_LENGTH + TAG_LENGTH;
const MAX_KEY_ID_LENGTH = 63;

export const SEALED_BLOB_VERSION = 'v1' as const;
export type SealedBlobVersion = typeof SEALED_BLOB_VERSION;

export interface ParsedBlob {
  keyId: string;
  version: SealedBlobVersion;
  iv: Uint8Array;
  ciphertextWithTag: Uint8Array;
}

export function encodeBlob(
  keyId: string,
  iv: Uint8Array,
  ciphertextWithTag: Uint8Array,
): Uint8Array {
  if (iv.length !== IV_LENGTH) {
    throw new CryptoError('DECRYPT_FAILED', `IV must be ${IV_LENGTH} bytes, got ${iv.length}`);
  }
  if (ciphertextWithTag.length < TAG_LENGTH) {
    throw new CryptoError('BLOB_TOO_SHORT', `ciphertext+tag must be at least ${TAG_LENGTH} bytes`);
  }
  const keyIdBytes = new TextEncoder().encode(keyId);
  if (keyIdBytes.length === 0 || keyIdBytes.length > MAX_KEY_ID_LENGTH) {
    throw new CryptoError(
      'BAD_KEY_ID',
      `keyId must be 1..${MAX_KEY_ID_LENGTH} UTF-8 bytes (got ${keyIdBytes.length})`,
    );
  }

  const total = HEADER_FIXED + keyIdBytes.length + IV_LENGTH + ciphertextWithTag.length;
  const out = new Uint8Array(total);
  let offset = 0;
  out[offset++] = MAGIC_0;
  out[offset++] = MAGIC_1;
  out[offset++] = VERSION_MAJOR;
  out[offset++] = VERSION_MINOR;
  out[offset++] = keyIdBytes.length;
  out.set(keyIdBytes, offset);
  offset += keyIdBytes.length;
  out.set(iv, offset);
  offset += IV_LENGTH;
  out.set(ciphertextWithTag, offset);
  return out;
}

export function decodeBlob(blob: Uint8Array): ParsedBlob {
  if (blob.length < MIN_BLOB_SIZE) {
    throw new CryptoError(
      'BLOB_TOO_SHORT',
      `sealed blob must be at least ${MIN_BLOB_SIZE} bytes (got ${blob.length})`,
    );
  }
  if (blob[0] !== MAGIC_0 || blob[1] !== MAGIC_1) {
    throw new CryptoError('BAD_MAGIC', 'sealed blob missing "sb" magic prefix');
  }
  const major = blob[2];
  const minor = blob[3];
  if (major !== VERSION_MAJOR || minor !== VERSION_MINOR) {
    throw new CryptoError(
      'UNSUPPORTED_VERSION',
      `unsupported sealed blob version ${major}.${minor}`,
    );
  }
  const keyIdLen = blob[4] ?? 0;
  if (keyIdLen === 0 || keyIdLen > MAX_KEY_ID_LENGTH) {
    throw new CryptoError('BAD_KEY_ID', `invalid keyId length ${keyIdLen}`);
  }
  const keyIdEnd = HEADER_FIXED + keyIdLen;
  const ivEnd = keyIdEnd + IV_LENGTH;
  if (blob.length < ivEnd + TAG_LENGTH) {
    throw new CryptoError('BLOB_TOO_SHORT', 'sealed blob truncated before ciphertext');
  }
  const keyId = new TextDecoder('utf-8', { fatal: true }).decode(
    blob.subarray(HEADER_FIXED, keyIdEnd),
  );
  const iv = blob.subarray(keyIdEnd, ivEnd);
  const ciphertextWithTag = blob.subarray(ivEnd);
  return {
    keyId,
    version: SEALED_BLOB_VERSION,
    iv,
    ciphertextWithTag,
  };
}

/** Byte sizes used by callers (e.g. tests that synthesize blobs). */
export const BLOB_CONSTANTS = {
  MAGIC: [MAGIC_0, MAGIC_1] as const,
  VERSION_MAJOR,
  VERSION_MINOR,
  IV_LENGTH,
  TAG_LENGTH,
  HEADER_FIXED,
  MIN_BLOB_SIZE,
  MAX_KEY_ID_LENGTH,
};
