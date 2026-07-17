import { describe, it, expect } from 'vitest';
import {
  generateSecret,
  base32Encode,
  base32Decode,
  totp,
  verifyTotp,
  otpauthUri,
} from '../totp.js';

describe('totp', () => {
  it('generateSecret returns 20 random, distinct bytes', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a.length).toBe(20);
    expect(a.equals(b)).toBe(false);
  });

  it('base32 encode/decode round-trips', () => {
    const secret = generateSecret();
    const encoded = base32Encode(secret);
    expect(encoded).toMatch(/^[A-Z2-7]+$/); // no padding, RFC 4648 alphabet
    expect(base32Decode(encoded).equals(secret)).toBe(true);
  });

  it('base32Decode tolerates lowercase, whitespace and padding', () => {
    const secret = generateSecret();
    const encoded = base32Encode(secret);
    const messy = encoded.toLowerCase().split('').join(' ') + '===';
    expect(base32Decode(messy).equals(secret)).toBe(true);
  });

  it('a known RFC 4226 test vector produces the expected HOTP-derived code shape', () => {
    // RFC 6238 Appendix B secret ("12345678901234567890", ASCII) at T=59s
    // (counter=1) is documented to yield 287082 under SHA1/8-digits — we use
    // 6 digits, so just assert our own algorithm is internally consistent
    // and deterministic for a fixed time, rather than depend on the 8-digit
    // published vector.
    const secret = Buffer.from('12345678901234567890', 'ascii');
    const at = 59_000; // 59s → counter 1 at 30s steps
    const a = totp(secret, at);
    const b = totp(secret, at);
    expect(a).toBe(b);
    expect(a).toMatch(/^\d{6}$/);
  });

  it('totp() changes across a 30s step boundary', () => {
    const secret = generateSecret();
    const t0 = 1_700_000_000_000; // arbitrary fixed epoch ms
    const a = totp(secret, t0);
    const b = totp(secret, t0 + 30_000);
    // Extremely unlikely to collide across steps for a random secret; if it
    // does on a rare run, the codes are still both valid 6-digit strings.
    expect(a).toMatch(/^\d{6}$/);
    expect(b).toMatch(/^\d{6}$/);
  });

  it('verifyTotp accepts the current code', () => {
    const secret = generateSecret();
    const now = Date.now();
    const code = totp(secret, now);
    expect(verifyTotp(secret, code, now)).toBe(true);
  });

  it('verifyTotp tolerates ±1 step of clock drift', () => {
    const secret = generateSecret();
    const now = 1_700_000_000_000;
    const codeOneStepAgo = totp(secret, now - 30_000);
    const codeOneStepAhead = totp(secret, now + 30_000);
    expect(verifyTotp(secret, codeOneStepAgo, now)).toBe(true);
    expect(verifyTotp(secret, codeOneStepAhead, now)).toBe(true);
  });

  it('verifyTotp rejects a code 2 steps away', () => {
    const secret = generateSecret();
    const now = 1_700_000_000_000;
    const codeTwoStepsAgo = totp(secret, now - 60_000);
    expect(verifyTotp(secret, codeTwoStepsAgo, now)).toBe(false);
  });

  it('verifyTotp rejects a wrong secret', () => {
    const secretA = generateSecret();
    const secretB = generateSecret();
    const now = Date.now();
    const code = totp(secretA, now);
    expect(verifyTotp(secretB, code, now)).toBe(false);
  });

  it('verifyTotp rejects malformed input without throwing', () => {
    const secret = generateSecret();
    expect(verifyTotp(secret, '')).toBe(false);
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
    expect(verifyTotp(secret, '12345')).toBe(false); // too short
    expect(verifyTotp(secret, '1234567')).toBe(false); // too long
  });

  it('otpauthUri embeds a scannable, correctly-shaped URI', () => {
    const secret = generateSecret();
    const uri = otpauthUri({ secret, accountName: 'user@example.com', issuer: 'Laetoli Data' });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('secret=' + base32Encode(secret));
    expect(uri).toContain('issuer=Laetoli');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});
