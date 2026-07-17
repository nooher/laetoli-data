// Request handlers as small, DB-injected functions.
// They take plain inputs and return a { status, body } result, so they can be
// unit-tested directly (no HTTP server, no live Postgres) by passing a fake Db.

import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import type { Db, PublicUser, UserRow, MfaFactorRow } from './db.js';
import { toPublicUser } from './db.js';
import { hashPassword, verifyPassword } from './password.js';
import { issueAccessToken, verifyAccessToken, parseBearer } from './jwt.js';
import {
  generateToken,
  generateOtpCode,
  hashToken,
  expiryFromNow,
  isExpired,
} from './tokens.js';
import { generateSecret, base32Encode, otpauthUri, verifyTotp } from './totp.js';
import { encryptSecret, decryptSecret } from './encryption.js';
import {
  buildGoogleAuthUrl,
  signState,
  verifyState,
  decodeGoogleIdToken,
  isAllowedRedirect,
  GOOGLE_TOKEN_ENDPOINT,
  type GoogleOAuthConfig,
} from './oauth.js';
import type { DeliveryMode } from './config.js';
import type { Mailer } from './mailer.js';
import type { SmsSender } from './sms.js';
import {
  validateUsername,
  validatePassword,
  validateEmail,
  validatePhone,
  normalizeUsername,
  normalizeEmail,
  normalizePhone,
} from './validation.js';

export interface HandlerDeps {
  db: Db;
  jwtSecret: string;
  jwtExpiry: number;
  /** Refresh-token lifetime in seconds. Optional for backward-compatible callers. */
  refreshExpiry?: number;
  /** Reset-token lifetime in seconds. */
  resetExpiry?: number;
  /** Email-verification-token lifetime in seconds. */
  emailVerifyExpiry?: number;
  /** Reset-token delivery mode ('log' default). */
  resetDelivery?: DeliveryMode;
  /** Email-verification delivery mode ('log' default). */
  emailDelivery?: DeliveryMode;
  /** Magic-link-token lifetime in seconds (default 15 min). */
  magicLinkExpiry?: number;
  /** Magic-link delivery mode ('log' default). */
  magicLinkDelivery?: DeliveryMode;
  /** Public base URL for building reset/verify links (raw token when unset). */
  baseUrl?: string;
  /** Real SMTP mailer (injectable; built from env in production). */
  mailer?: Mailer;
  /** NextSMS-compatible SMS sender (injectable; built from env in production). */
  sms?: SmsSender;
  /** OTP code lifetime in seconds (default 5 min). */
  otpExpiry?: number;
  /** Max wrong OTP guesses before the code is dead (default 5). */
  otpMaxAttempts?: number;
  /** MFA challenge lifetime in seconds (default 5 min — matches Supabase's own window). */
  mfaChallengeExpiry?: number;
  /** Google OAuth client config — unset means /oauth/google/* return a clear 503. */
  googleOAuth?: GoogleOAuthConfig;
  /** Allow-list regexp for post-OAuth-login redirect targets (open-redirect guard). */
  oauthAllowedRedirectOriginsRegexp?: string;
  /** Injectable fetch for the Google token exchange (defaults to global fetch in server.ts). */
  oauthFetch?: typeof fetch;
}

export interface HandlerResult {
  status: number;
  body: unknown;
  /** When set, the route sends an HTTP redirect (Location header) instead of a JSON body. */
  redirect?: string;
}

// Sensible defaults so handlers stay usable when a caller omits the new knobs.
const DEFAULT_REFRESH_EXPIRY = 60 * 60 * 24 * 30; // 30d
const DEFAULT_RESET_EXPIRY = 60 * 60; // 1h
const DEFAULT_EMAIL_VERIFY_EXPIRY = 60 * 60 * 24; // 24h
const DEFAULT_MAGIC_LINK_EXPIRY = 15 * 60; // 15min
const DEFAULT_OTP_EXPIRY = 5 * 60; // 5min
const DEFAULT_OTP_MAX_ATTEMPTS = 5;
const DEFAULT_MFA_CHALLENGE_EXPIRY = 5 * 60; // 5min

interface AuthSuccessBody {
  user: PublicUser;
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
}

function err(message: string): { error: string } {
  return { error: message };
}

const SUSPENDED = {
  status: 403,
  body: err('Akaunti hii imesimamishwa. (This account is suspended.)'),
};

/**
 * Blocks NEW token issuance for a suspended account (password login, OTP,
 * magic-link, OAuth, refresh). Does not invalidate an access token already
 * issued before suspension — that one lives out its (short) exp regardless,
 * same as every other revocation in this service; an admin pairs a suspend
 * with /users/:id/revoke-sessions for immediate lockout of existing sessions.
 */
function isSuspended(user: { suspended_at: string | null }): boolean {
  return user.suspended_at !== null;
}

function refreshExpiryOf(deps: HandlerDeps): number {
  return deps.refreshExpiry ?? DEFAULT_REFRESH_EXPIRY;
}

/**
 * Mint an access JWT plus a fresh opaque refresh token (new rotation family),
 * persisting only the refresh token's SHA-256 hash.
 */
