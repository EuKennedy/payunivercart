import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BLOB_CONSTANTS, decodeBlob } from './blob';
import { CryptoError } from './errors';
import { createKeyRegistry } from './registry';
import { CryptoService } from './service';

function key(b64Source?: Uint8Array): string {
  return Buffer.from(b64Source ?? randomBytes(32)).toString('base64');
}

function buildService(activeKeyId = 'v1', extra: Record<string, string> = {}) {
  const registry = createKeyRegistry({ v1: key(), ...extra }, activeKeyId);
  return { registry, service: new CryptoService(registry) };
}

describe('CryptoService — roundtrip', () => {
  it('seals and unseals a UTF-8 string', () => {
    const { service } = buildService();
    const plaintext = 'mp_token_abc123:webhook_secret_xyz';
    const { blob, keyId } = service.sealString(plaintext);
    expect(keyId).toBe('v1');
    expect(service.unsealString(blob)).toBe(plaintext);
  });

  it('seals and unseals an object via JSON', () => {
    const { service } = buildService();
    const value = {
      accessToken: 'mp_token',
      publicKey: 'mp_public',
      webhookSecret: 'mp_secret',
      isSandbox: true,
    };
    const { blob } = service.sealJson(value);
    expect(service.unsealJson(blob)).toEqual(value);
  });

  it('produces a different ciphertext for the same plaintext on each call (random IV)', () => {
    const { service } = buildService();
    const a = service.sealString('same-input');
    const b = service.sealString('same-input');
    expect(Buffer.compare(a.blob, b.blob)).not.toBe(0);
  });

  it('blob starts with the documented sb v1 magic header', () => {
    const { service } = buildService('v1');
    const { blob } = service.sealString('hello');
    expect(blob[0]).toBe(BLOB_CONSTANTS.MAGIC[0]);
    expect(blob[1]).toBe(BLOB_CONSTANTS.MAGIC[1]);
    expect(blob[2]).toBe(BLOB_CONSTANTS.VERSION_MAJOR);
    expect(blob[3]).toBe(BLOB_CONSTANTS.VERSION_MINOR);
  });
});

describe('CryptoService — tamper / authenticity', () => {
  it('rejects a blob whose ciphertext byte was flipped', () => {
    const { service } = buildService();
    const { blob } = service.sealString('secret');
    // Flip the LAST byte of the ciphertext+tag region (i.e. inside the tag).
    const tampered = Uint8Array.from(blob);
    const lastIdx = tampered.length - 1;
    const lastByte = tampered[lastIdx];
    if (lastByte === undefined) throw new Error('blob unexpectedly empty');
    tampered[lastIdx] = (lastByte ^ 0x01) & 0xff;
    expect(() => service.unsealString(tampered)).toThrowError(CryptoError);
    try {
      service.unsealString(tampered);
    } catch (err) {
      expect((err as CryptoError).cryptoCode).toBe('DECRYPT_FAILED');
    }
  });

  it('rejects a blob whose IV was modified', () => {
    const { service } = buildService();
    const { blob } = service.sealString('secret');
    const ivOffset = BLOB_CONSTANTS.HEADER_FIXED + 'v1'.length; // skip "sb<version><len>v1"
    const tampered = Uint8Array.from(blob);
    const ivByte = tampered[ivOffset];
    if (ivByte === undefined) throw new Error('blob too short for IV');
    tampered[ivOffset] = (ivByte ^ 0xff) & 0xff;
    expect(() => service.unsealString(tampered)).toThrow(/authentication/);
  });

  it('rejects a blob written with a key the registry does not have', () => {
    const writer = new CryptoService(createKeyRegistry({ v1: key() }, 'v1'));
    const { blob } = writer.sealString('secret');
    const otherRegistry = createKeyRegistry({ v9: key() }, 'v9');
    const reader = new CryptoService(otherRegistry);
    expect(() => reader.unsealString(blob)).toThrowError(CryptoError);
    try {
      reader.unsealString(blob);
    } catch (err) {
      expect((err as CryptoError).cryptoCode).toBe('KEY_NOT_FOUND');
    }
  });

  it('rejects an empty blob', () => {
    const { service } = buildService();
    expect(() => service.unseal(new Uint8Array(0))).toThrowError(CryptoError);
  });

  it('rejects a blob with bad magic', () => {
    const { service } = buildService();
    const garbage = new Uint8Array(BLOB_CONSTANTS.MIN_BLOB_SIZE + 10);
    garbage[0] = 0xff; // not "s"
    garbage[1] = 0xff;
    expect(() => service.unseal(garbage)).toThrow(/magic/);
  });

  it('rejects an unsupported version byte', () => {
    const { service } = buildService();
    const { blob } = service.sealString('x');
    const tampered = Uint8Array.from(blob);
    tampered[2] = 0x02; // pretend v2 exists
    expect(() => service.unseal(tampered)).toThrow(/version/);
  });
});

describe('CryptoService — key rotation', () => {
  it('reads a v1-sealed blob after rotating active to v2 (both keys present)', () => {
    const v1Bytes = randomBytes(32);
    const v2Bytes = randomBytes(32);
    const registryV1Active = createKeyRegistry(
      { v1: Buffer.from(v1Bytes).toString('base64'), v2: Buffer.from(v2Bytes).toString('base64') },
      'v1',
    );
    const writerV1 = new CryptoService(registryV1Active);
    const sealed = writerV1.sealString('legacy-secret');

    const registryV2Active = createKeyRegistry(
      { v1: Buffer.from(v1Bytes).toString('base64'), v2: Buffer.from(v2Bytes).toString('base64') },
      'v2',
    );
    const readerV2 = new CryptoService(registryV2Active);
    expect(readerV2.activeKeyId).toBe('v2');
    expect(readerV2.unsealString(sealed.blob)).toBe('legacy-secret');

    // New writes go to v2.
    const fresh = readerV2.sealString('new-secret');
    expect(fresh.keyId).toBe('v2');
    expect(decodeBlob(fresh.blob).keyId).toBe('v2');
  });
});

describe('CryptoService — bounds', () => {
  it('rejects plaintext over 64 KiB', () => {
    const { service } = buildService();
    const huge = new Uint8Array(64 * 1024 + 1);
    expect(() => service.seal(huge)).toThrowError(CryptoError);
    try {
      service.seal(huge);
    } catch (err) {
      expect((err as CryptoError).cryptoCode).toBe('PLAINTEXT_TOO_LARGE');
    }
  });

  it('accepts an empty plaintext (legitimate sentinel)', () => {
    const { service } = buildService();
    const { blob } = service.seal(new Uint8Array(0));
    expect(service.unseal(blob).length).toBe(0);
  });

  it('inspect() reveals the keyId without decrypting', () => {
    const { service } = buildService('v1');
    const { blob } = service.sealString('hi');
    expect(service.inspect(blob)).toEqual({ keyId: 'v1', version: 'v1' });
  });
});
