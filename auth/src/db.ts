// Database seam. Handlers depend on the `Db` interface, NOT on `pg` directly.
// Tests inject a fake Db; production injects a pg-backed one.

import pg from 'pg';
import type { AuthConfig } from './config.js';

/** A user row as stored in auth.users. */
export interface UserRow {
  id: string;
  username: string | null;
  password_hash: string | null;
  is_anonymous: boolean;
  created_at: string;
}

/** Public user shape (NEVER includes password_hash). */
export interface PublicUser {
  id: string;
  username: string | null;
  is_anonymous: boolean;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    is_anonymous: row.is_anonymous,
  };
}

/**
 * The dependency-injection seam: a tiny data interface the handlers use.
 * Implemented for real by `createPgDb`, and faked in tests.
 */
export interface Db {
  findByUsername(username: string): Promise<UserRow | null>;
  findById(id: string): Promise<UserRow | null>;
  createUser(input: {
    username: string;
    passwordHash: string;
  }): Promise<UserRow>;
  createAnonymousUser(): Promise<UserRow>;
  /** Liveness check for /health. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Postgres-backed Db. Parameterized SQL only. */
export function createPgDb(config: AuthConfig): Db {
  const pool = config.databaseUrl
    ? new pg.Pool({ connectionString: config.databaseUrl })
    : new pg.Pool({
        host: config.pg.host,
        port: config.pg.port,
        user: config.pg.user,
        password: config.pg.password,
        database: config.pg.database,
      });

  const SELECT_COLS =
    'id, username, password_hash, is_anonymous, created_at';

  return {
    async findByUsername(username) {
      const { rows } = await pool.query<UserRow>(
        `SELECT ${SELECT_COLS} FROM auth.users WHERE username = $1 LIMIT 1`,
        [username]
      );
      return rows[0] ?? null;
    },

    async findById(id) {
      const { rows } = await pool.query<UserRow>(
        `SELECT ${SELECT_COLS} FROM auth.users WHERE id = $1 LIMIT 1`,
        [id]
      );
      return rows[0] ?? null;
    },

    async createUser({ username, passwordHash }) {
      const { rows } = await pool.query<UserRow>(
        `INSERT INTO auth.users (username, password_hash, is_anonymous)
         VALUES ($1, $2, false)
         RETURNING ${SELECT_COLS}`,
        [username, passwordHash]
      );
      return rows[0];
    },

    async createAnonymousUser() {
      const { rows } = await pool.query<UserRow>(
        `INSERT INTO auth.users (username, password_hash, is_anonymous)
         VALUES (NULL, NULL, true)
         RETURNING ${SELECT_COLS}`,
        []
      );
      return rows[0];
    },

    async ping() {
      await pool.query('SELECT 1');
    },

    async close() {
      await pool.end();
    },
  };
}
