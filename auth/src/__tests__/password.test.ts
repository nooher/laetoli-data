import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../password.js';

describe('password', () => {
  it('hashes and verifies the correct password', async () => {
    const hash = await hashPassword('siri-yangu-123');
    expect(hash).not.toBe('siri-yangu-123');
    expect(await verifyPassword('siri-yangu-123', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('siri-yangu-123');
    expect(await verifyPassword('nenosiri-baya', hash)).toBe(false);
  });

  it('returns false for empty/garbage hash', async () => {
    expect(await verifyPassword('whatever', '')).toBe(false);
    expect(await verifyPassword('whatever', 'not-a-hash')).toBe(false);
  });
});