async function authSuccess(
  deps: HandlerDeps,
  user: { id: string } & PublicUser,
  userAgent?: string | null
): Promise<AuthSuccessBody> {
  const access_token = issueAccessToken(user.id, {
    secret: deps.jwtSecret,
    expirySeconds: deps.jwtExpiry,
  });
  const refresh_token = await issueRefreshToken(deps, user.id, randomUUID(), userAgent);
  return {
    user,
    access_token,
    refresh_token,
    token_type: 'bearer',
    expires_in: deps.jwtExpiry,
  };
}

/** Persist a new refresh token in the given family; return the plaintext value. */
async function issueRefreshToken(
  deps: HandlerDeps,
  userId: string,
  familyId: string,
  userAgent?: string | null
): Promise<string> {
  const value = generateToken();
  await deps.db.createRefreshToken({
    userId,
    tokenHash: hashToken(value),
    familyId,
    expiresAt: expiryFromNow(refreshExpiryOf(deps)),
    userAgent: userAgent ?? null,
  });
  return value;
}

/** Detect a unique-violation regardless of which driver/db surfaces it. */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: unknown }).code === '23505'
  );
}

export async function handleSignup(
  deps: HandlerDeps,
  input: { username?: unknown; password?: unknown; email?: unknown },
  userAgent?: string | null
): Promise<HandlerResult> {
  const u = validateUsername(input.username);
  if (!u.ok) return { status: 400, body: err(u.error!) };
  const p = validatePassword(input.password);
  if (!p.ok) return { status: 400, body: err(p.error!) };

  // Email is OPTIONAL. Validate only when present.
  let email: string | null = null;
  if (input.email !== undefined && input.email !== null && input.email !== '') {
    const e = validateEmail(input.email);
    if (!e.ok) return { status: 400, body: err(e.error!) };
    email = normalizeEmail(input.email as string);
    const taken = await deps.db.findByEmail(email);
    if (taken) {
      return { status: 409, body: err('Barua pepe tayari imetumika.') };
    }
  }

  const username = normalizeUsername(input.username as string);

  const existing = await deps.db.findByUsername(username);
  if (existing) {
    return { status: 409, body: err('Jina la mtumiaji tayari limetumika.') };
  }

  const passwordHash = await hashPassword(input.password as string);

  let row;
  try {
    row = await deps.db.createUser({ username, passwordHash, email });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // Lost the race against a concurrent signup (username or email).
      return { status: 409, body: err('Jina la mtumiaji au barua pepe tayari limetumika.') };
    }
    throw e;
  }

  return { status: 201, body: await authSuccess(deps, toPublicUser(row), userAgent) };
}

export async function handleToken(
  deps: HandlerDeps,
  input: { username?: unknown; password?: unknown },
  userAgent?: string | null
): Promise<HandlerResult> {
  // Cheap presence check; do NOT leak which field/why on failure.
  if (
    typeof input.username !== 'string' ||
    typeof input.password !== 'string' ||
    input.username.trim() === '' ||
    input.password === ''
  ) {
    return {
      status: 401,
      body: err('Jina la mtumiaji au nenosiri si sahihi.'),
    };
  }

  const username = normalizeUsername(input.username);
  const row = await deps.db.findByUsername(username);
  const fail = {
    status: 401,
    body: err('Jina la mtumiaji au nenosiri si sahihi.'),
  };

  if (!row || !row.password_hash) return fail;

  const ok = await verifyPassword(input.password, row.password_hash);
  if (!ok) return fail;
  if (isSuspended(row)) return SUSPENDED;

  return { status: 200, body: await authSuccess(deps, toPublicUser(row), userAgent) };
}

export async function handleAnonymous(
  deps: HandlerDeps,
  userAgent?: string | null
): Promise<HandlerResult> {
  const row = await deps.db.createAnonymousUser();
  return { status: 201, body: await authSuccess(deps, toPublicUser(row), userAgent) };
}

export async function handleGetUser(
  deps: HandlerDeps,
  authorization: string | undefined
): Promise<HandlerResult> {
  const token = parseBearer(authorization);
  if (!token) {
    return { status: 401, body: err('Tafadhali tuma tokeni ya idhini.') };
  }

  let claims;
  try {
    claims = verifyAccessToken(token, deps.jwtSecret);
  } catch {
    return { status: 401, body: err('Tokeni si halali au imeisha muda.') };
  }

  const row = await deps.db.findById(claims.sub);
  if (!row) {
    return { status: 401, body: err('Mtumiaji hapatikani.') };
  }

  return { status: 200, body: { user: toPublicUser(row) } };
}

