import { describe, it, expect } from 'vitest';
import {
  validateUsername,
  validatePassword,
  normalizeUsername,
} from '../validation.js';

describe('validateUsername', () => {
  it('accepts a good username', () => {
    expect(validateUsername('asha_99').ok).toBe(true);
    expect(validateUsername('Juma.Mbwana-1').ok).toBe(true);
  });

  it('rejects missing/empty', () => {
    expect(validateUsername(undefined).ok).toBe(false);
    expect(validateUsername('   ').ok).toBe(false);
  });

  it('rejects too short and too long', () => {
    expect(validateUsername('ab').ok).toBe(false);
    expect(validateUsername('x'.repeat(33)).ok).toBe(false);
  });

  it('rejects illegal characters and bad start', () => {
    expect(validateUsername('asha@home').ok).toBe(false);
    expect(validateUsername('asha ng').ok).toBe(false);
    expect(validateUsername('_asha').ok).toBe(false);
  });

  it('error messages are in Kiswahili', () => {
    const r = validateUsername('ab');
    expect(r.error).toMatch(/Jina/);
  });
});

describe('validatePassword', () => {
  it('accepts >= 8 chars', () => {
    expect(validatePassword('siri1234').ok).toBe(true);
  });
  it('rejects empty/short/too long', () => {
    expect(validatePassword('').ok).toBe(false);
    expect(validatePassword('short').ok).toBe(false);
    expect(validatePassword('x'.repeat(201)).ok).toBe(false);
  });
  it('Kiswahili error', () => {
    expect(validatePassword('x').error).toMatch(/Nenosiri/);
  });
});

describe('normalizeUsername', () => {
  it('trims and lowercases', () => {
    expect(normalizeUsername('  AshA_99 ')).toBe('asha_99');
  });
});
