import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config.js';

const GOOD_KEY = 'k'.repeat(40);

describe('loadConfig', () => {
  it('fails fast when ADMIN_API_KEY missing (never runs open)', () => {
    expect(() => loadConfig({})).toThrow(/ADMIN_API_KEY/);
  });

  it('fails when ADMIN_API_KEY too short', () => {
    expect(() => loadConfig({ ADMIN_API_KEY: 'short' })).toThrow(/24/);
  });

  it('defaults port to 9996', () => {
    const c = loadConfig({ ADMIN_API_KEY: GOOD_KEY });
    expect(c.port).toBe(9996);
  });

  it('reads DATABASE_URL and statement timeout', () => {
    const c = loadConfig({
      ADMIN_API_KEY: GOOD_KEY,
      DATABASE_URL: 'postgres://laetoli_admin_login:p@db/laetoli',
      ADMIN_STATEMENT_TIMEOUT_MS: '5000',
    });
    expect(c.databaseUrl).toBe('postgres://laetoli_admin_login:p@db/laetoli');
    expect(c.statementTimeoutMs).toBe(5000);
  });

  it('falls back to a sane statement timeout', () => {
    const c = loadConfig({ ADMIN_API_KEY: GOOD_KEY, ADMIN_STATEMENT_TIMEOUT_MS: '0' });
    expect(c.statementTimeoutMs).toBe(15000);
  });
});
