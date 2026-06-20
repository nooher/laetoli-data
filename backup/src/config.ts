// Configuration loaded from environment. Mirrors the other Laetoli Data
// services' conventions (DATABASE_URL or PG* parts, fail-soft sane defaults).

export interface BackupConfig {
  /** HTTP observability port. */
  port: number;
  /** Directory dumps are written to (the mounted /backups volume). */
  backupDir: string;
  /**
   * Optional SECOND target every dump (and storage archive) is copied to —
   * e.g. a mounted USB drive. Empty/undefined disables mirroring. Fail-soft:
   * a mirror error never aborts the primary dump.
   */
  mirrorDir?: string;
  /**
   * Optional off-site push command template, run AFTER a successful dump. The
   * tokens `{file}` (absolute dump path) and `{name}` (basename) are
   * substituted; e.g. `rclone copy {file} remote:laetoli` or
   * `scp {file} pi@host:/backups`. Fail-soft. Empty/undefined disables it.
   */
  offsiteCmd?: string;
  /**
   * Optional path to the object-storage root (the storage_data volume). When
   * set, each run also writes a tar.gz of this directory next to the pg_dump,
   * pruned by the same retention. Empty/undefined skips storage archiving.
   */
  storageDir?: string;
  /** How many dumps (and storage archives) to retain (oldest beyond this are pruned). */
  keep: number;
  /** 5-field cron string (preferred). Empty when interval mode is used. */
  cron: string;
  /** Simple alternative: run every N hours. Used only if BACKUP_CRON unset. */
  intervalHours: number | null;
  /** Logical DB name (used in the dump filename + pg_dump -d). */
  dbName: string;
  /** Connection: a full DATABASE_URL takes priority over the PG* parts. */
  databaseUrl?: string;
  pg: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
}

function parseIntOr(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const dbName = env.POSTGRES_DB ?? 'laetoli';

  // Cron takes priority; if it's blank, fall back to interval-hours mode.
  const cron = (env.BACKUP_CRON ?? '').trim();
  const intervalRaw = env.BACKUP_INTERVAL_HOURS;
  const intervalHours =
    cron.length === 0 && intervalRaw
      ? parseIntOr(intervalRaw, 24)
      : cron.length === 0
        ? 24 // neither set -> daily by interval as a safe default
        : null;

  // Off-device targets — all optional so the default compose is unchanged.
  const mirrorDir = (env.BACKUP_MIRROR_DIR ?? '').trim();
  const offsiteCmd = (env.BACKUP_OFFSITE_CMD ?? '').trim();
  const storageDir = (env.BACKUP_STORAGE_DIR ?? '').trim();

  return {
    port: parseIntOr(env.BACKUP_PORT, 9994),
    backupDir: env.BACKUP_DIR ?? '/backups',
    mirrorDir: mirrorDir.length > 0 ? mirrorDir : undefined,
    offsiteCmd: offsiteCmd.length > 0 ? offsiteCmd : undefined,
    storageDir: storageDir.length > 0 ? storageDir : undefined,
    keep: parseIntOr(env.BACKUP_KEEP, 14),
    cron: cron.length > 0 ? cron : '0 3 * * *', // documented default, used if cron mode
    intervalHours,
    dbName,
    databaseUrl: env.DATABASE_URL,
    pg: {
      host: env.PGHOST ?? env.POSTGRES_HOST ?? 'db',
      port: parseIntOr(env.PGPORT ?? env.POSTGRES_PORT, 5432),
      user: env.PGUSER ?? env.POSTGRES_USER ?? 'laetoli',
      password: env.PGPASSWORD ?? env.POSTGRES_PASSWORD ?? '',
      database: env.PGDATABASE ?? dbName,
    },
  };
}

/** True when we should schedule by cron string rather than fixed interval. */
export function usesCron(config: BackupConfig): boolean {
  return config.intervalHours === null;
}
