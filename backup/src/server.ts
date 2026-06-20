// server.ts — the backup daemon. Wires config + scheduler + the dump/prune
// cycle and exposes a tiny HTTP server (/health, /status) for observability.
//
// Scheduling is dependency-light: either a 5-field cron string (parsed by our
// own cron.ts) or a fixed BACKUP_INTERVAL_HOURS. A single setTimeout is armed
// for the next run; after each run we re-arm. No cron library, no setInterval
// drift across DST because cron mode recomputes from the wall clock each time.

import http from 'node:http';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, usesCron, type BackupConfig } from './config.js';
import { parseCron, nextRun, type CronFields } from './cron.js';
import {
  dumpFilename,
  storageArchiveFilename,
  isManagedDump,
  isManagedStorageArchive,
  selectForDeletion,
  selectArchivesForDeletion,
  runBackup,
  archiveStorageDir,
  mirrorFile,
  runOffsiteCmd,
  type DumpRunner,
  type CmdRunner,
  realDumpRunner,
  realCmdRunner,
} from './backup.js';
import { emptyStatus, type BackupStatus } from './status.js';
import { renderMetrics } from './metrics.js';

export interface BackupServer {
  httpServer: http.Server;
  status: BackupStatus;
  /** Run one backup+prune cycle now (used by the scheduler and tests). */
  runOnce(now?: Date): Promise<void>;
  /** Compute the next scheduled run instant from `from`. */
  computeNextRun(from: Date): Date;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface ServerDeps {
  config: BackupConfig;
  /** Injected dump runner (defaults to the real pg_dump spawner). */
  runner?: DumpRunner;
  /** Injected command runner for tar + off-site cmd (defaults to real spawn). */
  cmdRunner?: CmdRunner;
  /** Injected logger (defaults to console.log). */
  log?: (msg: string) => void;
}

export function createServer(deps: ServerDeps): BackupServer {
  const { config } = deps;
  const runner = deps.runner ?? realDumpRunner;
  const cmdRunner = deps.cmdRunner ?? realCmdRunner;
  const log = deps.log ?? ((m: string) => console.log(`[backup] ${m}`));

  const cronMode = usesCron(config);
  const fields: CronFields | null = cronMode ? parseCron(config.cron) : null;
  const schedule = cronMode
    ? config.cron
    : `every ${config.intervalHours}h`;
  const status = emptyStatus(cronMode ? 'cron' : 'interval', schedule, {
    mirror: Boolean(config.mirrorDir),
    offsite: Boolean(config.offsiteCmd),
    storageArchive: Boolean(config.storageDir),
  });

  let timer: NodeJS.Timeout | null = null;

  function computeNextRun(from: Date): Date {
    if (cronMode && fields) return nextRun(fields, from);
    const hours = config.intervalHours ?? 24;
    return new Date(from.getTime() + hours * 3600_000);
  }

  /** Scan the backup dir, refreshing count + totalBytes on the status. */
  function refreshInventory(): void {
    let count = 0;
    let bytes = 0;
    try {
      for (const name of readdirSync(config.backupDir)) {
        if (!isManagedDump(name)) continue;
        count += 1;
        bytes += statSync(join(config.backupDir, name)).size;
      }
    } catch {
      /* dir may not exist yet */
    }
    status.count = count;
    status.totalBytes = bytes;
  }

  /** Delete files matching `match` beyond `keep`, in `dir`. Fail-soft per file. */
  function pruneDir(
    dir: string,
    match: (files: string[], keep: number) => string[]
  ): void {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return; // dir may not exist (e.g. mirror drive unplugged) — skip.
    }
    for (const name of match(files, config.keep)) {
      try {
        unlinkSync(join(dir, name));
        log(`pruned old backup: ${name} (${dir})`);
      } catch (e) {
        log(`failed to prune ${name} in ${dir}: ${errMsg(e)}`);
      }
    }
  }

  /** Copy a finished artifact to the mirror dir (fail-soft, metered). */
  function mirrorTo(srcPath: string): void {
    if (!config.mirrorDir) return;
    try {
      const dest = mirrorFile(srcPath, config.mirrorDir);
      status.mirror.lastSuccess = new Date().toISOString();
      status.mirror.lastError = null;
      try {
        status.mirror.lastBytes = statSync(dest).size;
      } catch {
        /* best-effort size */
      }
      log(`mirrored ${srcPath} -> ${dest}`);
    } catch (e) {
      status.mirror.lastError = errMsg(e);
      status.mirror.errorCount += 1;
      log(`mirror FAILED for ${srcPath}: ${status.mirror.lastError}`);
    }
  }

