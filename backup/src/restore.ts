// restore.ts — the guarded restore path for Laetoli Data backups.
//
// Restoring is DESTRUCTIVE (the dumps are taken with `pg_dump --clean
// --if-exists`, so applying one DROPs + recreates every object). So restore is
// gated behind an explicit `--force` flag; without it we only print what WOULD
// happen. The actual work shells out through an INJECTED runner so tests assert
// the plan/argv without spawning psql or tar (no real Postgres/Docker needed).
//
//   laetoli-restore --dump laetoli-2026-06-19T03-00-00Z.sql.gz --force
//   laetoli-restore --latest --force                  # newest dump in BACKUP_DIR
//   laetoli-restore --latest --storage --force        # also restore storage bytes
//   laetoli-restore --list                            # show restorable backups
//
// Ordering/safety: the pg_dump restore runs FIRST (it owns the --clean), then —
// only if it succeeded — the optional storage archive is extracted into the
// storage root. We never extract storage over a failed DB restore.

import { spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { createReadStream, readdirSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  isManagedDump,
  isManagedStorageArchive,
  storageArchiveFilename,
  DUMP_SUFFIX,
  STORAGE_SUFFIX,
} from './backup.js';
import { loadConfig, type BackupConfig } from './config.js';

export interface RestoreOptions {
  /** Dump filename (in BACKUP_DIR) or absolute path. */
  dump?: string;
  /** Pick the newest managed dump in BACKUP_DIR. */
  latest?: boolean;
  /** Also restore the matching storage archive into config.storageDir. */
  storage?: boolean;
  /** Required to actually mutate anything; otherwise this is a dry run. */
  force?: boolean;
  /** Just list restorable backups and exit. */
  list?: boolean;
}

/** Parse argv (after `node restore.js`) into RestoreOptions. Pure + testable. */
export function parseArgs(argv: string[]): RestoreOptions {
  const opts: RestoreOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dump':
        opts.dump = argv[++i];
        break;
      case '--latest':
        opts.latest = true;
        break;
      case '--storage':
        opts.storage = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--list':
        opts.list = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

/** Newest managed dump filename in a directory, or null if none. */
export function latestDump(files: string[]): string | null {
  const managed = files.filter(isManagedDump).sort();
  return managed.length ? managed[managed.length - 1] : null;
}

/** Resolve the chosen dump to an absolute path; throws with a clear message. */
export function resolveDumpPath(
  opts: RestoreOptions,
  config: BackupConfig,
  files: string[]
): string {
  if (opts.dump) {
    return isAbsolute(opts.dump) ? opts.dump : join(config.backupDir, opts.dump);
  }
  if (opts.latest) {
    const name = latestDump(files);
    if (!name) throw new Error(`No managed dumps found in ${config.backupDir}`);
    return join(config.backupDir, name);
  }
  throw new Error('Specify a dump with --dump <file> or --latest.');
}

/**
 * Given a dump path, the matching storage archive path (same timestamp). Works
 * for `*.sql.gz` produced by this service; returns null if the name doesn't
 * follow our convention.
 */
export function storageArchivePathFor(dumpPath: string): string | null {
  if (!dumpPath.endsWith(DUMP_SUFFIX)) return null;
  return dumpPath.slice(0, -DUMP_SUFFIX.length) + STORAGE_SUFFIX;
}

/**
 * A runner abstracts the two restore shell-outs so tests inject fakes:
 *   psql(args, stdin)  — feed the gunzipped SQL into psql's stdin.
 *   extractTar(archive, intoDir) — tar -xzf archive -C intoDir.
 */
export interface RestoreRunner {
  /** Pipe `sqlPath` (gzip) through gunzip into psql; resolve on exit 0. */
  psqlRestore(config: BackupConfig, sqlGzPath: string): Promise<void>;
  /** Extract a storage tar.gz into `intoDir`; resolve on exit 0. */
  extractStorage(archivePath: string, intoDir: string): Promise<void>;
}

/** Real runner: streams gunzip -> psql stdin, and shells out to tar. */
export const realRestoreRunner: RestoreRunner = {
  async psqlRestore(config, sqlGzPath) {
    const args = config.databaseUrl
      ? ['--dbname', config.databaseUrl]
      : [
          '-h', config.pg.host,
          '-p', String(config.pg.port),
          '-U', config.pg.user,
          '-d', config.pg.database,
        ];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (!config.databaseUrl) env.PGPASSWORD = config.pg.password;

    const child = spawn('psql', ['-v', 'ON_ERROR_STOP=1', ...args], {
      env,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    const done = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`psql exited ${code}: ${stderr.trim()}`));
      });
    });
    await Promise.all([
      pipeline(createReadStream(sqlGzPath), createGunzip(), child.stdin),
      done,
    ]);
  },

  extractStorage(archivePath, intoDir) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn('tar', ['-xzf', archivePath, '-C', intoDir], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
      });
    });
  },
};

