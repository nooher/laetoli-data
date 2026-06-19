// status.ts — the in-memory observability snapshot the HTTP endpoint reports.
// Kept as its own pure-ish module so the JSON shape is testable.

export interface BackupStatus {
  service: 'laetoli-backup';
  /** ISO timestamp of the last run attempt (success or failure), or null. */
  lastRun: string | null;
  /** ISO timestamp of the last SUCCESSFUL run, or null. */
  lastSuccess: string | null;
  /** Error message from the last failed run, or null. */
  lastError: string | null;
  /** Count of *.sql.gz dumps currently on disk. */
  count: number;
  /** Total bytes of all managed dumps. */
  totalBytes: number;
  /** ISO timestamp of the next scheduled run, or null if unknown. */
  nextRun: string | null;
  /** "cron" or "interval". */
  mode: 'cron' | 'interval';
  /** The cron expression or interval description in force. */
  schedule: string;
}

export function emptyStatus(
  mode: 'cron' | 'interval',
  schedule: string
): BackupStatus {
  return {
    service: 'laetoli-backup',
    lastRun: null,
    lastSuccess: null,
    lastError: null,
    count: 0,
    totalBytes: 0,
    nextRun: null,
    mode,
    schedule,
  };
}
