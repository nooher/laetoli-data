// Test helpers: build a real signed HS256 JWT (so the storage service's own
// jwt.verify accepts it) and a throwaway temp dir for the fs store.

import { mkdtempSync, rmSync } from 'node:fs';
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

export function tempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'laetoli-storage-'));
  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}
