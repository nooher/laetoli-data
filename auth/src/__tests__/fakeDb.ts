// In-memory fake Db for tests — the dependency-injection seam in action.
// No Postgres required.

import { randomUUID } from 'node:crypto';
import type {
  Db,
  UserRow,
  RefreshTokenRow,
  SingleUseTokenRow,
  OtpCodeRow,
  MfaFactorRow,
  MfaChallengeRow,
  OAuthIdentityRow,
} from '../db.js';

export function createFakeDb(seed: UserRow[] = []): Db & {
  rows: UserRow[];
  refreshTokens: RefreshTokenRow[];
  resetTokens: SingleUseTokenRow[];
  emailVerificationTokens: SingleUseTokenRow[];
  magicLinkTokens: SingleUseTokenRow[];
  otpCodes: OtpCodeRow[];
  mfaFactors: MfaFactorRow[];
  mfaChallenges: MfaChallengeRow[];
  oauthIdentities: OAuthIdentityRow[];
  failNextCreateWithUniqueViolation: () => void;
} {
  const rows: UserRow[] = [...seed];
  const refreshTokens: RefreshTokenRow[] = [];
  const resetTokens: SingleUseTokenRow[] = [];
  const emailVerificationTokens: SingleUseTokenRow[] = [];
  const magicLinkTokens: SingleUseTokenRow[] = [];
  const otpCodes: OtpCodeRow[] = [];
  const mfaFactors: MfaFactorRow[] = [];
  const mfaChallenges: MfaChallengeRow[] = [];
  const oauthIdentities: OAuthIdentityRow[] = [];
  let pendingUniqueViolation = false;

  return {
    rows,
    refreshTokens,
    resetTokens,
    emailVerificationTokens,
    magicLinkTokens,
    otpCodes,
    mfaFactors,
    mfaChallenges,
    oauthIdentities,
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

    async findByPhone(phone) {
      return rows.find((r) => r.phone === phone) ?? null;
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
        phone: null,
        created_at: new Date().toISOString(),
        suspended_at: null,
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
        phone: null,
        created_at: new Date().toISOString(),
        suspended_at: null,
      };
      rows.push(row);
      return row;
    },

    async createPhoneUser(phone) {
      const existing = rows.find((r) => r.phone === phone);
      if (existing) return existing;
      const row: UserRow = {
        id: randomUUID(),
        username: null,
        password_hash: null,
        is_anonymous: false,
        email: null,
        email_verified: false,
        phone,
        created_at: new Date().toISOString(),
        suspended_at: null,
      };
      rows.push(row);
      return row;
    },

    async createEmailUser(email) {
      const existing = rows.find((r) => r.email === email);
      if (existing) return existing;
      const row: UserRow = {
        id: randomUUID(),
        username: null,
        password_hash: null,
        is_anonymous: false,
        email,
        email_verified: false,
        phone: null,
        created_at: new Date().toISOString(),
        suspended_at: null,
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

    // ---- email magic-link tokens --------------------------------------------
    async createMagicLinkToken({ userId, tokenHash, expiresAt }) {
      const row: SingleUseTokenRow = {
        id: randomUUID(),
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        used_at: null,
        created_at: new Date().toISOString(),
      };
      magicLinkTokens.push(row);
      return row;
    },

    async findMagicLinkTokenByHash(tokenHash) {
      return magicLinkTokens.find((t) => t.token_hash === tokenHash) ?? null;
    },

    async markMagicLinkTokenUsed(id) {
      const t = magicLinkTokens.find((r) => r.id === id);
      if (t && !t.used_at) t.used_at = new Date().toISOString();
    },

    // ---- phone-OTP codes ---------------------------------------------------
    async createOtpCode({ userId, phone, codeHash, expiresAt }) {
      const row: OtpCodeRow = {
        id: randomUUID(),
        user_id: userId,
        phone,
        code_hash: codeHash,
        expires_at: expiresAt,
        attempts: 0,
        used_at: null,
        created_at: new Date().toISOString(),
      };
      otpCodes.push(row);
      return row;
    },

    async findLatestOtpByPhone(phone) {
      const matches = otpCodes
        .filter((t) => t.phone === phone && !t.used_at)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return matches[0] ?? null;
    },

    async incrementOtpAttempts(id) {
      const t = otpCodes.find((r) => r.id === id);
      if (t) t.attempts += 1;
    },

    async markOtpUsed(id) {
      const t = otpCodes.find((r) => r.id === id);
      if (t && !t.used_at) t.used_at = new Date().toISOString();
    },

    // ---- MFA (TOTP) factors + challenges -----------------------------------
    async createMfaFactor({ userId, secretEnc, friendlyName }) {
      const row: MfaFactorRow = {
        id: randomUUID(),
        user_id: userId,
        factor_type: 'totp',
        status: 'unverified',
        secret_enc: secretEnc,
        friendly_name: friendlyName ?? null,
        created_at: new Date().toISOString(),
        verified_at: null,
      };
      mfaFactors.push(row);
      return row;
    },

    async findMfaFactorById(id) {
      return mfaFactors.find((f) => f.id === id) ?? null;
    },

    async findMfaFactorsByUser(userId) {
      return mfaFactors
        .filter((f) => f.user_id === userId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    },

    async markMfaFactorVerified(id) {
      const f = mfaFactors.find((r) => r.id === id);
      if (f && f.status === 'unverified') {
        f.status = 'verified';
        f.verified_at = new Date().toISOString();
      }
    },

    async deleteMfaFactor(id) {
      const idx = mfaFactors.findIndex((f) => f.id === id);
      if (idx !== -1) mfaFactors.splice(idx, 1);
    },

    async createMfaChallenge({ factorId, expiresAt }) {
      const row: MfaChallengeRow = {
        id: randomUUID(),
        factor_id: factorId,
        expires_at: expiresAt,
        verified_at: null,
        created_at: new Date().toISOString(),
      };
      mfaChallenges.push(row);
      return row;
    },

    async findMfaChallengeById(id) {
      return mfaChallenges.find((c) => c.id === id) ?? null;
    },

    async markMfaChallengeVerified(id) {
      const c = mfaChallenges.find((r) => r.id === id);
      if (c && !c.verified_at) c.verified_at = new Date().toISOString();
    },

    // ---- OAuth (Google) -----------------------------------------------------
    async createOAuthUser({ email, emailVerified }) {
      const row: UserRow = {
        id: randomUUID(),
        username: null,
        password_hash: null,
        is_anonymous: false,
        email: email ?? null,
        email_verified: emailVerified,
        phone: null,
        created_at: new Date().toISOString(),
        suspended_at: null,
      };
      rows.push(row);
      return row;
    },

    async findOAuthIdentity(provider, providerUserId) {
      return (
        oauthIdentities.find(
          (o) => o.provider === provider && o.provider_user_id === providerUserId
        ) ?? null
      );
    },

    async createOAuthIdentity({ userId, provider, providerUserId, email }) {
      const row: OAuthIdentityRow = {
        id: randomUUID(),
        user_id: userId,
        provider,
        provider_user_id: providerUserId,
        email: email ?? null,
        created_at: new Date().toISOString(),
      };
      oauthIdentities.push(row);
      return row;
    },

    async ping() {
      /* always healthy */
    },

    async close() {
      /* no-op */
    },
  };
}