  async function runOnce(now: Date = new Date()): Promise<void> {
    status.lastRun = now.toISOString();
    const outName = dumpFilename(now);
    const outPath = join(config.backupDir, outName);
    log(`starting dump -> ${outName}`);
    try {
      mkdirSync(config.backupDir, { recursive: true });
      await runBackup(config, outPath, runner);
      status.lastSuccess = new Date().toISOString();
      status.lastError = null;
      log(`dump complete: ${outName}`);

      // (1) Optional storage-directory archive alongside the pg_dump.
      let storagePath: string | null = null;
      if (config.storageDir) {
        const arcName = storageArchiveFilename(now);
        storagePath = join(config.backupDir, arcName);
        try {
          const bytes = await archiveStorageDir(
            config.storageDir,
            storagePath,
            cmdRunner
          );
          status.storageArchive.lastSuccess = new Date().toISOString();
          status.storageArchive.lastError = null;
          status.storageArchive.lastBytes = bytes;
          log(`storage archive complete: ${arcName} (${bytes} bytes)`);
        } catch (e) {
          status.storageArchive.lastError = errMsg(e);
          status.storageArchive.errorCount += 1;
          storagePath = null; // don't mirror/offsite a failed archive
          log(`storage archive FAILED: ${status.storageArchive.lastError}`);
        }
      }

      // (2) Mirror each artifact to the second target (fail-soft).
      mirrorTo(outPath);
      if (storagePath) mirrorTo(storagePath);

      // (3) Off-site push hook (fail-soft, metered).
      if (config.offsiteCmd) {
        for (const p of storagePath ? [outPath, storagePath] : [outPath]) {
          try {
            await runOffsiteCmd(config.offsiteCmd, p, cmdRunner);
            status.offsite.lastSuccess = new Date().toISOString();
            status.offsite.lastError = null;
            try {
              status.offsite.lastBytes = statSync(p).size;
            } catch {
              /* best-effort */
            }
            log(`off-site push ok: ${p}`);
          } catch (e) {
            status.offsite.lastError = errMsg(e);
            status.offsite.errorCount += 1;
            log(`off-site push FAILED for ${p}: ${status.offsite.lastError}`);
          }
        }
      }

      // (4) Prune old dumps + storage archives beyond BACKUP_KEEP, in BOTH the
      //     primary dir and (if set) the mirror dir.
      pruneDir(config.backupDir, selectForDeletion);
      pruneDir(config.backupDir, selectArchivesForDeletion);
      if (config.mirrorDir) {
        pruneDir(config.mirrorDir, selectForDeletion);
        pruneDir(config.mirrorDir, selectArchivesForDeletion);
      }
    } catch (e) {
      status.lastError = errMsg(e);
      log(`dump FAILED: ${status.lastError}`);
    } finally {
      refreshInventory();
    }
  }

  function arm(): void {
    const now = new Date();
    const next = computeNextRun(now);
    status.nextRun = next.toISOString();
    const delay = Math.max(0, next.getTime() - now.getTime());
    log(`next run at ${status.nextRun} (in ${Math.round(delay / 1000)}s)`);
    timer = setTimeout(() => {
      void runOnce().finally(arm);
    }, delay);
    timer.unref?.();
  }

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'laetoli-backup' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/status') {
      refreshInventory();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }
    if (req.method === 'GET' && req.url === '/metrics') {
      refreshInventory();
      res.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      });
      res.end(renderMetrics(status));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Njia haipatikani.' }));
  });

  return {
    httpServer,
    status,
    runOnce,
    computeNextRun,
    async start() {
      refreshInventory();
      arm();
      await new Promise<void>((resolve) => {
        httpServer.listen(config.port, () => {
          log(
            `Laetoli Data backup service listening on :${config.port} ` +
              `(dir ${config.backupDir}, keep ${config.keep}, schedule "${schedule}")`
          );
          resolve();
        });
      });
    },
    async close() {
      if (timer) clearTimeout(timer);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---- entry point ----------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer({ config });
  await server.start();

  const shutdown = (signal: string) => {
    console.log(`[backup] ${signal} received, shutting down...`);
    server.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (import.meta.url.endsWith('/server.js')) {
  void main();
}