// =============================================================================
// REFRESH — swap a valid refresh token for a new access JWT + rotated refresh
// token. Implements rotation with reuse-detection:
//   * The presented token is looked up by its SHA-256 hash.
//   * If it is unknown / expired → 401.
//   * If it was already REVOKED → it has been used before (or the family was
//     killed). That is a reuse signal → revoke the WHOLE family and 401.
//   * Otherwise: revoke the presented token, mint a new one in the SAME family,
//     and return a fresh access JWT.
// =============================================================================
export async function handleRefresh(
  deps: HandlerDeps,
  input: { refresh_token?: unknown },
  userAgent?: string | null
): Promise<HandlerResult> {
  const invalid = { status: 401, body: err('Tokeni ya kuendelea si halali.') };
  if (typeof input.refresh_token !== 'string' || input.refresh_token === '') {
    return invalid;
  }

  const row = await deps.db.findRefreshTokenByHash(hashToken(input.refresh_token));
  if (!row) return invalid;

  // Reuse detection: a revoked token presented again means the family is
  // compromised (or already rotated). Kill the whole family.
  if (row.revoked_at) {
    await deps.db.revokeRefreshFamily(row.family_id);
    return invalid;
  }

  if (isExpired(row.expires_at)) {
    await deps.db.revokeRefreshToken(row.id);
    return invalid;
  }

  const user = await deps.db.findById(row.user_id);
  if (!user) {
    await deps.db.revokeRefreshFamily(row.family_id);
    return invalid;
  }
  if (isSuspended(user)) {
    // A suspension mid-session: kill the whole family, not just this token —
    // stop the refresh loop from being usable again even with a different
    // still-valid token in the same family.
    await deps.db.revokeRefreshFamily(row.family_id);
    return SUSPENDED;
  }

  // Rotate: revoke the presented token, issue a new one in the same family.
  await deps.db.revokeRefreshToken(row.id);
  const refresh_token = await issueRefreshToken(
    deps,
    row.user_id,
    row.family_id,
    userAgent
  );
  const access_token = issueAccessToken(row.user_id, {
    secret: deps.jwtSecret,
    expirySeconds: deps.jwtExpiry,
  });

  return {
    status: 200,
    body: {
      user: toPublicUser(user),
      access_token,
      refresh_token,
      token_type: 'bearer',
      expires_in: deps.jwtExpiry,
    },
  };
}

// =============================================================================
// LOGOUT — revoke the presented refresh token AND its rotation family. Always
// returns 200 (idempotent; never leaks whether the token existed). Access JWTs
// remain valid until their (modest) exp by design — see SECURITY notes.
// =============================================================================
export async function handleLogout(
  deps: HandlerDeps,
  input: { refresh_token?: unknown }
): Promise<HandlerResult> {
  if (typeof input.refresh_token === 'string' && input.refresh_token !== '') {
    const row = await deps.db.findRefreshTokenByHash(hashToken(input.refresh_token));
    if (row) {
      await deps.db.revokeRefreshFamily(row.family_id);
    }
  }
  return { status: 200, body: { message: 'Umetoka kikamilifu.' } };
}

// =============================================================================
// PASSWORD FORGOT — issue a single-use, short-lived reset token (hashed at
// rest). To avoid user-enumeration, the response is the SAME whether or not the
// account exists. In delivery='log' (default) the token is logged + returned in
// the response (dev/offline). In delivery='email' a mailer would send it and the
// token is NOT returned.
// =============================================================================
export async function handlePasswordForgot(
  deps: HandlerDeps,
  input: { username?: unknown; email?: unknown }
): Promise<HandlerResult> {
  const generic = {
    status: 200,
    body: {
      message:
        'Kama akaunti ipo, maelekezo ya kuweka upya nenosiri yametumwa.',
    } as Record<string, unknown>,
  };

  const user = await resolveUser(deps, input.username, input.email);
  if (!user) return generic;

  const value = generateToken();
  await deps.db.createResetToken({
    userId: user.id,
    tokenHash: hashToken(value),
    expiresAt: expiryFromNow(deps.resetExpiry ?? DEFAULT_RESET_EXPIRY),
  });

  const mode: DeliveryMode = deps.resetDelivery ?? 'log';
  // Failures must NEVER change the generic 200 (no enumeration) — deliver()
  // catches its own errors, but guard here too for total safety.
  await deliver(deps, 'reset', mode, user, value);
  if (mode === 'log') {
    // Dev/offline convenience: surface the token to the caller.
    return { status: 200, body: { ...generic.body, reset_token: value } };
  }
  return generic;
}

// =============================================================================
// PASSWORD RESET — consume a valid reset token, set the new bcrypt hash, and
// revoke ALL of the user's refresh tokens (force re-login everywhere).
// =============================================================================
export async function handlePasswordReset(
  deps: HandlerDeps,
  input: { token?: unknown; password?: unknown }
): Promise<HandlerResult> {
  const invalid = {
    status: 400,
    body: err('Tokeni ya kuweka upya si halali au imeisha muda.'),
  };
  if (typeof input.token !== 'string' || input.token === '') return invalid;

  const p = validatePassword(input.password);
  if (!p.ok) return { status: 400, body: err(p.error!) };

  const row = await deps.db.findResetTokenByHash(hashToken(input.token));
  if (!row || row.used_at || isExpired(row.expires_at)) return invalid;

  // Single-use: mark consumed first.
  await deps.db.markResetTokenUsed(row.id);
  const passwordHash = await hashPassword(input.password as string);
  await deps.db.updatePasswordHash(row.user_id, passwordHash);
  // Security: invalidate every existing session for this user.
  await deps.db.revokeAllUserRefreshTokens(row.user_id);

  return { status: 200, body: { message: 'Nenosiri limewekwa upya.' } };
}

