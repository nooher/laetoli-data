import { describe, it, expect } from 'vitest';
import { mintKey, hashSecret, verifyKey, splitApiKey } from '../apikeys.js';

describe('mintKey', () => {
  it('produces a prefix, secret, hash and a "prefix.secret" apikey', () => {
    const k = mintKey();
    expect(k.prefix.startsWith('ld_')).toBe(true);
    expect(k.secret.length).toBeGreaterThanOrEqual(20);
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    expect(k.apikey).toBe(`${k.prefix}.${k.secret}`);
  });

  it('never embeds the raw secret in the hash', () => {
    const k = mintKey();
    expect(k.hash).not.toContain(k.secret);
  });

  it('mints unique keys each call', () => {
    const a = mintKey();
    const b = mintKey();
    expect(a.apikey).not.toBe(b.apikey);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('hashSecret', () => {
  it('is deterministic sha256 hex', () => {
    expect(hashSecret('abc')).toBe(hashSecret('abc'));
    expect(hashSecret('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret('abc')).not.toBe(hashSecret('abd'));
  });
});

describe('splitApiKey', () => {
  it('splits a well-formed key', () => {
    expect(splitApiKey('ld_abc.secretpart')).toEqual({ prefix: 'ld_abc', secret: 'secretpart' });
  });
  it('rejects malformed keys', () => {
    expect(splitApiKey('nodot')).toBeNull();
    expect(splitApiKey('.secret')).toBeNull();
    expect(splitApiKey('prefix.')).toBeNull();
    expect(splitApiKey('')).toBeNull();
  });
});

describe('verifyKey', () => {
  it('verifies a freshly minted full key against its stored hash', () => {
    const k = mintKey();
    expect(verifyKey(k.apikey, k.hash)).toBe(true);
  });

  it('verifies a bare secret (no prefix) against its hash', () => {
    const k = mintKey();
    expect(verifyKey(k.secret, k.hash)).toBe(true);
  });

  it('rejects a wrong key', () => {
    const k = mintKey();
    const other = mintKey();
    expect(verifyKey(other.apikey, k.hash)).toBe(false);
  });

  it('rejects a tampered secret', () => {
    const k = mintKey();
    expect(verifyKey(`${k.prefix}.${k.secret}x`, k.hash)).toBe(false);
  });

  it('rejects empty / non-string input', () => {
    expect(verifyKey('', 'deadbeef')).toBe(false);
    // @ts-expect-error testing runtime guard
    expect(verifyKey(null, 'deadbeef')).toBe(false);
  });
});