export interface RestoreDeps {
  config: BackupConfig;
  runner?: RestoreRunner;
  log?: (msg: string) => void;
  /** Override for tests; defaults to reading config.backupDir. */
  listFiles?: (dir: string) => string[];
  /** Override for tests; defaults to fs.existsSync. */
  fileExists?: (path: string) => boolean;
}

/**
 * Run the restore. Returns a small report describing what happened (or what
 * WOULD happen on a dry run) so callers/tests can assert behaviour.
 */
export async function runRestore(
  opts: RestoreOptions,
  deps: RestoreDeps
): Promise<{
  dumpPath: string | null;
  storagePath: string | null;
  forced: boolean;
  restoredDb: boolean;
  restoredStorage: boolean;
}> {
  const { config } = deps;
  const runner = deps.runner ?? realRestoreRunner;
  const log = deps.log ?? ((m: string) => console.log(`[restore] ${m}`));
  const listFiles = deps.listFiles ?? ((d: string) => safeReaddir(d));
  const fileExists = deps.fileExists ?? ((p: string) => existsSync(p));

  const files = listFiles(config.backupDir);

  if (opts.list) {
    const dumps = files.filter(isManagedDump).sort();
    const archives = files.filter(isManagedStorageArchive).sort();
    log(`Restorable dumps in ${config.backupDir}:`);
    for (const d of dumps) log(`  ${d}`);
    log(`Storage archives:`);
    for (const a of archives) log(`  ${a}`);
    return {
      dumpPath: null,
      storagePath: null,
      forced: false,
      restoredDb: false,
      restoredStorage: false,
    };
  }

  const dumpPath = resolveDumpPath(opts, config, files);
  if (!fileExists(dumpPath)) {
    throw new Error(`Dump not found: ${dumpPath}`);
  }

  let storagePath: string | null = null;
  if (opts.storage) {
    if (!config.storageDir) {
      throw new Error(
        '--storage requested but BACKUP_STORAGE_DIR is not set (no restore target).'
      );
    }
    storagePath = storageArchivePathFor(dumpPath);
    if (!storagePath || !fileExists(storagePath)) {
      throw new Error(
        `Storage archive not found for ${dumpPath} (expected ${
          storagePath ?? storageArchiveFilename()
        })`
      );
    }
  }

  if (!opts.force) {
    log('DRY RUN (no --force). Would perform:');
    log(`  1. Restore database from ${dumpPath} (DESTRUCTIVE: --clean drops objects).`);
    if (storagePath) {
      log(`  2. Extract storage archive ${storagePath} into ${config.storageDir}.`);
    }
    log('Re-run with --force to execute.');
    return {
      dumpPath,
      storagePath,
      forced: false,
      restoredDb: false,
      restoredStorage: false,
    };
  }

  // (1) Database first — it owns the --clean drop/recreate.
  log(`Restoring database from ${dumpPath} ...`);
  await runner.psqlRestore(config, dumpPath);
  log('Database restore complete.');

  // (2) Storage bytes only after the DB restore succeeded.
  let restoredStorage = false;
  if (storagePath && config.storageDir) {
    log(`Extracting storage archive ${storagePath} -> ${config.storageDir} ...`);
    await runner.extractStorage(storagePath, config.storageDir);
    restoredStorage = true;
    log('Storage restore complete.');
  }

  return {
    dumpPath,
    storagePath,
    forced: true,
    restoredDb: true,
    restoredStorage,
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---- entry point ----------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  await runRestore(opts, { config });
}

if (import.meta.url.endsWith('/restore.js')) {
  main().catch((e) => {
    console.error(`[restore] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
