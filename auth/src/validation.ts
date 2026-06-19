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