// =============================================================================
// EMAIL VERIFY REQUEST — issue a single-use verification token for the
// authenticated user's email. Same delivery seam as password reset.
// =============================================================================
export async function handleEmailVerifyRequest(
  deps: HandlerDeps,
  authorization: string | undefined
): Promise<HandlerResult> {
  const token = parseBearer(authorization);
  if (!token) {
    return { status: 401, body: err('Tafadhali tuma tokeni ya idhini.') };
  }
  let claims;
  try {
    claims = verifyAccessToken(token, deps.jwtSecret);
  } catch {
    return { status: 401, body: err('Tokeni si halali au imeisha muda.') };
  }

  const user = await deps.db.findById(claims.sub);
  if (!user) return { status: 401, body: err('Mtumiaji hapatikani.') };
  if (!user.email) {
    return { status: 400, body: err('Hakuna barua pepe kwenye akaunti hii.') };
  }
  if (user.email_verified) {
    return { status: 200, body: { message: 'Barua pepe tayari imethibitishwa.' } };
  }

  const value = generateToken();
  await deps.db.createEmailVerificationToken({
    userId: user.id,
    tokenHash: hashToken(value),
    expiresAt: expiryFromNow(deps.emailVerifyExpiry ?? DEFAULT_EMAIL_VERIFY_EXPIRY),
  });

  const mode: DeliveryMode = deps.emailDelivery ?? 'log';
  await deliver(deps, 'email-verify', mode, user, value);
  const body: Record<string, unknown> = {
    message: 'Tumetuma kiungo cha kuthibitisha barua pepe.',
  };
  if (mode === 'log') body.verification_token = value;
  return { status: 200, body };
}

// =============================================================================
// EMAIL VERIFY CONFIRM — consume a valid verification token, mark the email
// verified. Single-use + short TTL.
// =============================================================================
export async function handleEmailVerifyConfirm(
  deps: HandlerDeps,
  input: { token?: unknown }
): Promise<HandlerResult> {
  const invalid = {
    status: 400,
    body: err('Tokeni ya uthibitisho si halali au imeisha muda.'),
  };
  if (typeof input.token !== 'string' || input.token === '') return invalid;

  const row = await deps.db.findEmailVerificationTokenByHash(hashToken(input.token));
  if (!row || row.used_at || isExpired(row.expires_at)) return invalid;

  await deps.db.markEmailVerificationTokenUsed(row.id);
  await deps.db.setEmailVerified(row.user_id);

  return { status: 200, body: { message: 'Barua pepe imethibitishwa.' } };
}

// =============================================================================
// EMAIL MAGIC LINK — passwordless login via a clickable emailed link, matching
// Supabase's `signInWithOtp({ email })` UX. POST /magiclink finds-or-creates
// a (possibly passwordless) user for the given email and emails a single-use
// link; GET /magiclink/verify consumes it and either redirects back to the
// app with tokens in the URL fragment (same shape as the OAuth callback) or,
// when no redirect_to is given, returns the session directly as JSON.
// =============================================================================

/** POST /magiclink {email, redirect_to?} — issue + email a single-use login link. */
export async function handleMagicLinkRequest(
  deps: HandlerDeps,
  input: { email?: unknown; redirect_to?: unknown }
): Promise<HandlerResult> {
  const e = validateEmail(input.email);
  if (!e.ok) return { status: 400, body: err(e.error!) };
  const email = normalizeEmail(input.email as string);

  let redirectTo: string | undefined;
  if (input.redirect_to !== undefined && input.redirect_to !== null && input.redirect_to !== '') {
    if (typeof input.redirect_to !== 'string') {
      return { status: 400, body: err('redirect_to si sahihi.') };
    }
    if (!isAllowedRedirect(input.redirect_to, deps.oauthAllowedRedirectOriginsRegexp)) {
      return { status: 400, body: err('redirect_to haijaruhusiwa. (redirect_to is not on the allow-list.)') };
    }
    redirectTo = input.redirect_to;
  }

  // Passwordless find-or-create — mirrors createPhoneUser for OTP login.
  // Delivery only ever goes to this exact address, so an account created
  // here (or a pre-existing one) can only be claimed by whoever controls
  // the inbox — the same trust model this service already uses for
  // password-reset links.
  const user = await deps.db.createEmailUser(email);

  const value = generateToken();
  await deps.db.createMagicLinkToken({
    userId: user.id,
    tokenHash: hashToken(value),
    expiresAt: expiryFromNow(deps.magicLinkExpiry ?? DEFAULT_MAGIC_LINK_EXPIRY),
  });

  const mode: DeliveryMode = deps.magicLinkDelivery ?? 'log';
  await deliver(deps, 'magic-link', mode, user, value, redirectTo);

  const body: Record<string, unknown> = {
    message: 'Kama barua pepe ni sahihi, tumetuma kiungo cha kuingia.',
  };
  if (mode === 'log') body.magic_link_token = value;
  return { status: 200, body };
}

