// In-memory fake Db for tests — the dependency-injection seam in action.
// No Postgres required. It models a tiny catalog (public.notes + auth.users +
// storage.buckets/objects) so handlers can exercise introspection, table CRUD,
// the SQL passthrough, policies, roles, users, storage and stats.

import { randomUUID } from 'node:crypto';
import type {
  Db,
  TableShape,
  TablePage,
  QueryResult,
  PolicyInfo,
  RoleInfo,
  AdminUser,
  BucketInfo,
  ObjectInfo,
  Stats,
  SchemaInfo,
} from '../db.js';

interface FakeTable {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: string[];
  pk: string[];
  rows: Record<string, unknown>[];
}

export interface FakeDb extends Db {
  tables: Map<string, FakeTable>;
  /** Make the next query() call throw a pg-style error (for the console test). */
  failNextQuery: (message: string, code?: string) => void;
}

function key(schema: string, name: string): string {
  return `${schema}.${name}`;
}

export function createFakeDb(): FakeDb {
  const tables = new Map<string, FakeTable>();

  // public.notes — a writable table
  tables.set('public.notes', {
    schema: 'public',
    name: 'notes',
    kind: 'table',
    columns: ['id', 'title', 'owner'],
    pk: ['id'],
    rows: [
      { id: 1, title: 'first', owner: 'u1' },
      { id: 2, title: 'second', owner: 'u2' },
    ],
  });

  // public.notes_view — a view (writes must be rejected)
  tables.set('public.notes_view', {
    schema: 'public',
    name: 'notes_view',
    kind: 'view',
    columns: ['id', 'title'],
    pk: [],
    rows: [{ id: 1, title: 'first' }],
  });

  // auth.users (NEVER expose password_hash through the admin user listing)
  const authUsers: AdminUser[] = [
    { id: 'u1', username: 'neema', is_anonymous: false, created_at: '2026-01-01T00:00:00Z' },
    { id: 'u2', username: null, is_anonymous: true, created_at: '2026-01-02T00:00:00Z' },
  ];

  const buckets: BucketInfo[] = [
    { name: 'avatars', public: true, created_at: '2026-01-01T00:00:00Z' },
  ];
  const objects: ObjectInfo[] = [
    {
      id: 'o1',
      bucket: 'avatars',
      path: 'u1/pic.png',
      size: 1024,
      mime: 'image/png',
      owner: 'u1',
      created_at: '2026-01-03T00:00:00Z',
      updated_at: '2026-01-03T00:00:00Z',
    },
  ];

  let pendingError: { message: string; code?: string } | null = null;

  return {
    tables,

    failNextQuery(message, code) {
      pendingError = { message, code };
    },

    async ping() {
      /* always healthy */
    },

    async listSchemas(): Promise<SchemaInfo[]> {
      const bySchema = new Map<string, SchemaInfo>();
      for (const t of tables.values()) {
        if (!bySchema.has(t.schema)) {
          bySchema.set(t.schema, { name: t.schema, tables: [] });
        }
        bySchema.get(t.schema)!.tables.push({
          schema: t.schema,
          name: t.name,
          kind: t.kind,
          columns: t.columns.map((c) => ({
            name: c,
            type: 'text',
            nullable: true,
            default: null,
            is_pk: t.pk.includes(c),
          })),
        });
      }
      return [...bySchema.values()];
    },

    async getTableShape(schema, name): Promise<TableShape | null> {
      const t = tables.get(key(schema, name));
      if (!t) return null;
      return {
        schema: t.schema,
        name: t.name,
        kind: t.kind,
        columns: [...t.columns],
        pk: [...t.pk],
      };
    },

    async selectTable({ schema, name, limit, offset, orderBy, orderDir }): Promise<TablePage> {
      const t = tables.get(key(schema, name));
      if (!t) return { rows: [], count: 0 };
      let rows = [...t.rows];
      if (orderBy) {
        rows.sort((a, b) => {
          const av = a[orderBy] as never;
          const bv = b[orderBy] as never;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return orderDir === 'desc' ? -cmp : cmp;
        });
      }
      return { rows: rows.slice(offset, offset + limit), count: t.rows.length };
    },

    async insertRow(schema, name, values) {
      const t = tables.get(key(schema, name));
      if (!t) throw new Error('no such table');
      const row = { ...values };
      if (!('id' in row)) row.id = t.rows.length + 1;
      t.rows.push(row);
      return row;
    },

    async updateRows(schema, name, where, set) {
      const t = tables.get(key(schema, name));
      if (!t) return 0;
      let n = 0;
      for (const row of t.rows) {
        if (Object.entries(where).every(([k, v]) => row[k] === v)) {
          Object.assign(row, set);
          n++;
        }
      }
      return n;
    },

    async deleteRows(schema, name, where) {
      const t = tables.get(key(schema, name));
      if (!t) return 0;
      const before = t.rows.length;
      t.rows = t.rows.filter(
        (row) => !Object.entries(where).every(([k, v]) => row[k] === v)
      );
      return before - t.rows.length;
    },

    async query(sql): Promise<QueryResult> {
      if (pendingError) {
        const { message, code } = pendingError;
        pendingError = null;
        const e = new Error(message) as Error & { code?: string };
        if (code) e.code = code;
        throw e;
      }
      // Trivial fake: SELECT 1 returns one row; anything else echoes empty.
      if (/select\s+1/i.test(sql)) {
        return {
          rows: [{ '?column?': 1 }],
          rowCount: 1,
          fields: [{ name: '?column?', dataTypeID: 23 }],
        };
      }
      return { rows: [], rowCount: 0, fields: [] };
    },

    async listPolicies(): Promise<PolicyInfo[]> {
      return [
        {
          schema: 'storage',
          table: 'objects',
          policyname: 'objects_select_own_or_public',
          cmd: 'SELECT',
          roles: ['authenticated'],
          qual: 'owner = auth.uid()',
          with_check: null,
          rls_enabled: true,
        },
      ];
    },

    async listRoles(): Promise<RoleInfo[]> {
      return [
        { rolname: 'anon', login: false, bypassrls: false, memberof: [] },
        { rolname: 'laetoli_admin', login: false, bypassrls: true, memberof: [] },
        {
          rolname: 'laetoli_admin_login',
          login: true,
          bypassrls: true,
          memberof: ['laetoli_admin'],
        },
      ];
    },

    async listAuthUsers(limit, offset): Promise<AdminUser[]> {
      return authUsers.slice(offset, offset + limit);
    },

    async deleteAuthUser(id) {
      const i = authUsers.findIndex((u) => u.id === id);
      if (i === -1) return false;
      authUsers.splice(i, 1);
      return true;
    },

    async listBuckets(): Promise<BucketInfo[]> {
      return [...buckets];
    },

    async listObjects(bucket, limit): Promise<ObjectInfo[]> {
      const filtered = bucket ? objects.filter((o) => o.bucket === bucket) : objects;
      return filtered.slice(0, limit);
    },

    async stats(): Promise<Stats> {
      return {
        users: authUsers.length,
        tables: tables.size,
        buckets: buckets.length,
        objects: objects.length,
        db_size_pretty: '8192 kB',
      };
    },

    async close() {
      /* no-op */
    },
  };
}

export { randomUUID };
