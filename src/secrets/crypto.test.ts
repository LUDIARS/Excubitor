import { describe, it, expect } from 'vitest';
import { encryptJson, decryptJson, isEncryptedBlob } from './crypto.js';

describe('encryptJson / decryptJson', () => {
  const master = 'test-master-key';

  it('round-trips an object', () => {
    const value = { clientId: 'cid', clientSecret: 'csec', nested: [1, 2, 3] };
    const blob = encryptJson(value, master);
    expect(isEncryptedBlob(blob)).toBe(true);
    expect(decryptJson(blob, master)).toEqual(value);
  });

  it('produces no plaintext (data is base64 ciphertext)', () => {
    const blob = encryptJson({ secret: 'super-secret-value' }, master);
    expect(JSON.stringify(blob)).not.toContain('super-secret-value');
  });

  it('uses a fresh salt/iv each call', () => {
    const a = encryptJson({ x: 1 }, master);
    const b = encryptJson({ x: 1 }, master);
    expect(a.salt).not.toEqual(b.salt);
    expect(a.iv).not.toEqual(b.iv);
  });

  it('fails to decrypt with a wrong master key', () => {
    const blob = encryptJson({ x: 1 }, master);
    expect(() => decryptJson(blob, 'wrong-key')).toThrow();
  });

  it('fails to decrypt tampered ciphertext (GCM auth)', () => {
    const blob = encryptJson({ x: 1 }, master);
    const tampered = { ...blob, data: Buffer.from('tampered').toString('base64') };
    expect(() => decryptJson(tampered, master)).toThrow();
  });
});