/** GET /magiclink/verify?token=...&redirect_to=... — consume the link, issue a session. */
export async function handleMagicLinkVerify(
  deps: HandlerDeps,
  query: { token?: unknown; redirect_to?: unknown },
  userAgent?: string | null
): Promise<HandlerResult> {
  const invalid = { status: 400, body: err('Kiungo si sahihi au kimeisha muda.') };
  if (typeof query.token !== 'string' || query.token === '') return invalid;

  let redirectTo: string | undefined;
  if (query.redirect_to !== undefined && query.redirect_to !== null && query.redirect_to !== '') {
    if (typeof query.redirect_to !== 'string') return { status: 400, body: err('redirect_to si sahihi.') };
    if (!isAllowedRedirect(query.redirect_to, deps.oauthAllowedRedirectOriginsRegexp)) {
      return { status: 400, body: err('redirect_to haijaruhusiwa. (redirect_to is not on the allow-list.)') };
    }
    redirectTo = query.redirect_to;
  }

  const row = await deps.db.findMagicLinkTokenByHash(hashToken(query.token));
  if (!row || row.used_at || isExpired(row.expires_at)) return invalid;

  await deps.db.markMagicLinkTokenUsed(row.id);
  const user = await deps.db.findById(row.user_id);
  if (!user) return invalid;
  if (isSuspended(user)) return SUSPENDED;

  // Clicking an emailed link IS proof of inbox ownership — the same trust
  // this service already places in a completed password-reset. Update the
  // in-memory row too, not just the DB — the session below is built from it.
  if (user.email && !user.email_verified) {
    user.email_verified = true;
    await deps.db.setEmailVerified(user.id);
  }

  const session = await authSuccess(deps, toPublicUser(user), userAgent);
  if (!redirectTo) {
    return { status: 200, body: session };
  }
  const fragment = new URLSearchParams({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: String(session.expires_in),
    token_type: session.token_type,
  });
  return { status: 302, body: null, redirect: `${redirectTo}#${fragment.toString()}` };
}

// =============================================================================
// MFA (TOTP) — self-service authenticator-app enrollment, matching the
// Supabase `auth.mfa.*` REST contract (POST /factors, /factors/:id/challenge,
// /factors/:id/verify, DELETE /factors/:id, GET /factors) so a client already
// built against `supabase.auth.mfa.*` needs minimal changes to target this
// service instead. See 0016_mfa_totp.sql for the scope note: this is
// enrollment + factor management, NOT yet a login-time second-factor step-up.
// =============================================================================

/** Resolve the authenticated user from a Bearer token, or a 401 HandlerResult. */
async function authenticate(
  deps: HandlerDeps,
  authorization: string | undefined
): Promise<{ user: UserRow } | { error: HandlerResult }> {
  const token = parseBearer(authorization);
  if (!token) {
    return { error: { status: 401, body: err('Tafadhali tuma tokeni ya idhini.') } };
  }
  let claims;
  try {
    claims = verifyAccessToken(token, deps.jwtSecret);
  } catch {
    return { error: { status: 401, body: err('Tokeni si halali au imeisha muda.') } };
  }
  const user = await deps.db.findById(claims.sub);
  if (!user) {
    return { error: { status: 401, body: err('Mtumiaji hapatikani.') } };
  }
  return { user };
}

function toFactorSummary(f: MfaFactorRow) {
  return {
    id: f.id,
    status: f.status,
    friendly_name: f.friendly_name,
    created_at: f.created_at,
  };
}

/** POST /factors {friendly_name?} — enroll a new TOTP factor. */
export async function handleMfaEnroll(
  deps: HandlerDeps,
  authorization: string | undefined,
  input: { friendly_name?: unknown }
): Promise<HandlerResult> {
  const auth = await authenticate(deps, authorization);
  if ('error' in auth) return auth.error;

  const secret = generateSecret();
  const secretEnc = encryptSecret(secret, deps.jwtSecret);
  const friendlyName =
    typeof input.friendly_name === 'string' && input.friendly_name.trim() !== ''
      ? input.friendly_name.trim()
      : null;

  const factor = await deps.db.createMfaFactor({
    userId: auth.user.id,
    secretEnc,
    friendlyName,
  });

  const accountName = auth.user.email ?? auth.user.username ?? auth.user.id;
  const uri = otpauthUri({ secret, accountName });
  const qrCode = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 200 });
  const qrDataUri = `data:image/svg+xml;base64,${Buffer.from(qrCode).toString('base64')}`;

  return {
    status: 200,
    body: {
      id: factor.id,
      type: 'totp',
      totp: {
        qr_code: qrDataUri,
        secret: base32Encode(secret),
        uri,
      },
    },
  };
}

/** GET /factors — list the authenticated user's factors. */
export async function handleMfaListFactors(
  deps: HandlerDeps,
  authorization: string | undefined
): Promise<HandlerResult> {
  const auth = await authenticate(deps, authorization);
  if ('error' in auth) return auth.error;

  const factors = await deps.db.findMfaFactorsByUser(auth.user.id);
  const totp = factors.map(toFactorSummary);
  return { status: 200, body: { totp, all: totp } };
}

/** POST /factors/:id/challenge — issue a challenge for the enroll/verify or login step. */
export async function handleMfaChallenge(
  deps: HandlerDeps,
  authorization: string | undefined,
  factorId: string
): Promise<HandlerResult> {
  const auth = await authenticate(deps, authorization);
  if ('error' in auth) return auth.error;

  const factor = await deps.db.findMfaFactorById(factorId);
  if (!factor || factor.user_id !== auth.user.id) {
    return { status: 404, body: err('Factor haipatikani.') };
  }

  const challenge = await deps.db.createMfaChallenge({
    factorId: factor.id,
    expiresAt: expiryFromNow(deps.mfaChallengeExpiry ?? DEFAULT_MFA_CHALLENGE_EXPIRY),
  });
  return { status: 200, body: { id: challenge.id, expires_at: challenge.expires_at } };
}

