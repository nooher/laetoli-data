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
  email: string | null;
  email_verified: boolean;
  created_at: string;
}

/** Public user shape (NEVER includes password_hash). */
export interface PublicUser {
  id: string;
  username: string | null;
  is_anonymous: boolean;
  email: string | null;
  email_verified: boolean;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    is_anonymous: row.is_anonymous,
    email: row.email,
    email_verified: row.email_verified,
  };
}

/** A refresh-token row (auth.refresh_tokens). Value is opaque + stored hashed. */
export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  user_agent: string | null;
}

/** A single-use token row (reset / email-verification). */
export interface SingleUseTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

/**
 * The dependency-injection seam: a tiny data interface the handlers use.
 * Implemented for real by `createPgDb`, and faked in tests.
 */
export interface Db {
  findByUsername(username: string): Promise<UserRow | null>;
  findById(id: string): Promise<UserRow | null>;
  findByEmail(email: string): Promise<UserRow | null>;
  createUser(input: {
    username: string;
    passwordHash: string;
    email?: string | null;
  }): Promise<UserRow>;
  createAnonymousUser(): Promise<UserRow>;
  /** Set a new bcrypt hash for a user (password reset). */
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
  /** Set the user's email + mark verified (email-verify confirm). */
  setEmailVerified(userId: string): Promise<void>;

  // ---- refresh tokens (rotation family) ----------------------------------
  createRefreshToken(input: {
    userId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: string;
    userAgent?: string | null;
  }): Promise<RefreshTokenRow>;
  findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRow | null>;
  revokeRefreshToken(id: string): Promise<void>;
  /** Revoke every (still-active) token in a rotation family — reuse defence. */
  revokeRefreshFamily(familyId: string): Promise<void>;
  /** Revoke all of a user's refresh tokens (logout-all / password reset). */
  revokeAllUserRefreshTokens(userId: string): Promise<void>;

  // ---- single-use tokens (reset + email verification) --------------------
  createResetToken(input: {
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<SingleUseTokenRow>;
  findResetTokenByHash(tokenHash: string): Promise<SingleUseTokenRow | null>;
  markResetTokenUsed(id: string): Promise<void>;

  createEmailVerificationToken(input: {
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<SingleUseTokenRow>;
  findEmailVerificationTokenByHash(
    tokenHash: string
  ): Promise<SingleUseTokenRow | null>;
  markEmailVerificationTokenUsed(id: string): Promise<void>;

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
    'id, username, password_hash, is_anonymous, email, email_verified, created_at';
  const REFRESH_COLS =
    'id, user_id, token_hash, family_id, expires_at, revoked_at, created_at, user_agent';
  const SINGLE_USE_COLS =
    'id, user_id, token_hash, expires_at, used_at, created_at';

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

    async findByEmail(email) {
      const { rows } = await pool.query<UserRow>(
        `SELECT ${SELECT_COLS} FROM auth.users WHERE email = $1 LIMIT 1`,
        [email]
      );
      return rows[0] ?? null;
    },

    async createUser({ username, passwordHash, email }) {
      const { rows } = await pool.query<UserRow>(
        `INSERT INTO auth.users (username, password_hash, is_anonymous, email)
         VALUES ($1, $2, false, $3)
         RETURNING ${SELECT_COLS}`,
        [username, passwordHash, email ?? null]
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

    async updatePasswordHash(userId, passwordHash) {
      await pool.query(
        `UPDATE auth.users SET password_hash = $2 WHERE id = $1`,
        [userId, passwordHash]
      );
    },

    async setEmailVerified(userId) {
      await pool.query(
        `UPDATE auth.users SET email_verified = true WHERE id = $1`,
        [userId]
      );
    },

    // ---- refresh tokens ----------------------------------------------------
    async createRefreshToken({ userId, tokenHash, familyId, expiresAt, userAgent }) {
      const { rows } = await pool.query<RefreshTokenRow>(
        `INSERT INTO auth.refresh_tokens
           (user_id, token_hash, family_id, expires_at, user_agent)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${REFRESH_COLS}`,
        [userId, tokenHash, familyId, expiresAt, userAgent ?? null]
      );
      return rows[0];
    },

    async findRefreshTokenByHash(tokenHash) {
      const { rows } = await pool.query<RefreshTokenRow>(
        `SELECT ${REFRESH_COLS} FROM auth.refresh_tokens
         WHERE token_hash = $1 LIMIT 1`,
        [tokenHash]
      );
      return rows[0] ?? null;
    },

    async revokeRefreshToken(id) {
      await pool.query(
        `UPDATE auth.refresh_tokens SET revoked_at = now()
         WHERE id = $1 AND revoked_at IS NULL`,
        [id]
      );
    },

    async revokeRefreshFamily(familyId) {
      await pool.query(
        `UPDATE auth.refresh_tokens SET revoked_at = now()
         WHERE family_id = $1 AND revoked_at IS NULL`,
        [familyId]
      );
    },

    async revokeAllUserRefreshTokens(userId) {
      await pool.query(
        `UPDATE auth.refresh_tokens SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
    },

    // ---- reset tokens ------------------------------------------------------
    async createResetToken({ userId, tokenHash, expiresAt }) {
      const { rows } = await pool.query<SingleUseTokenRow>(
        `INSERT INTO auth.reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)
         RETURNING ${SINGLE_USE_COLS}`,
        [userId, tokenHash, expiresAt]
      );
      return rows[0];
    },

    async findResetTokenByHash(tokenHash) {
      const { rows } = await pool.query<SingleUseTokenRow>(
        `SELECT ${SINGLE_USE_COLS} FROM auth.reset_tokens
         WHERE token_hash = $1 LIMIT 1`,
        [tokenHash]
      );
      return rows[0] ?? null;
    },

    async markResetTokenUsed(id) {
      await pool.query(
        `UPDATE auth.reset_tokens SET used_at = now()
         WHERE id = $1 AND used_at IS NULL`,
        [id]
      );
    },

    // ---- email verification tokens ----------------------------------------
    async createEmailVerificationToken({ userId, tokenHash, expiresAt }) {
      const { rows } = await pool.query<SingleUseTokenRow>(
        `INSERT INTO auth.email_verification_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)
         RETURNING ${SINGLE_USE_COLS}`,
        [userId, tokenHash, expiresAt]
      );
      return rows[0];
    },

    async findEmailVerificationTokenByHash(tokenHash) {
      const { rows } = await pool.query<SingleUseTokenRow>(
        `SELECT ${SINGLE_USE_COLS} FROM auth.email_verification_tokens
         WHERE token_hash = $1 LIMIT 1`,
        [tokenHash]
      );
      return rows[0] ?? null;
    },

    async markEmailVerificationTokenUsed(id) {
      await pool.query(
        `UPDATE auth.email_verification_tokens SET used_at = now()
         WHERE id = $1 AND used_at IS NULL`,
        [id]
      );
    },

    async ping() {
      await pool.query('SELECT 1');
    },

    async close() {
      await pool.end();
    },
  };
}
