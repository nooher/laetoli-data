import { describe, it, expect } from 'vitest';
import {
  dumpFilename,
  isManagedDump,
  selectForDeletion,
  buildPgDumpArgs,
} from '../backup.js';
import { loadConfig } from '../config.js';

describe('dumpFilename', () => {
  it('builds a sortable, colon-free gzip name', () => {
    const name = dumpFilename(new Date('2026-06-19T03:00:00.000Z'));
    expect(name).toBe('laetoli-2026-06-19T03-00-00Z.sql.gz');
    expect(name).not.toContain(':');
  });

  it('lexicographic order matches chronological order', () => {
    const a = dumpFilename(new Date('2026-06-19T03:00:00Z'));
    const b = dumpFilename(new Date('2026-06-20T03:00:00Z'));
    expect([b, a].sort()).toEqual([a, b]);
  });
});

describe('isManagedDump', () => {
  it('matches our dumps only', () => {
    expect(isManagedDump('laetoli-2026-06-19T03-00-00Z.sql.gz')).toBe(true);
    expect(isManagedDump('foreign-backup.sql.gz')).toBe(false);
    expect(isManagedDump('laetoli-2026.sql')).toBe(false);
    expect(isManagedDump('README.md')).toBe(false);
  });
});

describe('selectForDeletion', () => {
  const dumps = [
    'laetoli-2026-06-15T03-00-00Z.sql.gz',
    'laetoli-2026-06-16T03-00-00Z.sql.gz',
    'laetoli-2026-06-17T03-00-00Z.sql.gz',
    'laetoli-2026-06-18T03-00-00Z.sql.gz',
    'laetoli-2026-06-19T03-00-00Z.sql.gz',
  ];

  it('keeps the newest N and returns the oldest for deletion', () => {
    const del = selectForDeletion(dumps, 2);
    expect(del).toEqual([
      'laetoli-2026-06-15T03-00-00Z.sql.gz',
      'laetoli-2026-06-16T03-00-00Z.sql.gz',
      'laetoli-2026-06-17T03-00-00Z.sql.gz',
    ]);
  });

  it('returns nothing when at or below the keep count', () => {
    expect(selectForDeletion(dumps, 5)).toEqual([]);
    expect(selectForDeletion(dumps, 10)).toEqual([]);
  });

  it('never selects foreign files for deletion', () => {
    const mixed = [...dumps, 'somebody-elses-file.sql.gz', 'notes.txt'];
    const del = selectForDeletion(mixed, 1);
    expect(del).not.toContain('somebody-elses-file.sql.gz');
    expect(del).not.toContain('notes.txt');
    expect(del.every((d) => d.startsWith('laetoli-'))).toBe(true);
  });

  it('keep<=0 prunes all managed dumps', () => {
    expect(selectForDeletion(dumps, 0)).toEqual([...dumps].sort());
  });
});

describe('buildPgDumpArgs', () => {
  it('uses DATABASE_URL when present', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@db:5432/laetoli',
      BACKUP_INTERVAL_HOURS: '6',
    });
    expect(buildPgDumpArgs(cfg)).toEqual([
      '--dbname',
      'postgres://u:p@db:5432/laetoli',
      '--clean',
      '--if-exists',
    ]);
  });

  it('falls back to PG* flags', () => {
    const cfg = loadConfig({
      PGHOST: 'db',
      PGPORT: '5432',
      PGUSER: 'laetoli',
      PGPASSWORD: 'secret',
      PGDATABASE: 'laetoli',
    });
    expect(buildPgDumpArgs(cfg)).toEqual([
      '-h', 'db', '-p', '5432', '-U', 'laetoli', '-d', 'laetoli',
      '--clean', '--if-exists',
    ]);
  });
});
