import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CryptoError } from './errors';
import { createKeyRegistry, loadKeyRegistryFromEnv } from './registry';

function b64(bytes = 32): string {
  return Buffer.from(randomBytes(bytes)).toString('base64');
}

describe('createKeyRegistry', () => {
  it('returns a registry where get/list/activeKeyId behave as documented', () => {
    const reg = createKeyRegistry({ v1: b64(), v2: b64() }, 'v2');
    expect(reg.activeKeyId()).toBe('v2');
    expect(reg.list()).toEqual(['v1', 'v2']);
    expect(reg.get('v1')).toBeInstanceOf(Uint8Array);
    expect(reg.get('v1')?.length).toBe(32);
    expect(reg.get('absent')).toBeUndefined();
  });

  it('defaults active to the first key when none is specified', () => {
    const reg = createKeyRegistry({ alpha: b64(), beta: b64() });
    expect(reg.activeKeyId()).toBe('alpha');
  });

  it('throws KEY_WRONG_LENGTH when key is not 32 bytes', () => {
    const tooShort = Buffer.from(randomBytes(16)).toString('base64');
    expect(() => createKeyRegistry({ v1: tooShort })).toThrowError(CryptoError);
    try {
      createKeyRegistry({ v1: tooShort });
    } catch (err) {
      expect((err as CryptoError).cryptoCode).toBe('KEY_WRONG_LENGTH');
    }
  });

  it('throws ENV_MALFORMED on empty entries', () => {
    expect(() => createKeyRegistry({})).toThrowError(CryptoError);
  });

  it('throws when activeKeyId is not present', () => {
    expect(() => createKeyRegistry({ v1: b64() }, 'v9')).toThrowError(CryptoError);
    try {
      createKeyRegistry({ v1: b64() }, 'v9');
    } catch (err) {
      expect((err as CryptoError).cryptoCode).toBe('KEY_NOT_FOUND');
    }
  });

  it('rejects invalid base64', () => {
    expect(() => createKeyRegistry({ v1: 'not-base64-!@#$' })).toThrowError(CryptoError);
  });

  it('rejects keyIds with empty or too-long names', () => {
    expect(() => createKeyRegistry({ '': b64() })).toThrowError(CryptoError);
    expect(() => createKeyRegistry({ ['x'.repeat(64)]: b64() })).toThrowError(CryptoError);
  });
});

describe('loadKeyRegistryFromEnv', () => {
  it('parses the ENCRYPTION_KEYS format and picks the first as active', () => {
    const v1 = b64();
    const v2 = b64();
    const reg = loadKeyRegistryFromEnv({ keysEnv: `v1:${v1},v2:${v2}` });
    expect(reg.activeKeyId()).toBe('v1');
    expect(reg.list()).toEqual(['v1', 'v2']);
  });

  it('honors ENCRYPTION_ACTIVE_KEY_ID', () => {
    const v1 = b64();
    const v2 = b64();
    const reg = loadKeyRegistryFromEnv({
      keysEnv: `v1:${v1},v2:${v2}`,
      activeKeyIdEnv: 'v2',
    });
    expect(reg.activeKeyId()).toBe('v2');
  });

  it('tolerates whitespace and trailing commas', () => {
    const reg = loadKeyRegistryFromEnv({
      keysEnv: ` v1 : ${b64()} , v2 : ${b64()} , `,
    });
    expect(reg.list()).toEqual(['v1', 'v2']);
  });

  it('throws on empty env', () => {
    expect(() => loadKeyRegistryFromEnv({ keysEnv: '' })).toThrowError(CryptoError);
    expect(() => loadKeyRegistryFromEnv({ keysEnv: undefined })).toThrowError(CryptoError);
  });

  it('throws on duplicate keyId', () => {
    const v1 = b64();
    expect(() => loadKeyRegistryFromEnv({ keysEnv: `v1:${v1},v1:${v1}` })).toThrowError(
      CryptoError,
    );
  });

  it('throws on malformed entry (no colon)', () => {
    expect(() => loadKeyRegistryFromEnv({ keysEnv: 'no-colon-here' })).toThrowError(CryptoError);
  });
});
