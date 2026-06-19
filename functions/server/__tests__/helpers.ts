// Test helpers: a throwaway temp functions root + a real signed HS256 JWT (so
// the runner's own jwt.verify accepts it).

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';

export const SECRET = 'h'.repeat(40);

export function makeToken(
  sub: string,
  opts: { secret?: string; role?: string; expiresInSeconds?: number } = {}
): string {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (opts.expiresInSeconds ?? 3600);
  return jwt.sign(
    { sub, role: opts.role ?? 'authenticated', iat, exp },
    opts.secret ?? SECRET,
    { algorithm: 'HS256', mutatePayload: false }
  );
}

export interface TempFns {
  root: string;
  /** Write `<name>.<ext>` (or `<name>/index.<ext>` if name contains `/`). */
  write: (relPath: string, contents: string) => string;
  cleanup: () => void;
}

export function tempFns(): TempFns {
  const root = mkdtempSync(path.join(tmpdir(), 'laetoli-functions-'));
  return {
    root,
    write(relPath, contents) {
      const full = path.join(root, relPath);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents, 'utf8');
      return full;
    },
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}
