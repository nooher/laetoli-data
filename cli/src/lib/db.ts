// db.ts — Postgres access for migrate/seed/status, via the `pg` Pool. The
// migrations-tracking table lives at public._laetoli_migrations. Each pending
// migration runs inside its OWN transaction so a failure rolls back cleanly and
// later ones don't run.
import pg from 'pg';
import type { AppliedMigration, PlannedMigration } from './migrate-plan.js';

const { Pool } = pg;

const TRACK_TABLE = 'public._laetoli_migrations';

const ENSURE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${TRACK_TABLE} (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  checksum    text NOT NULL
);`;

export interface Db {
  ensureTrackingTable(): Promise<void>;
  appliedMigrations(): Promise<AppliedMigration[]>;
  applyMigration(m: PlannedMigration): Promise<void>;
  runSql(sql: string): Promise<void>;
  end(): Promise<void>;
}

/** Open a pg-backed Db against the given connection string. */
export function openDb(connectionString: string): Db {
  const pool = new Pool({ connectionString });
  return {
    async ensureTrackingTable() {
      await pool.query(ENSURE_TABLE_SQL);
    },
    async appliedMigrations() {
      const { rows } = await pool.query<{ name: string; checksum: string }>(
        `SELECT name, checksum FROM ${TRACK_TABLE} ORDER BY name`,
      );
      return rows.map((r) => ({ name: r.name, checksum: r.checksum }));
    },
    async applyMigration(m: PlannedMigration) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(m.contents);
        await client.query(
          `INSERT INTO ${TRACK_TABLE} (name, checksum) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
          [m.name, m.checksum],
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async runSql(sql: string) {
      // Seeds run as a single batch (may contain many statements).
      await pool.query(sql);
    },
    async end() {
      await pool.end();
    },
  };
}