/** POST /factors/:id/verify {challenge_id, code} — complete enrollment (or a future login step-up). */
export async function handleMfaVerify(
  deps: HandlerDeps,
  authorization: string | undefined,
  factorId: string,
  input: { challenge_id?: unknown; code?: unknown }
): Promise<HandlerResult> {
  const auth = await authenticate(deps, authorization);
  if ('error' in auth) return auth.error;

  const invalid = { status: 400, body: err('Msimbo si sahihi au umeisha muda.') };
  if (typeof input.challenge_id !== 'string' || input.challenge_id === '') return invalid;
  if (typeof input.code !== 'string' || input.code.trim() === '') return invalid;

  const factor = await deps.db.findMfaFactorById(factorId);
  if (!factor || factor.user_id !== auth.user.id) {
    return { status: 404, body: err('Factor haipatikani.') };
  }

  const challenge = await deps.db.findMfaChallengeById(input.challenge_id);
  if (
    !challenge ||
    challenge.factor_id !== factor.id ||
    challenge.verified_at ||
    isExpired(challenge.expires_at)
  ) {
    return invalid;
  }

  const secret = decryptSecret(factor.secret_enc, deps.jwtSecret);
  if (!verifyTotp(secret, input.code)) {
    return invalid;
  }

  await deps.db.markMfaChallengeVerified(challenge.id);
  if (factor.status === 'unverified') {
    await deps.db.markMfaFactorVerified(factor.id);
  }

  return { status: 200, body: { id: factor.id, status: 'verified' } };
}

/** DELETE /factors/:id — unenroll (remove) a factor. */
export async function handleMfaUnenroll(
  deps: HandlerDeps,
  authorization: string | undefined,
  factorId: string
): Promise<HandlerResult> {
  const auth = await authenticate(deps, authorization);
  if ('error' in auth) return auth.error;

  const factor = await deps.db.findMfaFactorById(factorId);
  if (!factor || factor.user_id !== auth.user.id) {
    return { status: 404, body: err('Factor haipatikani.') };
  }

  await deps.db.deleteMfaFactor(factor.id);
  return { status: 200, body: { id: factor.id } };
}

// =============================================================================
// OAuth (Google) — GET /oauth/google/start redirects the browser to Google's
// consent screen; GET /oauth/google/callback completes the exchange and
// redirects back to the app with tokens in the URL fragment, matching
// Supabase's own signInWithOAuth UX so a client built against it (Kasuku's
// AuthContext calls signInWithOAuth({provider:'google'})) needs minimal
// changes to point at this service instead.
// =============================================================================

const OAUTH_NOT_CONFIGURED = {
  status: 503,
  body: err('Google OAuth haijawekwa kwenye seva hii. (Google OAuth is not configured on this server.)'),
};

/** GET /oauth/google/start?redirect_to=... */
export async function handleOAuthGoogleStart(
  deps: HandlerDeps,
  redirectTo: unknown
): Promise<HandlerResult> {
  if (!deps.googleOAuth) return OAUTH_NOT_CONFIGURED;
  if (typeof redirectTo !== 'string' || redirectTo === '') {
    return { status: 400, body: err('redirect_to inahitajika.') };
  }
  if (!isAllowedRedirect(redirectTo, deps.oauthAllowedRedirectOriginsRegexp)) {
    return { status: 400, body: err('redirect_to haijaruhusiwa. (redirect_to is not on the allow-list.)') };
  }

  const state = signState({ redirectTo }, deps.jwtSecret);
  const url = buildGoogleAuthUrl(deps.googleOAuth, state);
  return { status: 302, body: null, redirect: url };
}

/** GET /oauth/google/callback?code=...&state=... */
export async function handleOAuthGoogleCallback(
  deps: HandlerDeps,
  query: { code?: unknown; state?: unknown; error?: unknown },
  userAgent?: string | null
): Promise<HandlerResult> {
  if (!deps.googleOAuth) return OAUTH_NOT_CONFIGURED;

  if (typeof query.error === 'string') {
    return { status: 400, body: err(`Google OAuth: ${query.error}`) };
  }
  if (typeof query.code !== 'string' || query.code === '') {
    return { status: 400, body: err('Msimbo wa Google haupatikani.') };
  }
  if (typeof query.state !== 'string' || query.state === '') {
    return { status: 400, body: err('State si sahihi.') };
  }

  const verified = verifyState(query.state, deps.jwtSecret);
  if (!verified) {
    return { status: 400, body: err('State si sahihi au imeisha muda.') };
  }

  const fetchImpl = deps.oauthFetch ?? fetch;
  let tokenRes: Response;
  try {
    tokenRes = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: query.code,
        client_id: deps.googleOAuth.clientId,
        client_secret: deps.googleOAuth.clientSecret,
        redirect_uri: deps.googleOAuth.redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
  } catch {
    return { status: 502, body: err('Imeshindwa kuwasiliana na Google.') };
  }

  if (!tokenRes.ok) {
    return { status: 400, body: err('Google haikuweza kuthibitisha ombi hili.') };
  }

  const tokenBody = (await tokenRes.json()) as { id_token?: string };
  if (!tokenBody.id_token) {
    return { status: 502, body: err('Google haikutuma id_token.') };
  }

  const claims = decodeGoogleIdToken(tokenBody.id_token);
  if (!claims) {
    return { status: 502, body: err('Imeshindwa kusoma majibu ya Google.') };
  }

  // Identity is matched by (provider, provider_user_id) — NEVER by email, to
  // avoid an attacker pre-registering a victim's email with a password and
  // "capturing" their later Google sign-in.
  let identity = await deps.db.findOAuthIdentity('google', claims.sub);
  let userRow: UserRow;
  if (identity) {
    const existing = await deps.db.findById(identity.user_id);
    if (!existing) return { status: 500, body: err('Akaunti iliyounganishwa haipatikani.') };
    if (isSuspended(existing)) return SUSPENDED;
    userRow = existing;
  } else {
    userRow = await deps.db.createOAuthUser({
      email: claims.email ?? null,
      emailVerified: claims.email_verified === true,
    });
    identity = await deps.db.createOAuthIdentity({
      userId: userRow.id,
      provider: 'google',
      providerUserId: claims.sub,
      email: claims.email ?? null,
    });
  }

  const session = await authSuccess(deps, toPublicUser(userRow), userAgent);
  const fragment = new URLSearchParams({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: String(session.expires_in),
    token_type: session.token_type,
  });
  const redirectUrl = `${verified.redirectTo}#${fragment.toString()}`;
  return { status: 302, body: null, redirect: redirectUrl };
}

