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
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { BackupConfig } from './config.js';

/** Prefix all our managed dumps share — used for safe retention matching. */
export const DUMP_PREFIX = 'laetoli-';
export const DUMP_SUFFIX = '.sql.gz';
const DUMP_RE = /^laetoli-.+\.sql\.gz$/;

/** Build a sortable, filesystem-safe timestamped dump filename. */
export function dumpFilename(now: Date = new Date()): string {
  // 2026-06-19T03-00-00Z  -> lexicographically sortable, no ':' (Windows-safe).
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${DUMP_PREFIX}${iso}${DUMP_SUFFIX}`;
}

/** True for files this service manages (so we never delete foreign files). */
export function isManagedDump(name: string): boolean {
  return DUMP_RE.test(name);
}

/**
 * Given the current dump filenames and the keep-count, return the names that
 * should be deleted (the oldest, beyond the newest N). Only managed dumps are
 * considered; names sort lexicographically which equals chronological because
 * the timestamp is ISO-8601. Pure — caller does the unlinking.
 */
export function selectForDeletion(files: string[], keep: number): string[] {
  const managed = files.filter(isManagedDump).sort(); // ascending => oldest first
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
