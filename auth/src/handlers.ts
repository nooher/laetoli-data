// Request handlers as small, DB-injected functions.
// They take plain inputs and return a { status, body } result, so they can be
// unit-tested directly (no HTTP server, no live Postgres) by passing a fake Db.

import type { Db, PublicUser } from './db.js';
import { toPublicUser } from './db.js';
import { hashPassword, verifyPassword } from './password.js';
import { issueAccessToken, verifyAccessToken, parseBearer } from './jwt.js';
import {
  validateUsername,
  validatePassword,
  normalizeUsername,
} from './validation.js';

export interface HandlerDeps {
  db: Db;
  jwtSecret: string;
  jwtExpiry: number;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

interface AuthSuccessBody {
  user: PublicUser;
  access_token: string;
}

function err(message: string): { error: string } {
  return { error: message };
}

function authSuccess(
  deps: HandlerDeps,
  user: { id: string } & PublicUser
): AuthSuccessBody {
  const access_token = issueAccessToken(user.id, {
    secret: deps.jwtSecret,
    expirySeconds: deps.jwtExpiry,
  });
  return { user, access_token };
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
  input: { username?: unknown; password?: unknown }
): Promise<HandlerResult> {
  const u = validateUsername(input.username);
  if (!u.ok) return { status: 400, body: err(u.error!) };
  const p = validatePassword(input.password);
  if (!p.ok) return { status: 400, body: err(p.error!) };

  const username = normalizeUsername(input.username as string);

  const existing = await deps.db.findByUsername(username);
  if (existing) {
    return { status: 409, body: err('Jina la mtumiaji tayari limetumika.') };
  }

  const passwordHash = await hashPassword(input.password as string);

  let row;
  try {
    row = await deps.db.createUser({ username, passwordHash });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // Lost the race against a concurrent signup.
      return { status: 409, body: err('Jina la mtumiaji tayari limetumika.') };
    }
    throw e;
  }

  return { status: 201, body: authSuccess(deps, toPublicUser(row)) };
}

export async function handleToken(
  deps: HandlerDeps,
  input: { username?: unknown; password?: unknown }
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

  return { status: 200, body: authSuccess(deps, toPublicUser(row)) };
}

export async function handleAnonymous(
  deps: HandlerDeps
): Promise<HandlerResult> {
  const row = await deps.db.createAnonymousUser();
  return { status: 201, body: authSuccess(deps, toPublicUser(row)) };
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
