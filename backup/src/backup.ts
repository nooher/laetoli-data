// backup.ts — the pure backup logic + the (injectable) shell-out wrapper.
//
// Pure, exhaustively-testable helpers:
//   * dumpFilename()      — builds the timestamped gzip dump name.
//   * selectForDeletion() — given a file list + keep N, returns the oldest
//                           dumps to prune (only our own *.sql.gz files).
//   * buildPgDumpArgs()   — the pg_dump argv (so we can assert it in tests).
//
// The actual dump shells out to pg_dump via an INJECTED Runner so tests never
// spawn a process. runBackup() wires it together and writes the gzip file.

import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { createWriteStream, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { BackupConfig } from './config.js';

/** Prefix all our managed dumps share — used for safe retention matching. */
export const DUMP_PREFIX = 'laetoli-';
export const DUMP_SUFFIX = '.sql.gz';
const DUMP_RE = /^laetoli-.+\.sql\.gz$/;

/** Object-storage archives share this suffix (still the laetoli- prefix). */
export const STORAGE_SUFFIX = '.storage.tar.gz';
const STORAGE_RE = /^laetoli-.+\.storage\.tar\.gz$/;

/** Build a sortable, filesystem-safe timestamped dump filename. */
export function dumpFilename(now: Date = new Date()): string {
  // 2026-06-19T03-00-00Z  -> lexicographically sortable, no ':' (Windows-safe).
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${DUMP_PREFIX}${iso}${DUMP_SUFFIX}`;
}

/** Build the matching storage-archive filename for the same instant. */
export function storageArchiveFilename(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${DUMP_PREFIX}${iso}${STORAGE_SUFFIX}`;
}

/** True for files this service manages (so we never delete foreign files). */
export function isManagedDump(name: string): boolean {
  return DUMP_RE.test(name);
}

/** True for storage archives this service manages. */
export function isManagedStorageArchive(name: string): boolean {
  return STORAGE_RE.test(name);
}

/**
 * Given the current dump filenames and the keep-count, return the names that
 * should be deleted (the oldest, beyond the newest N). Only managed dumps are
 * considered; names sort lexicographically which equals chronological because
 * the timestamp is ISO-8601. Pure — caller does the unlinking.
 */
export function selectForDeletion(files: string[], keep: number): string[] {
  return selectForDeletionMatching(files, keep, isManagedDump);
}

/** Same retention rule as selectForDeletion, for storage archives. */
export function selectArchivesForDeletion(files: string[], keep: number): string[] {
  return selectForDeletionMatching(files, keep, isManagedStorageArchive);
}

/**
 * Shared retention core: keep the newest N of whatever `match` selects, return
 * the older ones (sorted ascending = oldest first, since names are ISO-stamped).
 */
export function selectForDeletionMatching(
  files: string[],
  keep: number,
  match: (name: string) => boolean
): string[] {
  const managed = files.filter(match).sort(); // ascending => oldest first
  if (keep <= 0) return managed; // keep 0 -> prune all (degenerate, but defined)
  if (managed.length <= keep) return [];
  return managed.slice(0, managed.length - keep);
}

/** Build the pg_dump argv. Uses DATABASE_URL if present, else PG* flags. */
export function buildPgDumpArgs(config: BackupConfig): string[] {
  if (config.databaseUrl) {
    return ['--dbname', config.databaseUrl, '--clean', '--if-exists'];
  }
  return [
    '-h',
    config.pg.host,
    '-p',
    String(config.pg.port),
    '-U',
    config.pg.user,
    '-d',
    config.pg.database,
    '--clean',
    '--if-exists',
  ];
}

/**
 * A runner abstracts "spawn pg_dump and give me its stdout as a stream".
 * Tests inject a fake that yields a canned Readable so no process is spawned.
 */
export interface DumpRunner {
  run(
    args: string[],
    env: NodeJS.ProcessEnv
  ): { stdout: Readable; done: Promise<void> };
}

/** Real runner: spawns pg_dump, surfaces a non-zero exit as a rejected promise. */
export const realDumpRunner: DumpRunner = {
  run(args, env) {
    const child = spawn('pg_dump', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    const done = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pg_dump exited ${code}: ${stderr.trim()}`));
      });
    });
    return { stdout: child.stdout, done };
  },
};

/** Env passed to pg_dump — inject PGPASSWORD so it never prompts. */
export function dumpEnv(config: BackupConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!config.databaseUrl) {
    env.PGPASSWORD = config.pg.password;
  }
  return env;
}

/**
 * Run pg_dump and stream-gzip its output to `outPath`. The dump stream and the
 * gzip write run concurrently (constant memory — important on a Pi). Throws if
 * pg_dump fails.
 */
export async function runBackup(
  config: BackupConfig,
  outPath: string,
  runner: DumpRunner = realDumpRunner
): Promise<void> {
  const args = buildPgDumpArgs(config);
  const { stdout, done } = runner.run(args, dumpEnv(config));
  const gzip = createGzip();
  const out = createWriteStream(outPath);
  await Promise.all([pipeline(stdout, gzip, out), done]);
}

// ---- secondary / off-device targets ---------------------------------------
//
// All of the below are env-gated by the server (only invoked when the matching
// config is set) and called fail-soft (their failures are caught + logged +
// metered by the caller, never aborting the primary dump).

/**
 * A command runner abstracts "spawn this program and resolve when it exits 0".
 * Used for tar (storage archive) and the operator's off-site push command, so
 * tests can inject a fake that never spawns a process.
 */
export interface CmdRunner {
  run(
    command: string,
    args: string[],
    opts?: { shell?: boolean; env?: NodeJS.ProcessEnv }
  ): Promise<void>;
}

/** Real command runner: spawns, captures stderr, rejects on non-zero exit. */
export const realCmdRunner: CmdRunner = {
  run(command, args, opts) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: opts?.shell ?? false,
        env: opts?.env ?? process.env,
      });
      let stderr = '';
      child.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
      });
    });
  },
};

/**
 * Copy a finished backup file into the mirror directory (e.g. a USB drive),
 * creating the directory if needed. Returns the destination path. Throws on
 * failure (the caller treats it fail-soft).
 */
export function mirrorFile(srcPath: string, mirrorDir: string): string {
  mkdirSync(mirrorDir, { recursive: true });
  const dest = join(mirrorDir, basename(srcPath));
  copyFileSync(srcPath, dest);
  return dest;
}

/**
 * Archive the object-storage directory to `outPath` as a tar.gz via the system
 * `tar`. `-C storageDir .` keeps paths relative so the archive restores cleanly
 * into any storage root. Resolves with the bytes written.
 */
export async function archiveStorageDir(
  storageDir: string,
  outPath: string,
  runner: CmdRunner = realCmdRunner
): Promise<number> {
  await runner.run('tar', ['-czf', outPath, '-C', storageDir, '.']);
  try {
    return statSync(outPath).size;
  } catch {
    return 0;
  }
}

/**
 * Expand an off-site command template, substituting `{file}` (absolute dump
 * path) and `{name}` (its basename). Pure — exported so tests can assert it.
 */
export function expandOffsiteCmd(template: string, filePath: string): string {
  return template
    .replace(/\{file\}/g, filePath)
    .replace(/\{name\}/g, basename(filePath));
}

/**
 * Run the operator's off-site push command for `filePath`. The template is run
 * through a shell (so operators can use pipes/quoting natural to rclone/scp).
 * Throws on non-zero exit; the caller treats it fail-soft.
 */
export async function runOffsiteCmd(
  template: string,
  filePath: string,
  runner: CmdRunner = realCmdRunner
): Promise<void> {
  const cmd = expandOffsiteCmd(template, filePath);
  await runner.run(cmd, [], { shell: true });
}
