import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { type ParsedBlob, decodeBlob, encodeBlob } from './blob.js';
import { CryptoError } from './errors.js';
import type { KeyRegistry } from './registry.js';

/**
 * Symmetric authenticated encryption for credentials at rest.
 *
 * Cipher: AES-256-GCM (12-byte IV, 16-byte tag — NIST SP 800-38D).
 * KEK source: `KeyRegistry`, which keeps multiple key versions live so
 * rotation does not invalidate rows written under the previous key.
 *
 * New writes use the registry's `activeKeyId()`. Reads pick the keyId
 * embedded in the blob — this is the rotation path: switch `activeKeyId`,
 * keep the old key in the registry, re-encrypt rows lazily on next write.
 *
 * The plaintext path also covers JSON objects via `sealJson` / `unsealJson`,
 * with a 64 KiB cap so a misuse cannot pin tens of megabytes of plaintext
 * in `gateway_credentials.credentials_encrypted`.
 */
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const IV_LENGTH = 12;

export interface SealResult {
  blob: Uint8Array;
  keyId: string;
}

export class CryptoService {
  private readonly registry: KeyRegistry;

  constructor(registry: KeyRegistry) {
    this.registry = registry;
  }

  /** Active keyId for new writes. Cached at construction (no surprise rotation mid-request). */
  get activeKeyId(): string {
    return this.registry.activeKeyId();
  }

  seal(plaintext: Uint8Array): SealResult {
    if (plaintext.length > MAX_PLAINTEXT_BYTES) {
      throw new CryptoError(
        'PLAINTEXT_TOO_LARGE',
        `plaintext exceeds ${MAX_PLAINTEXT_BYTES} bytes (got ${plaintext.length})`,
      );
    }
    const keyId = this.activeKeyId;
    const key = this.requireKey(keyId);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const combined = Buffer.concat([ciphertext, tag]);
    return {
      blob: encodeBlob(keyId, iv, combined),
      keyId,
    };
  }

  unseal(blob: Uint8Array): Uint8Array {
    const parsed: ParsedBlob = decodeBlob(blob);
    const key = this.requireKey(parsed.keyId);
    const tagStart = parsed.ciphertextWithTag.length - 16;
    const ciphertext = parsed.ciphertextWithTag.subarray(0, tagStart);
    const tag = parsed.ciphertextWithTag.subarray(tagStart);
    const decipher = createDecipheriv('aes-256-gcm', key, parsed.iv);
    decipher.setAuthTag(tag);
    try {
      return Uint8Array.from(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    } catch (cause) {
      // GCM auth-tag mismatch — either the ciphertext was tampered with, the
      // IV was modified, or the wrong key was used. Whatever the cause, the
      // failure mode is identical and must be opaque to callers.
      throw new CryptoError('DECRYPT_FAILED', 'sealed blob failed authentication', cause);
    }
  }

  sealString(plaintext: string): SealResult {
    return this.seal(new TextEncoder().encode(plaintext));
  }

  unsealString(blob: Uint8Array): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(this.unseal(blob));
  }

  sealJson<T>(value: T): SealResult {
    return this.sealString(JSON.stringify(value));
  }

  unsealJson<T>(blob: Uint8Array): T {
    return JSON.parse(this.unsealString(blob)) as T;
  }

  /** Returns the keyId embedded in `blob` without attempting decryption. */
  inspect(blob: Uint8Array): { keyId: string; version: ParsedBlob['version'] } {
    const parsed = decodeBlob(blob);
    return { keyId: parsed.keyId, version: parsed.version };
  }

  private requireKey(keyId: string): Uint8Array {
    const key = this.registry.get(keyId);
    if (!key) {
      throw new CryptoError('KEY_NOT_FOUND', `key "${keyId}" not present in registry`);
    }
    return key;
  }
}
