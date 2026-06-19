import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from '../server.js';
import { loadConfig } from '../config.js';
import type { DumpRunner } from '../backup.js';

// A fake runner that yields a canned dump body — no pg_dump process spawned.
const fakeRunner: DumpRunner = {
  run() {
    return {
      stdout: Readable.from(['-- fake dump\nSELECT 1;\n']),
      done: Promise.resolve(),
    };
  },
};

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'laetoli-backup-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('backup server runOnce', () => {
  it('writes a gzip dump and updates status', async () => {
    const dir = tmp();
    const config = loadConfig({ BACKUP_DIR: dir, BACKUP_INTERVAL_HOURS: '24' });
    const server = createServer({ config, runner: fakeRunner, log: () => {} });

    await server.runOnce(new Date('2026-06-19T03:00:00Z'));

    const files = readdirSync(dir);
    expect(files).toContain('laetoli-2026-06-19T03-00-00Z.sql.gz');
    expect(server.status.lastSuccess).not.toBeNull();
    expect(server.status.lastError).toBeNull();
    expect(server.status.count).toBe(1);
    expect(server.status.totalBytes).toBeGreaterThan(0);
  });

  it('prunes old dumps beyond BACKUP_KEEP, ignoring foreign files', async () => {
    const dir = tmp();
    // Pre-seed 3 old managed dumps + 1 foreign file.
    for (const d of ['15', '16', '17']) {
      writeFileSync(join(dir, `laetoli-2026-06-${d}T03-00-00Z.sql.gz`), 'x');
    }
    writeFileSync(join(dir, 'keep-me.txt'), 'not a dump');

    const config = loadConfig({ BACKUP_DIR: dir, BACKUP_KEEP: '2', BACKUP_INTERVAL_HOURS: '24' });
    const server = createServer({ config, runner: fakeRunner, log: () => {} });

    // New dump on the 19th -> 4 managed dumps, keep 2 -> prune oldest 2.
    await server.runOnce(new Date('2026-06-19T03:00:00Z'));

    const files = readdirSync(dir).sort();
    expect(files).toContain('keep-me.txt'); // foreign file untouched
    const managed = files.filter((f) => f.startsWith('laetoli-'));
    expect(managed).toEqual([
      'laetoli-2026-06-17T03-00-00Z.sql.gz',
      'laetoli-2026-06-19T03-00-00Z.sql.gz',
    ]);
    expect(server.status.count).toBe(2);
  });

  it('records lastError when the dump fails', async () => {
    const dir = tmp();
    const failing: DumpRunner = {
      run() {
        return {
          stdout: Readable.from(['']),
          done: Promise.reject(new Error('pg_dump exited 1: boom')),
        };
      },
    };
    const config = loadConfig({ BACKUP_DIR: dir, BACKUP_INTERVAL_HOURS: '24' });
    const server = createServer({ config, runner: failing, log: () => {} });
    await server.runOnce(new Date('2026-06-19T03:00:00Z'));
    expect(server.status.lastError).toContain('boom');
    expect(server.status.lastSuccess).toBeNull();
  });
});

describe('computeNextRun', () => {
  it('cron mode resolves the cron schedule', () => {
    const config = loadConfig({ BACKUP_CRON: '0 3 * * *' });
    const server = createServer({ config, runner: fakeRunner, log: () => {} });
    const next = server.computeNextRun(new Date('2026-06-19T05:00:00Z'));
    expect(next.toISOString()).toBe('2026-06-20T03:00:00.000Z');
  });

  it('interval mode adds the configured hours', () => {
    const config = loadConfig({ BACKUP_INTERVAL_HOURS: '6' });
    const server = createServer({ config, runner: fakeRunner, log: () => {} });
    const next = server.computeNextRun(new Date('2026-06-19T00:00:00Z'));
    expect(next.toISOString()).toBe('2026-06-19T06:00:00.000Z');
  });
});
