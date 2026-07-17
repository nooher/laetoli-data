import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../encryption.js';

const JWT_SECRET = 'a'.repeat(32); // meets config.ts's ≥32-char requirement

describe('encryption', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const plaintext = Buffer.from('super-secret-totp-key-bytes');
    const encrypted = encryptSecret(plaintext, JWT_SECRET);
    expect(decryptSecret(encrypted, JWT_SECRET).equals(plaintext)).toBe(true);
  });

  it('ciphertext never contains the plaintext', () => {
    const plaintext = Buffer.from('super-secret-totp-key-bytes');
    const encrypted = encryptSecret(plaintext, JWT_SECRET);
    expect(encrypted).not.toContain(plaintext.toString('base64url'));
    expect(encrypted.toLowerCase()).not.toContain('super-secret');
  });

  it('two encryptions of the same plaintext differ (random IV)', () => {
    const plaintext = Buffer.from('same input twice');
    const a = encryptSecret(plaintext, JWT_SECRET);
    const b = encryptSecret(plaintext, JWT_SECRET);
    expect(a).not.toBe(b);
    // ...but both decrypt to the same plaintext.
    expect(decryptSecret(a, JWT_SECRET).equals(plaintext)).toBe(true);
    expect(decryptSecret(b, JWT_SECRET).equals(plaintext)).toBe(true);
  });

  it('decrypting with the wrong key fails closed (throws, does not return garbage silently)', () => {
    const plaintext = Buffer.from('secret');
    const encrypted = encryptSecret(plaintext, JWT_SECRET);
    const wrongKey = 'b'.repeat(32);
    expect(() => decryptSecret(encrypted, wrongKey)).toThrow();
  });

  it('decrypting a tampered ciphertext fails closed (GCM auth tag check)', () => {
    const plaintext = Buffer.from('secret');
    const encrypted = encryptSecret(plaintext, JWT_SECRET);
    const [iv, ct, tag] = encrypted.split(':');
    // Flip the ciphertext without updating the auth tag.
    const tampered = [iv, ct.slice(0, -2) + (ct.slice(-2) === 'AA' ? 'BB' : 'AA'), tag].join(':');
    expect(() => decryptSecret(tampered, JWT_SECRET)).toThrow();
  });

  it('decrypting a malformed string throws rather than crashing unpredictably', () => {
    expect(() => decryptSecret('not-a-valid-encoded-secret', JWT_SECRET)).toThrow();
  });
});
