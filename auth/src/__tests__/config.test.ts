import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config.js';

const GOOD_SECRET = 'x'.repeat(40);

describe('loadConfig', () => {
  it('fails fast when JWT_SECRET missing', () => {
    expect(() => loadConfig({})).toThrow(/JWT_SECRET/);
  });

  it('fails when JWT_SECRET too short', () => {
    expect(() => loadConfig({ JWT_SECRET: 'short' })).toThrow(/32/);
  });

  it('defaults expiry to 3600 and port to 9999', () => {
    const c = loadConfig({ JWT_SECRET: GOOD_SECRET });
    expect(c.jwtExpiry).toBe(3600);
    expect(c.port).toBe(9999);
  });

  it('reads JWT_EXPIRY and DATABASE_URL', () => {
    const c = loadConfig({
      JWT_SECRET: GOOD_SECRET,
      JWT_EXPIRY: '900',
      DATABASE_URL: 'postgres://u:p@h/db',
    });
    expect(c.jwtExpiry).toBe(900);
    expect(c.databaseUrl).toBe('postgres://u:p@h/db');
  });

  it('rejects non-positive expiry', () => {
    expect(() =>
      loadConfig({ JWT_SECRET: GOOD_SECRET, JWT_EXPIRY: '0' })
    ).toThrow(/JWT_EXPIRY/);
  });
});