// ---- shared helpers --------------------------------------------------------

/** Resolve a user by username or email (for password-forgot). */
async function resolveUser(
  deps: HandlerDeps,
  username: unknown,
  email: unknown
): Promise<UserRow | null> {
  if (typeof username === 'string' && username.trim() !== '') {
    const u = await deps.db.findByUsername(normalizeUsername(username));
    if (u) return u;
  }
  if (typeof email === 'string' && email.trim() !== '') {
    const u = await deps.db.findByEmail(normalizeEmail(email));
    if (u) return u;
  }
  return null;
}

/**
 * Delivery seam — now ACTUALLY sends.
 *   * 'log'   — sovereign/offline default: log the token so an operator can read
 *              it (handlers also return it in the response, as before).
 *   * 'email' — compose a reset/verify message (a link when baseUrl is set, else
 *              the raw token) and send via the injected mailer to user.email.
 *   * 'sms'   — text the token to user.phone via the injected NextSMS sender.
 * Failures are caught + logged and NEVER propagate — callers (e.g.
 * /password/forgot) must return the same generic 200 regardless. Never logs the
 * plaintext token in email/sms mode (the sender owns delivery).
 */
async function deliver(
  deps: HandlerDeps,
  kind: 'reset' | 'email-verify' | 'magic-link',
  mode: DeliveryMode,
  user: UserRow,
  value: string,
  redirectTo?: string
): Promise<void> {
  if (mode === 'log') {
    console.log(`[auth] ${kind} token for user ${user.id}: ${value}`);
    return;
  }

  try {
    if (mode === 'email') {
      if (!user.email) {
        console.warn(`[auth] ${kind}: delivery=email but user ${user.id} has no email; skipped.`);
        return;
      }
      const msg = composeMessage(kind, value, deps.baseUrl, redirectTo);
      if (deps.mailer) {
        await deps.mailer.sendEmail({ to: user.email, ...msg });
      } else {
        console.warn(`[auth] ${kind}: delivery=email but no mailer wired; skipped.`);
      }
    } else if (mode === 'sms') {
      if (!user.phone) {
        console.warn(`[auth] ${kind}: delivery=sms but user ${user.id} has no phone; skipped.`);
        return;
      }
      const msg = composeMessage(kind, value, deps.baseUrl);
      if (deps.sms) {
        await deps.sms.sendSms({ to: user.phone, text: msg.text });
      } else {
        console.warn(`[auth] ${kind}: delivery=sms but no sms sender wired; skipped.`);
      }
    }
  } catch (e) {
    // Security: never crash the request, never leak via differing responses.
    console.error(`[auth] ${kind} delivery (${mode}) failed for user ${user.id}:`, e);
  }
}

