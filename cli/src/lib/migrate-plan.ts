// migrate-plan.ts — pure migration planning. Given the migration files found on
// disk (name + contents) and the set already applied (name -> checksum), decide
// which are pending, in what order, and whether any applied file has changed.
import { createHash } from 'node:crypto';

export interface MigrationFile {
  name: string; // bare filename, e.g. "0001_storage.sql"
  contents: string;
}

export interface AppliedMigration {
  name: string;
  checksum: string;
}

export interface PlannedMigration {
  name: string;
  contents: string;
  checksum: string;
}

export interface MigrationPlan {
  /** Pending migrations to run, in lexicographic order. */
  pending: PlannedMigration[];
  /** Already-applied migrations still present on disk, in order. */
  applied: PlannedMigration[];
  /**
   * Files whose checksum no longer matches what was recorded as applied — a
   * tampered/edited migration. `migrate` must refuse to proceed when non-empty.
   */
  changed: { name: string; oldChecksum: string; newChecksum: string }[];
  /** Applied migrations recorded in the DB but missing from disk (informational). */
  missing: string[];
}

/** SHA-256 hex checksum of a migration's contents (newline-normalized). */
export function checksum(contents: string): string {
  const normalized = contents.replace(/\r\n/g, '\n');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** Lexicographic sort by filename — the documented ordering convention. */
export function sortFiles(files: MigrationFile[]): MigrationFile[] {
  return [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Build a migration plan. Pure: no fs, no DB. Detects drift (changed checksums)
 * on already-applied files so the runner can refuse.
 */
export function planMigrations(
  files: MigrationFile[],
  appliedList: AppliedMigration[],
): MigrationPlan {
  const applied = new Map(appliedList.map((a) => [a.name, a.checksum]));
  const onDisk = new Set(files.map((f) => f.name));

  const sorted = sortFiles(files);
  const plan: MigrationPlan = { pending: [], applied: [], changed: [], missing: [] };

  for (const f of sorted) {
    const sum = checksum(f.contents);
    const planned: PlannedMigration = { name: f.name, contents: f.contents, checksum: sum };
    const prev = applied.get(f.name);
    if (prev === undefined) {
      plan.pending.push(planned);
    } else {
      plan.applied.push(planned);
      if (prev !== sum) {
        plan.changed.push({ name: f.name, oldChecksum: prev, newChecksum: sum });
      }
    }
  }

  for (const a of appliedList) {
    if (!onDisk.has(a.name)) plan.missing.push(a.name);
  }

  return plan;
}

/** Only `*.sql` files are migrations; everything else (README, .gitkeep) ignored. */
export function isSqlFile(name: string): boolean {
  return name.toLowerCase().endsWith('.sql');
}
