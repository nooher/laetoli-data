// Input validation — pure functions, Kiswahili error messages.

export interface ValidationResult {
  ok: boolean;
  /** Kiswahili error message when ok === false. */
  error?: string;
}

const OK: ValidationResult = { ok: true };

// Username: 3–32 chars, letters/digits/._- , must start with a letter or digit.
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/;

export function validateUsername(value: unknown): ValidationResult {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, error: 'Jina la mtumiaji linahitajika.' };
  }
  const v = value.trim();
  if (v.length < 3) {
    return { ok: false, error: 'Jina la mtumiaji ni fupi mno (angalau herufi 3).' };
  }
  if (v.length > 32) {
    return { ok: false, error: 'Jina la mtumiaji ni refu mno (zaidi ya herufi 32).' };
  }
  if (!USERNAME_RE.test(v)) {
    return {
      ok: false,
      error:
        'Jina la mtumiaji linaruhusu herufi, namba, nukta, mstari na kistari tu (lazima lianze na herufi au namba).',
    };
  }
  return OK;
}

export function validatePassword(value: unknown): ValidationResult {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: 'Nenosiri linahitajika.' };
  }
  if (value.length < 8) {
    return { ok: false, error: 'Nenosiri ni fupi mno (angalau herufi 8).' };
  }
  if (value.length > 200) {
    return { ok: false, error: 'Nenosiri ni refu mno (zaidi ya herufi 200).' };
  }
  return OK;
}

/** Normalize a username for storage/uniqueness (trim + lowercase). */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

// Email is OPTIONAL everywhere. This is a deliberately lenient sanity check
// (one @, a dot in the domain, no spaces) — real deliverability is proven by
// the verification flow, not by a regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(value: unknown): ValidationResult {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, error: 'Barua pepe inahitajika.' };
  }
  const v = value.trim();
  if (v.length > 254 || !EMAIL_RE.test(v)) {
    return { ok: false, error: 'Barua pepe si sahihi.' };
  }
  return OK;
}

/** Normalize an email for storage/uniqueness (trim + lowercase). */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