/** Compose the human-facing reset/verify/magic-link message (link if baseUrl, else token). */
function composeMessage(
  kind: 'reset' | 'email-verify' | 'magic-link',
  value: string,
  baseUrl?: string,
  redirectTo?: string
): { subject: string; text: string; html: string } {
  const base = baseUrl?.replace(/\/+$/, '');
  if (kind === 'magic-link') {
    const query = new URLSearchParams({ token: value });
    if (redirectTo) query.set('redirect_to', redirectTo);
    const link = base ? `${base}/auth/magiclink/verify?${query.toString()}` : null;
    const action = link ?? `Tokeni / token: ${value}`;
    return {
      subject: 'Laetoli Data — kiungo cha kuingia (magic sign-in link)',
      text:
        `Bofya kiungo hiki kuingia kwenye akaunti yako.\n` +
        `(Click this link to sign in to your account.)\n\n${action}\n\n` +
        `Kama hukuomba, puuza ujumbe huu. (If you did not request this, ignore this message.)`,
      html:
        `<p>Bofya kiungo hiki kuingia kwenye akaunti yako.<br>` +
        `<em>(Click this link to sign in to your account.)</em></p>` +
        (link
          ? `<p><a href="${link}">Ingia / Sign in</a></p>`
          : `<p>Tokeni / token: <code>${value}</code></p>`) +
        `<p>Kama hukuomba, puuza ujumbe huu. <em>(If you did not request this, ignore this message.)</em></p>`,
    };
  }
  if (kind === 'reset') {
    const link = base ? `${base}/auth/password/reset?token=${encodeURIComponent(value)}` : null;
    const action = link ?? `Tokeni / token: ${value}`;
    return {
      subject: 'Laetoli Data — kuweka upya nenosiri (password reset)',
      text:
        `Tumepokea ombi la kuweka upya nenosiri lako.\n` +
        `(We received a request to reset your password.)\n\n${action}\n\n` +
        `Kama hukuomba, puuza ujumbe huu. (If you did not request this, ignore this message.)`,
      html:
        `<p>Tumepokea ombi la kuweka upya nenosiri lako.<br>` +
        `<em>(We received a request to reset your password.)</em></p>` +
        (link
          ? `<p><a href="${link}">Weka upya nenosiri / Reset password</a></p>`
          : `<p>Tokeni / token: <code>${value}</code></p>`) +
        `<p>Kama hukuomba, puuza ujumbe huu. <em>(If you did not request this, ignore this message.)</em></p>`,
    };
  }
  const link = base ? `${base}/auth/email/verify/confirm?token=${encodeURIComponent(value)}` : null;
  const action = link ?? `Tokeni / token: ${value}`;
  return {
    subject: 'Laetoli Data — thibitisha barua pepe (verify your email)',
    text:
      `Thibitisha barua pepe yako. (Please verify your email.)\n\n${action}`,
    html:
      `<p>Thibitisha barua pepe yako. <em>(Please verify your email.)</em></p>` +
      (link
        ? `<p><a href="${link}">Thibitisha / Verify email</a></p>`
        : `<p>Tokeni / token: <code>${value}</code></p>`),
  };
}

// =============================================================================
// PHONE OTP (sovereign passwordless login over SMS).
//   * POST /otp/request {phone} — generate a 6-digit code, store it HASHED with
//     a short expiry + attempt counter, and text it via the SMS channel. Always
//     returns a generic 200 (no enumeration). In 'log' mode the code is
//     returned/logged for dev.
//   * POST /otp/verify {phone, code} — check hash + expiry + attempts; on
//     success issue the SAME access + refresh tokens as login.
// =============================================================================
export async function handleOtpRequest(
  deps: HandlerDeps,
  input: { phone?: unknown }
): Promise<HandlerResult> {
  const generic = {
    status: 200,
    body: { message: 'Kama namba ni sahihi, tumetuma msimbo wa kuthibitisha.' } as Record<
      string,
      unknown
    >,
  };

  const v = validatePhone(input.phone);
  if (!v.ok) return { status: 400, body: err(v.error!) };
  const phone = normalizePhone(input.phone as string);

  // Find-or-create the phone identity (passwordless accounts).
  const user = await deps.db.createPhoneUser(phone);

  const code = generateOtpCode();
  await deps.db.createOtpCode({
    userId: user.id,
    phone,
    codeHash: hashToken(code),
    expiresAt: expiryFromNow(deps.otpExpiry ?? DEFAULT_OTP_EXPIRY),
  });

  // In log mode we surface the code; otherwise we text it via the SMS sender.
  // (resetDelivery/emailDelivery are token-channels; OTP is inherently SMS, so
  // we use the sms sender directly and treat 'log' as the dev/offline fallback.)
  const useSms = deps.sms !== undefined;
  if (useSms) {
    try {
      await deps.sms!.sendSms({
        to: phone,
        text: `Laetoli Data: msimbo wako ni ${code}. Utaisha muda baada ya dakika 5. (Your code expires in 5 minutes.)`,
      });
    } catch (e) {
      // Never crash / never enumerate; the request still returns generic 200.
      console.error(`[auth] otp delivery failed for ${phone}:`, e);
    }
  } else {
    console.log(`[auth] otp code for ${phone}: ${code}`);
  }

  // Dev/offline convenience: when no real SMS sender is wired, return the code.
  if (!useSms) {
    return { status: 200, body: { ...generic.body, code } };
  }
  return generic;
}

export async function handleOtpVerify(
  deps: HandlerDeps,
  input: { phone?: unknown; code?: unknown },
  userAgent?: string | null
): Promise<HandlerResult> {
  const invalid = {
    status: 400,
    body: err('Msimbo si sahihi au umeisha muda.'),
  };

  const v = validatePhone(input.phone);
  if (!v.ok) return { status: 400, body: err(v.error!) };
  if (typeof input.code !== 'string' || input.code.trim() === '') return invalid;

  const phone = normalizePhone(input.phone as string);
  const row = await deps.db.findLatestOtpByPhone(phone);
  if (!row || row.used_at || isExpired(row.expires_at)) return invalid;

  const maxAttempts = deps.otpMaxAttempts ?? DEFAULT_OTP_MAX_ATTEMPTS;
  if (row.attempts >= maxAttempts) return invalid;

  const matches = hashToken(input.code.trim()) === row.code_hash;
  if (!matches) {
    await deps.db.incrementOtpAttempts(row.id);
    return invalid;
  }

  // Success: consume the code and issue a normal session.
  await deps.db.markOtpUsed(row.id);
  const user = await deps.db.findById(row.user_id);
  if (!user) return invalid;
  if (isSuspended(user)) return SUSPENDED;

  return { status: 200, body: await authSuccess(deps, toPublicUser(user), userAgent) };
}
