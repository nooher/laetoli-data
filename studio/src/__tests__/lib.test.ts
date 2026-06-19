import { describe, it, expect } from 'vitest';
import {
  normalizeBaseUrl,
  joinUrl,
  buildWhereFromRow,
  hasPrimaryKey,
  formatCell,
  isNullish,
  formatBytes,
  coerceInput,
  toInputString,
  groupBy,
} from '../lib';
import type { Column } from '../types';

const col = (name: string, over: Partial<Column> = {}): Column => ({
  name,
  type: 'text',
  nullable: true,
  default: null,
  is_pk: false,
  ...over,
});

describe('normalizeBaseUrl', () => {
  it('defaults empty to /admin', () => {
    expect(normalizeBaseUrl('')).toBe('/admin');
    expect(normalizeBaseUrl(null)).toBe('/admin');
    expect(normalizeBaseUrl('   ')).toBe('/admin');
  });
  it('trims trailing slashes and whitespace', () => {
    expect(normalizeBaseUrl(' https://x.tz/admin/ ')).toBe('https://x.tz/admin');
    expect(normalizeBaseUrl('/admin///')).toBe('/admin');
  });
});

describe('joinUrl', () => {
  it('joins base and path without doubling slashes', () => {
    expect(joinUrl('/admin', '/health')).toBe('/admin/health');
    expect(joinUrl('/admin/', 'health')).toBe('/admin/health');
    expect(joinUrl('https://x.tz/admin', '/stats')).toBe('https://x.tz/admin/stats');
  });
});

describe('buildWhereFromRow', () => {
  const cols = [col('id', { is_pk: true, type: 'uuid' }), col('body'), col('done', { type: 'bool' })];
  it('uses only primary-key columns when present', () => {
    const where = buildWhereFromRow(cols, { id: 'abc', body: 'hi', done: true });
    expect(where).toEqual({ id: 'abc' });
  });
  it('falls back to all columns when no pk', () => {
    const noPk = [col('a'), col('b')];
    expect(buildWhereFromRow(noPk, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  });
  it('coerces missing values to null', () => {
    expect(buildWhereFromRow([col('id', { is_pk: true })], {})).toEqual({ id: null });
  });
  it('returns null when there are no columns', () => {
    expect(buildWhereFromRow([], { x: 1 })).toBeNull();
  });
});

describe('hasPrimaryKey', () => {
  it('detects pk presence', () => {
    expect(hasPrimaryKey([col('id', { is_pk: true })])).toBe(true);
    expect(hasPrimaryKey([col('a'), col('b')])).toBe(false);
  });
});

describe('formatCell / isNullish', () => {
  it('renders nullish as the empty glyph', () => {
    expect(formatCell(null)).toBe('∅');
    expect(formatCell(undefined)).toBe('∅');
    expect(isNullish(null)).toBe(true);
    expect(isNullish(0)).toBe(false);
  });
  it('stringifies primitives and objects', () => {
    expect(formatCell('hi')).toBe('hi');
    expect(formatCell(42)).toBe('42');
    expect(formatCell(true)).toBe('true');
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
  });
});

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(null)).toBe('—');
  });
});

describe('coerceInput', () => {
  it('maps empties and keywords', () => {
    expect(coerceInput('')).toBeNull();
    expect(coerceInput('null')).toBeNull();
    expect(coerceInput('true')).toBe(true);
    expect(coerceInput('false')).toBe(false);
  });
  it('parses numbers and JSON', () => {
    expect(coerceInput('42')).toBe(42);
    expect(coerceInput('-3.14')).toBe(-3.14);
    expect(coerceInput('{"a":1}')).toEqual({ a: 1 });
    expect(coerceInput('[1,2]')).toEqual([1, 2]);
  });
  it('keeps invalid JSON as the raw string', () => {
    expect(coerceInput('{bad}')).toBe('{bad}');
    expect(coerceInput('hello')).toBe('hello');
  });
});

describe('toInputString', () => {
  it('round-trips values to editable strings', () => {
    expect(toInputString(null)).toBe('');
    expect(toInputString('x')).toBe('x');
    expect(toInputString(7)).toBe('7');
    expect(toInputString({ a: 1 })).toBe('{"a":1}');
  });
});

describe('groupBy', () => {
  it('groups by key', () => {
    const items = [
      { t: 'a', n: 1 },
      { t: 'b', n: 2 },
      { t: 'a', n: 3 },
    ];
    const g = groupBy(items, (i) => i.t);
    expect(g.get('a')).toHaveLength(2);
    expect(g.get('b')).toHaveLength(1);
  });
});
