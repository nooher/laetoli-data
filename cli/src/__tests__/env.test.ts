import { describe, it, expect } from 'vitest';
import { parseEnv, fillEnv, databaseUrl } from '../lib/env.js';

describe('parseEnv', () => {
  it('parses key=value, ignores comments/blanks, strips quotes', () => {
    const m = parseEnv('# comment\n\nA=1\nB="two"\nC=\'three\'\nD=has=eq\n');
    expect(m).toEqual({ A: '1', B: 'two', C: 'three', D: 'has=eq' });
  });
});

describe('fillEnv', () => {
  const template = [
    '# Laetoli',
    'POSTGRES_USER=laetoli',
    'POSTGRES_PASSWORD=',
    'JWT_SECRET=',
    'CADDY_DOMAIN=:80',
  ].join('\n');

  it('replaces values in place, preserves comments + order', () => {
    const out = fillEnv(template, { POSTGRES_PASSWORD: 'pw', JWT_SECRET: 'js' });
    const lines = out.split('\n');
    expect(lines[0]).toBe('# Laetoli');
    expect(lines[1]).toBe('POSTGRES_USER=laetoli');
    expect(lines[2]).toBe('POSTGRES_PASSWORD=pw');
    expect(lines[3]).toBe('JWT_SECRET=js');
  });

  it('appends keys not present in the template', () => {
    const out = fillEnv('A=1\n', { B: '2' });
    expect(out).toContain('A=1');
    expect(out).toContain('B=2');
  });
});

describe('databaseUrl', () => {
  it('builds a url from POSTGRES_* with sane defaults', () => {
    const url = databaseUrl({ POSTGRES_USER: 'laetoli', POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'laetoli' });
    expect(url).toBe('postgres://laetoli:pw@127.0.0.1:5432/laetoli');
  });

  it('url-encodes special chars in credentials', () => {
    const url = databaseUrl({ POSTGRES_USER: 'a@b', POSTGRES_PASSWORD: 'p@ss/word', POSTGRES_DB: 'db' });
    expect(url).toContain('a%40b:p%40ss%2Fword@');
  });

  it('prefers an explicit DATABASE_URL', () => {
    expect(databaseUrl({ DATABASE_URL: 'postgres://x/y' })).toBe('postgres://x/y');
  });

  it('honors PGHOST/PGPORT overrides', () => {
    const url = databaseUrl({ POSTGRES_PASSWORD: 'pw', PGHOST: 'db', PGPORT: '6543' });
    expect(url).toBe('postgres://laetoli:pw@db:6543/laetoli');
  });
});
