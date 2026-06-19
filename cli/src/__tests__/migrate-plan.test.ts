import { describe, it, expect } from 'vitest';
import {
  checksum,
  sortFiles,
  planMigrations,
  isSqlFile,
  type MigrationFile,
} from '../lib/migrate-plan.js';

const f = (name: string, contents: string): MigrationFile => ({ name, contents });

describe('checksum', () => {
  it('is stable and newline-normalized (CRLF == LF)', () => {
    expect(checksum('a\r\nb')).toBe(checksum('a\nb'));
  });
  it('differs for different content', () => {
    expect(checksum('a')).not.toBe(checksum('b'));
  });
});

describe('isSqlFile', () => {
  it('matches only .sql', () => {
    expect(isSqlFile('0001_x.sql')).toBe(true);
    expect(isSqlFile('README.md')).toBe(false);
    expect(isSqlFile('.gitkeep')).toBe(false);
  });
});

describe('sortFiles', () => {
  it('orders lexicographically', () => {
    const sorted = sortFiles([f('0002_b.sql', ''), f('0001_a.sql', ''), f('0010_c.sql', '')]);
    expect(sorted.map((x) => x.name)).toEqual(['0001_a.sql', '0002_b.sql', '0010_c.sql']);
  });
});

describe('planMigrations', () => {
  it('returns all as pending when nothing applied', () => {
    const plan = planMigrations([f('0002_b.sql', 'B'), f('0001_a.sql', 'A')], []);
    expect(plan.pending.map((p) => p.name)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(plan.applied).toEqual([]);
    expect(plan.changed).toEqual([]);
  });

  it('separates applied from pending', () => {
    const applied = [{ name: '0001_a.sql', checksum: checksum('A') }];
    const plan = planMigrations([f('0001_a.sql', 'A'), f('0002_b.sql', 'B')], applied);
    expect(plan.applied.map((p) => p.name)).toEqual(['0001_a.sql']);
    expect(plan.pending.map((p) => p.name)).toEqual(['0002_b.sql']);
  });

  it('flags a changed checksum on an already-applied file', () => {
    const applied = [{ name: '0001_a.sql', checksum: checksum('OLD') }];
    const plan = planMigrations([f('0001_a.sql', 'NEW')], applied);
    expect(plan.changed).toHaveLength(1);
    expect(plan.changed[0].name).toBe('0001_a.sql');
    expect(plan.pending).toEqual([]);
  });

  it('reports applied-but-missing-on-disk files', () => {
    const applied = [{ name: '0009_gone.sql', checksum: 'x' }];
    const plan = planMigrations([f('0001_a.sql', 'A')], applied);
    expect(plan.missing).toEqual(['0009_gone.sql']);
    expect(plan.pending.map((p) => p.name)).toEqual(['0001_a.sql']);
  });

  it('picks up arbitrary files (e.g. 0001_storage / 0002_realtime by other agents)', () => {
    const files = [f('0002_realtime.sql', 'R'), f('0001_storage.sql', 'S')];
    const plan = planMigrations(files, []);
    expect(plan.pending.map((p) => p.name)).toEqual(['0001_storage.sql', '0002_realtime.sql']);
  });
});
