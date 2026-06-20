// In-memory fake Db for tests — the dependency-injection seam in action.
// No Postgres required.

import { randomUUID } from 'node:crypto';
import type {
  Db,
  UserRow,
  RefreshTokenRow,
  SingleUseTokenRow,
} from '../db.js';

export function createFakeDb(seed: UserRow[] = []): Db & {
  rows: UserRow[];
  refreshTokens: RefreshTokenRow[];
  resetTokens: SingleUseTokenRow[];
  emailVerificationTokens: SingleUseTokenRow[];
  failNextCreateWithUniqueViolation: () => void;
} {
  const rows: UserRow[] = [...seed];
  const refreshTokens: RefreshTokenRow[] = [];
  const resetTokens: SingleUseTokenRow[] = [];
  const emailVerificationTokens: SingleUseTokenRow[] = [];
  let pendingUniqueViolation = false;

  return {
    rows,
    refreshTokens,
    resetTokens,
    emailVerificationTokens,
    failNextCreateWithUniqueViolation() {
      pendingUniqueViolation = true;
    },

    async findByUsername(username) {
      return rows.find((r) => r.username === username) ?? null;
    },

    async findById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },

    async findByEmail(email) {
      return rows.find((r) => r.email === email) ?? null;
    },

    async createUser({ username, passwordHash, email }) {
      if (pendingUniqueViolation) {
        pendingUniqueViolation = false;
        const e = new Error('duplicate key') as Error & { code: string };
        e.code = '23505';
        throw e;
      }
      const row: UserRow = {
        id: randomUUID(),
        username,
        password_hash: passwordHash,
        is_anonymous: false,
        email: email ?? null,
        email_verified: false,
        created_at: new Date().toISOString(),
      };
      rows.push(row);
      return row;
    },

    async createAnonymousUser() {
      const row: UserRow = {
        id: randomUUID(),
        username: null,
        password_hash: null,
        is_anonymous: true,
        email: null,
        email_verified: false,
        created_at: new Date().toISOString(),
      };
      rows.push(row);
      return row;
    },

    async updatePasswordHash(userId, passwordHash) {
      const u = rows.find((r) => r.id === userId);
      if (u) u.password_hash = passwordHash;
    },

    async setEmailVerified(userId) {
      const u = rows.find((r) => r.id === userId);
      if (u) u.email_verified = true;
    },

    // ---- refresh tokens ----------------------------------------------------
    async createRefreshToken({ userId, tokenHash, familyId, expiresAt, userAgent }) {
      const row: RefreshTokenRow = {
        id: randomUUID(),
        user_id: userId,
        token_hash: tokenHash,
        family_id: familyId,
        expires_at: expiresAt,
        revoked_at: null,
        created_at: new Date().toISOString(),
        user_agent: userAgent ?? null,
      };
      refreshTokens.push(row);
      return row;
    },

    async findRefreshTokenByHash(tokenHash) {
      return refreshTokens.find((t) => t.token_hash === tokenHash) ?? null;
    },

    async revokeRefreshToken(id) {
      const t = refreshTokens.find((r) => r.id === id);
      if (t && !t.revoked_at) t.revoked_at = new Date().toISOString();
    },

    async revokeRefreshFamily(familyId) {
      const now = new Date().toISOString();
      for (const t of refreshTokens) {
        if (t.family_id === familyId && !t.revoked_at) t.revoked_at = now;
      }
    },

    async revokeAllUserRefreshTokens(userId) {
      const now = new Date().toISOString();
      for (const t of refreshTokens) {
        if (t.user_id === userId && !t.revoked_at) t.revoked_at = now;
      }
    },

    // ---- reset tokens ------------------------------------------------------
    async createResetToken({ userId, tokenHash, expiresAt }) {
      const row: SingleUseTokenRow = {
        id: randomUUID(),
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        used_at: null,
        created_at: new Date().toISOString(),
      };
      resetTokens.push(row);
      return row;
    },

    async findResetTokenByHash(tokenHash) {
      return resetTokens.find((t) => t.token_hash === tokenHash) ?? null;
    },

    async markResetTokenUsed(id) {
      const t = resetTokens.find((r) => r.id === id);
      if (t && !t.used_at) t.used_at = new Date().toISOString();
    },

    // ---- email verification tokens ----------------------------------------
    async createEmailVerificationToken({ userId, tokenHash, expiresAt }) {
      const row: SingleUseTokenRow = {
        id: randomUUID(),
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        used_at: null,
        created_at: new Date().toISOString(),
      };
      emailVerificationTokens.push(row);
      return row;
    },

    async findEmailVerificationTokenByHash(tokenHash) {
      return (
        emailVerificationTokens.find((t) => t.token_hash === tokenHash) ?? null
      );
    },

    async markEmailVerificationTokenUsed(id) {
      const t = emailVerificationTokens.find((r) => r.id === id);
      if (t && !t.used_at) t.used_at = new Date().toISOString();
    },

    async ping() {
      /* always healthy */
    },

    async close() {
      /* no-op */
    },
  };
}
