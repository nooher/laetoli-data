// metrics.ts — render the in-memory BackupStatus as Prometheus text exposition
// (content-type version 0.0.4). Pure + dependency-free so the shape is testable
// and the operator can scrape /metrics to SEE that backups are healthy:
// primary dump freshness + each secondary target (mirror / off-site / storage
// archive) success timestamps, sizes, and fail-soft error counters.

import type { BackupStatus, TargetStatus } from './status.js';

/** ISO timestamp -> unix seconds, or 0 when null/unparseable. */
function unixSeconds(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

function bool(b: boolean): string {
  return b ? '1' : '0';
}

/** Emit the per-target block shared by mirror / offsite / storage_archive. */
function targetLines(target: string, s: TargetStatus): string[] {
  return [
    `laetoli_backup_target_enabled{target="${target}"} ${bool(s.enabled)}`,
    `laetoli_backup_target_last_success_timestamp{target="${target}"} ${unixSeconds(
      s.lastSuccess
    )}`,
    `laetoli_backup_target_errors_total{target="${target}"} ${s.errorCount}`,
    `laetoli_backup_target_last_bytes{target="${target}"} ${s.lastBytes ?? 0}`,
  ];
}

/** Render the full Prometheus exposition for the given status snapshot. */
export function renderMetrics(status: BackupStatus): string {
  const lines: string[] = [];

  lines.push('# HELP laetoli_backup_last_run_timestamp Unix time of the last run attempt.');
  lines.push('# TYPE laetoli_backup_last_run_timestamp gauge');
  lines.push(`laetoli_backup_last_run_timestamp ${unixSeconds(status.lastRun)}`);

  lines.push('# HELP laetoli_backup_last_success_timestamp Unix time of the last successful dump.');
  lines.push('# TYPE laetoli_backup_last_success_timestamp gauge');
  lines.push(
    `laetoli_backup_last_success_timestamp ${unixSeconds(status.lastSuccess)}`
  );

  lines.push('# HELP laetoli_backup_next_run_timestamp Unix time of the next scheduled run.');
  lines.push('# TYPE laetoli_backup_next_run_timestamp gauge');
  lines.push(`laetoli_backup_next_run_timestamp ${unixSeconds(status.nextRun)}`);

  lines.push('# HELP laetoli_backup_dump_count Number of managed dumps on disk.');
  lines.push('# TYPE laetoli_backup_dump_count gauge');
  lines.push(`laetoli_backup_dump_count ${status.count}`);

  lines.push('# HELP laetoli_backup_total_bytes Total bytes of managed dumps on disk.');
  lines.push('# TYPE laetoli_backup_total_bytes gauge');
  lines.push(`laetoli_backup_total_bytes ${status.totalBytes}`);

  lines.push('# HELP laetoli_backup_last_error 1 if the last run failed, else 0.');
  lines.push('# TYPE laetoli_backup_last_error gauge');
  lines.push(`laetoli_backup_last_error ${bool(status.lastError !== null)}`);

  // Secondary targets — one labelled series per metric.
  lines.push('# HELP laetoli_backup_target_enabled 1 if the operator configured this target.');
  lines.push('# TYPE laetoli_backup_target_enabled gauge');
  lines.push('# HELP laetoli_backup_target_last_success_timestamp Unix time of the last success per target.');
  lines.push('# TYPE laetoli_backup_target_last_success_timestamp gauge');
  lines.push('# HELP laetoli_backup_target_errors_total Fail-soft error count per target.');
  lines.push('# TYPE laetoli_backup_target_errors_total counter');
  lines.push('# HELP laetoli_backup_target_last_bytes Size in bytes of the last artifact per target.');
  lines.push('# TYPE laetoli_backup_target_last_bytes gauge');

  lines.push(...targetLines('mirror', status.mirror));
  lines.push(...targetLines('offsite', status.offsite));
  lines.push(...targetLines('storage_archive', status.storageArchive));

  return lines.join('\n') + '\n';
}
