import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from '../server.js';
import { loadConfig } from '../config.js';
import {
  storageArchiveFilename,
  isManagedStorageArchive,
  isManagedDump,
  selectArchivesForDeletion,
  expandOffsiteCmd,
  mirrorFile,
  type DumpRunner,
  type CmdRunner,
} from '../backup.js';
import { renderMetrics } from '../metrics.js';
import { emptyStatus } from '../status.js';
import {
  parseArgs,
  latestDump,
  storageArchivePathFor,
  runRestore,
  type RestoreRunner,
} from '../restore.js';

// ---- fixtures --------------------------------------------------------------

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
  const d = mkdtempSync(join(tmpdir(), 'laetoli-durability-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A CmdRunner that records invocations and (for tar) writes a stub file. */
function recordingCmdRunner(opts: { failOffsite?: boolean; failTar?: boolean } = {}) {
  const calls: { command: string; args: string[]; shell?: boolean }[] = [];
  const runner: CmdRunner = {
    async run(command, args, o) {
      calls.push({ command, args, shell: o?.shell });
      if (command === 'tar') {
        if (opts.failTar) throw new Error('tar boom');
        // emulate tar writing the archive (outPath is args after -czf)
        const outPath = args[1];
        writeFileSync(outPath, 'STORAGE-ARCHIVE-BYTES');
        return;
      }
      // shell=true => off-site command template
      if (o?.shell) {
        if (opts.failOffsite) throw new Error('offsite boom');
      }
    },
  };
  return { runner, calls };
}

// ---- pure helpers ----------------------------------------------------------

describe('storage archive naming', () => {
  it('builds a colon-free .storage.tar.gz name and round-trips the matcher', () => {
    const name = storageArchiveFilename(new Date('2026-06-19T03:00:00Z'));
    expect(name).toBe('laetoli-2026-06-19T03-00-00Z.storage.tar.gz');
    expect(isManagedStorageArchive(name)).toBe(true);
    // storage archives must NOT be treated as pg dumps and vice-versa
    expect(isManagedDump(name)).toBe(false);
    expect(isManagedStorageArchive('laetoli-2026-06-19T03-00-00Z.sql.gz')).toBe(
      false
    );
  });
});

describe('selectArchivesForDeletion', () => {
  const archives = [
    'laetoli-2026-06-15T03-00-00Z.storage.tar.gz',
    'laetoli-2026-06-16T03-00-00Z.storage.tar.gz',
    'laetoli-2026-06-17T03-00-00Z.storage.tar.gz',
  ];
  it('keeps newest N, ignores dumps + foreign files', () => {
    const mixed = [
      ...archives,
      'laetoli-2026-06-17T03-00-00Z.sql.gz',
      'random.tar.gz',
    ];
    expect(selectArchivesForDeletion(mixed, 1)).toEqual([
      'laetoli-2026-06-15T03-00-00Z.storage.tar.gz',
      'laetoli-2026-06-16T03-00-00Z.storage.tar.gz',
    ]);
  });
});

describe('expandOffsiteCmd', () => {
  it('substitutes {file} and {name}', () => {
    const out = expandOffsiteCmd(
      'rclone copy {file} remote:laetoli/{name}',
      '/backups/laetoli-2026.sql.gz'
    );
    expect(out).toBe(
      'rclone copy /backups/laetoli-2026.sql.gz remote:laetoli/laetoli-2026.sql.gz'
    );
  });
});

describe('mirrorFile', () => {
  it('copies a file into a (created) mirror dir', () => {
    const src = tmp();
    const dst = join(tmp(), 'nested', 'usb');
    const srcFile = join(src, 'laetoli-x.sql.gz');
    writeFileSync(srcFile, 'PAYLOAD');
    const dest = mirrorFile(srcFile, dst);
    expect(dest).toBe(join(dst, 'laetoli-x.sql.gz'));
    expect(readFileSync(dest, 'utf8')).toBe('PAYLOAD');
  });
});

// ---- server integration: mirror / offsite / storage / prune ----------------

describe('runOnce with secondary targets', () => {
  it('mirrors the dump to BACKUP_MIRROR_DIR (fail-soft success path)', async () => {
    const dir = tmp();
    const mirror = tmp();
    const config = loadConfig({
      BACKUP_DIR: dir,
      BACKUP_MIRROR_DIR: mirror,
      BACKUP_INTERVAL_HOURS: '24',
    });
    const server = createServer({ config, runner: fakeRunner, log: () => {} });
    await server.runOnce(new Date('2026-06-19T03:00:00Z'));

    expect(readdirSync(mirror)).toContain('laetoli-2026-06-19T03-00-00Z.sql.gz');
    expect(server.status.mirror.enabled).toBe(true);
    expect(server.status.mirror.lastSuccess).not.toBeNull();
    expect(server.status.mirror.errorCount).toBe(0);
    expect(server.status.mirror.lastBytes).toBeGreaterThan(0);
  });

  it('mirror failure is fail-soft: primary dump still written, error metered', async () => {
    const dir = tmp();
    const config = loadConfig({
      BACKUP_DIR: dir,
      // point the mirror at a path that cannot be created (a file as a dir parent)
      BACKUP_MIRROR_DIR: join(dir, 'as-file', 'sub'),
      BACKUP_INTERVAL_HOURS: '24',
    });
    // create a regular file where a directory is expected so mkdir fails
    writeFileSync(join(dir, 'as-file'), 'x');
    const server = createServer({ config, runner: fakeRunner, log: () => {} });
    await server.runOnce(new Date('2026-06-19T03:00:00Z'));

    // primary dump untouched
    expect(readdirSync(dir)).toContain('laetoli-2026-06-19T03-00-00Z.sql.gz');
    expect(server.status.lastError).toBeNull();
    // mirror failed but metered
    expect(server.status.mirror.errorCount).toBe(1);
    expect(server.status.mirror.lastError).not.toBeNull();
  });

  it('archives the storage dir and mirrors it too', async () => {
    const dir = tmp();
    const mirror = tmp();
    const storage = tmp();
    writeFileSync(join(storage, 'object1.bin'), 'bytes');
    const { runner: cmd, calls } = recordingCmdRunner();
    const config = loadConfig({
      BACKUP_DIR: dir,
      BACKUP_MIRROR_DIR: mirror,
      BACKUP_STORAGE_DIR: storage,
      BACKUP_INTERVAL_HOURS: '24',
    });
    const server = createServer({
      config,
      runner: fakeRunner,
      cmdRunner: cmd,
      log: () => {},
    });
    await server.runOnce(new Date('2026-06-19T03:00:00Z'));

    const arc = 'laetoli-2026-06-19T03-00-00Z.storage.tar.gz';
    expect(readdirSync(dir)).toContain(arc);
    expect(readdirSync(mirror)).toContain(arc); // archive mirrored too
    expect(server.status.storageArchive.enabled).toBe(true);
    expect(server.status.storageArchive.lastSuccess).not.toBeNull();
    expect(server.status.storageArchive.lastBytes).toBeGreaterThan(0);
    // tar invoked with -C storage .
    const tarCall = calls.find((c) => c.command === 'tar');
    expect(tarCall?.args).toEqual(['-czf', join(dir, arc), '-C', storage, '.']);
  });

  it('storage-archive failure is fail-soft and does not mirror a failed archive', async () => {
    const dir = tmp();
    const mirror = tmp();
    const storage = tmp();
    const { runner: cmd } = recordingCmdRunner({ failTar: true });
    const config = loadConfig({
      BACKUP_DIR: dir,
      BACKUP_MIRROR_DIR: mirror,
      BACKUP_STORAGE_DIR: storage,
      BACKUP_INTERVAL_HOURS: '24',
    });
    const server = createServer({
      config,
      runner: fakeRunner,
      cmdRunner: cmd,
      log: () => {},
    });
    await server.runOnce(new Date('2026-06-19T03:00:00Z'));

    expect(server.status.lastError).toBeNull(); // primary fine
    expect(server.status.storageArchive.errorCount).toBe(1);
    // mirror got the dump but NOT a storage archive
    expect(readdirSync(mirror)).toContain('laetoli-2026-06-19T03-00-00Z.sql.gz');
    expect(
      readdirSync(mirror).some((f) => f.endsWith('.storage.tar.gz'))
    ).toBe(false);
  });

  it('invokes the off-site command (shell) for the dump, metered', async () => {
    const dir = tmp();
    const { runner: cmd, calls } = recordingCmdRunner();
    const config = loadConfig({
      BACKUP_DIR: dir,
      BACKUP_OFFSITE_CMD: 'rclone copy {file} remote:laetoli',
      BACKUP_INTERVAL_HOURS: '24',
    });
    const server = createServer({
      config,
      runner: fakeRunner,
      cmdRunner: cmd,
      log: () => {},
    });
    await server.runOnce(new Date('2026-06-19T03:00:00Z'));

    const shellCall = calls.find((c) => c.shell);
    expect(shellCall).toBeTruthy();
    expect(shellCall?.command).toContain('rclone copy');
    expect(shellCall?.command).toContain('laetoli-2026-06-19T03-00-00Z.sql.gz');
    expect(server.status.offsite.lastSuccess).not.toBeNull();
    expect(server.status.offsite.errorCount).toBe(0);
  });

  it('off-site failure is fail-soft and metered', async () => {
    const dir = tmp();
    const { runner: cmd } = recordingCmdRunner({ failOffsite: true });
    const config = loadConfig({
      BACKUP_DIR: dir,
      BACKUP_OFFSITE_CMD: 'false',
      BACKUP_INTERVAL_HOURS: '24',
    });
    const server = createServer({
      config,
      runner: fakeRunner,
      cmdRunner: cmd,
      log: () => {},
    });
    await server.runOnce(new Date('2026-06-19T03:00:00Z'));

    expect(server.status.lastError).toBeNull();
    expect(server.status.offsite.errorCount).toBe(1);
    expect(server.status.offsite.lastError).toContain('boom');
  });

  it('prunes dumps AND storage archives across primary + mirror dirs', async () => {
    const dir = tmp();
    const mirror = tmp();
    const storage = tmp();
    writeFileSync(join(storage, 'o.bin'), 'x');
    // pre-seed old dumps + archives in both dirs (3 each)
    for (const target of [dir, mirror]) {
      for (const d of ['15', '16', '17']) {
        writeFileSync(join(target, `laetoli-2026-06-${d}T03-00-00Z.sql.gz`), 'x');
        writeFileSync(
          join(target, `laetoli-2026-06-${d}T03-00-00Z.storage.tar.gz`),
          'x'
        );
      }
    }
    const { runner: cmd } = recordingCmdRunner();
    const config = loadConfig({
      BACKUP_DIR: dir,
      BACKUP_MIRROR_DIR: mirror,
      BACKUP_STORAGE_DIR: storage,
      BACKUP_KEEP: '2',
      BACKUP_INTERVAL_HOURS: '24',
    });
    const server = createServer({
      config,
      runner: fakeRunner,
      cmdRunner: cmd,
      log: () => {},
    });
    // new run on the 19th -> 4 dumps + 4 archives each, keep 2 -> prune oldest 2
    await server.runOnce(new Date('2026-06-19T03:00:00Z'));

    for (const target of [dir, mirror]) {
      const files = readdirSync(target).sort();
      const dumps = files.filter(isManagedDump);
      const arcs = files.filter(isManagedStorageArchive);
      expect(dumps).toEqual([
        'laetoli-2026-06-17T03-00-00Z.sql.gz',
        'laetoli-2026-06-19T03-00-00Z.sql.gz',
      ]);
      expect(arcs).toEqual([
        'laetoli-2026-06-17T03-00-00Z.storage.tar.gz',
        'laetoli-2026-06-19T03-00-00Z.storage.tar.gz',
      ]);
    }
  });

  it('does nothing extra when no secondary targets are set (default compose)', async () => {
    const dir = tmp();
    const { runner: cmd, calls } = recordingCmdRunner();
    const config = loadConfig({ BACKUP_DIR: dir, BACKUP_INTERVAL_HOURS: '24' });
    const server = createServer({
      config,
      runner: fakeRunner,
      cmdRunner: cmd,
      log: () => {},
    });
    await server.runOnce(new Date('2026-06-19T03:00:00Z'));

    expect(calls).toHaveLength(0); // no tar, no offsite
    expect(server.status.mirror.enabled).toBe(false);
    expect(server.status.offsite.enabled).toBe(false);
    expect(server.status.storageArchive.enabled).toBe(false);
    expect(readdirSync(dir)).toEqual(['laetoli-2026-06-19T03-00-00Z.sql.gz']);
  });
});

// ---- metrics ---------------------------------------------------------------

describe('renderMetrics', () => {
  it('emits primary + per-target Prometheus lines', () => {
    const status = emptyStatus('cron', '0 3 * * *', {
      mirror: true,
      storageArchive: true,
    });
    status.lastSuccess = '2026-06-19T03:00:05.000Z';
    status.count = 3;
    status.totalBytes = 4096;
    status.mirror.lastSuccess = '2026-06-19T03:00:06.000Z';
    status.mirror.lastBytes = 100;
    status.storageArchive.errorCount = 2;

    const text = renderMetrics(status);
    expect(text).toContain('laetoli_backup_dump_count 3');
    expect(text).toContain('laetoli_backup_total_bytes 4096');
    expect(text).toContain('laetoli_backup_target_enabled{target="mirror"} 1');
    expect(text).toContain('laetoli_backup_target_enabled{target="offsite"} 0');
    expect(text).toContain(
      'laetoli_backup_target_last_bytes{target="mirror"} 100'
    );
    expect(text).toContain(
      'laetoli_backup_target_errors_total{target="storage_archive"} 2'
    );
    // last_success rendered as unix seconds (non-zero)
    expect(text).toMatch(/laetoli_backup_last_success_timestamp \d{10}/);
    expect(text.endsWith('\n')).toBe(true);
  });
});

// ---- restore ---------------------------------------------------------------

describe('restore parseArgs / helpers', () => {
  it('parses flags', () => {
    expect(parseArgs(['--latest', '--storage', '--force'])).toEqual({
      latest: true,
      storage: true,
      force: true,
    });
    expect(parseArgs(['--dump', 'x.sql.gz'])).toEqual({ dump: 'x.sql.gz' });
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
  });

  it('latestDump picks the newest managed dump', () => {
    expect(
      latestDump([
        'laetoli-2026-06-15T03-00-00Z.sql.gz',
        'laetoli-2026-06-19T03-00-00Z.sql.gz',
        'foreign.sql.gz',
      ])
    ).toBe('laetoli-2026-06-19T03-00-00Z.sql.gz');
    expect(latestDump([])).toBeNull();
  });

  it('derives the storage archive path from a dump path', () => {
    expect(
      storageArchivePathFor('/backups/laetoli-2026-06-19T03-00-00Z.sql.gz')
    ).toBe('/backups/laetoli-2026-06-19T03-00-00Z.storage.tar.gz');
    expect(storageArchivePathFor('not-a-dump.txt')).toBeNull();
  });
});

describe('runRestore (mocked runner — no Postgres/Docker)', () => {
  function fakeRestoreRunner() {
    const calls: string[] = [];
    const runner: RestoreRunner = {
      async psqlRestore(_config, sqlGzPath) {
        calls.push(`psql:${basename(sqlGzPath)}`);
      },
      async extractStorage(archivePath, intoDir) {
        calls.push(`tar:${basename(archivePath)}->${intoDir}`);
      },
    };
    return { runner, calls };
  }

  it('dry run (no --force) restores nothing', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'laetoli-2026-06-19T03-00-00Z.sql.gz'), 'x');
    const config = loadConfig({ BACKUP_DIR: dir, BACKUP_INTERVAL_HOURS: '24' });
    const { runner, calls } = fakeRestoreRunner();
    const res = await runRestore(
      { latest: true },
      { config, runner, log: () => {} }
    );
    expect(res.forced).toBe(false);
    expect(res.restoredDb).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('--force restores the DB (psql), storage skipped when not requested', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'laetoli-2026-06-19T03-00-00Z.sql.gz'), 'x');
    const config = loadConfig({ BACKUP_DIR: dir, BACKUP_INTERVAL_HOURS: '24' });
    const { runner, calls } = fakeRestoreRunner();
    const res = await runRestore(
      { latest: true, force: true },
      { config, runner, log: () => {} }
    );
    expect(res.restoredDb).toBe(true);
    expect(res.restoredStorage).toBe(false);
    expect(calls).toEqual(['psql:laetoli-2026-06-19T03-00-00Z.sql.gz']);
  });

  it('--force --storage restores DB FIRST then extracts storage', async () => {
    const dir = tmp();
    const storage = tmp();
    writeFileSync(join(dir, 'laetoli-2026-06-19T03-00-00Z.sql.gz'), 'x');
    writeFileSync(
      join(dir, 'laetoli-2026-06-19T03-00-00Z.storage.tar.gz'),
      'x'
    );
    const config = loadConfig({
      BACKUP_DIR: dir,
      BACKUP_STORAGE_DIR: storage,
      BACKUP_INTERVAL_HOURS: '24',
    });
    const { runner, calls } = fakeRestoreRunner();
    const res = await runRestore(
      { latest: true, storage: true, force: true },
      { config, runner, log: () => {} }
    );
    expect(res.restoredDb).toBe(true);
    expect(res.restoredStorage).toBe(true);
    // ordering: psql before tar
    expect(calls[0]).toMatch(/^psql:/);
    expect(calls[1]).toMatch(/^tar:.*->/);
  });

  it('refuses --storage when archive is missing', async () => {
    const dir = tmp();
    const storage = tmp();
    writeFileSync(join(dir, 'laetoli-2026-06-19T03-00-00Z.sql.gz'), 'x');
    const config = loadConfig({
      BACKUP_DIR: dir,
      BACKUP_STORAGE_DIR: storage,
      BACKUP_INTERVAL_HOURS: '24',
    });
    const { runner } = fakeRestoreRunner();
    await expect(
      runRestore(
        { latest: true, storage: true, force: true },
        { config, runner, log: () => {} }
      )
    ).rejects.toThrow(/Storage archive not found/);
  });

  it('throws when the chosen dump does not exist', async () => {
    const dir = tmp();
    const config = loadConfig({ BACKUP_DIR: dir, BACKUP_INTERVAL_HOURS: '24' });
    const { runner } = fakeRestoreRunner();
    await expect(
      runRestore(
        { dump: 'nope.sql.gz', force: true },
        { config, runner, log: () => {} }
      )
    ).rejects.toThrow(/Dump not found/);
  });

  it('--list prints inventory and restores nothing', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'laetoli-2026-06-19T03-00-00Z.sql.gz'), 'x');
    const config = loadConfig({ BACKUP_DIR: dir, BACKUP_INTERVAL_HOURS: '24' });
    const { runner, calls } = fakeRestoreRunner();
    const lines: string[] = [];
    const res = await runRestore(
      { list: true },
      { config, runner, log: (m) => lines.push(m) }
    );
    expect(res.dumpPath).toBeNull();
    expect(calls).toHaveLength(0);
    expect(lines.join('\n')).toContain('laetoli-2026-06-19T03-00-00Z.sql.gz');
  });
});

// ensure existsSync import is exercised (default fileExists path)
describe('runRestore default fileExists', () => {
  it('uses real fs.existsSync when not overridden', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'laetoli-2026-06-19T03-00-00Z.sql.gz'), 'x');
    const config = loadConfig({ BACKUP_DIR: dir, BACKUP_INTERVAL_HOURS: '24' });
    const calls: string[] = [];
    const runner: RestoreRunner = {
      async psqlRestore() {
        calls.push('psql');
      },
      async extractStorage() {
        calls.push('tar');
      },
    };
    const res = await runRestore(
      { latest: true, force: true },
      { config, runner, log: () => {} }
    );
    expect(existsSync(res.dumpPath!)).toBe(true);
    expect(calls).toEqual(['psql']);
  });
});
