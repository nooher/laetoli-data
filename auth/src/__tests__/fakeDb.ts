// In-memory fake Db for tests — the dependency-injection seam in action.
// No Postgres required.

import { randomUUID } from 'node:crypto';
import type { Db, UserRow } from '../db.js';

export function createFakeDb(seed: UserRow[] = []): Db & {
  rows: UserRow[];
  failNextCreateWithUniqueViolation: () => void;
} {
  const rows: UserRow[] = [...seed];
  let pendingUniqueViolation = false;

  return {
    rows,
    failNextCreateWithUniqueViolation() {
      pendingUniqueViolation = true;
    },

    async findByUsername(username) {
      return rows.find((r) => r.username === username) ?? null;
    },

    async findById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },

    async createUser({ username, passwordHash }) {
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
        created_at: new Date().toISOString(),
      };
      rows.push(row);
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
