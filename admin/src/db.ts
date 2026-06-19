// Database seam. Handlers depend on the `Db` interface, NOT on `pg` directly,
// so unit tests inject an in-memory fake (no Postgres required) and production
// injects a pg-backed one.
//
// The pg-backed Db connects AS a BYPASSRLS role (laetoli_admin_login), so every
// query here sees every row regardless of Row Level Security. ALL identifiers
// that come from the request are validated against the LIVE catalog before being
// interpolated, and they are always quoted server-side with format('%I', ...);
// values are passed as bound parameters ($1, $2, …). Raw SQL is only ever
// executed through `query()` (the admin console), which is itself key-gated.

import pg from 'pg';
import type { AdminConfig } from './config.js';

// -- Introspection shapes -----------------------------------------------------

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  is_pk: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: ColumnInfo[];
}

export interface SchemaInfo {
  name: string;
  tables: TableInfo[];
}

export interface PolicyInfo {
  schema: string;
  table: string;
  policyname: string;
  cmd: string;
  roles: string[];
  qual: string | null;
  with_check: string | null;
  rls_enabled: boolean;
}

export interface RoleInfo {
  rolname: string;
  login: boolean;
  bypassrls: boolean;
  memberof: string[];
}

/** Public auth user shape (NEVER includes password_hash). */
export interface AdminUser {
  id: string;
  username: string | null;
  is_anonymous: boolean;
  created_at: string;
}

export interface BucketInfo {
  name: string;
  public: boolean;
  created_at: string;
}

export interface ObjectInfo {
  id: string;
  bucket: string;
  path: string;
  size: number;
  mime: string;
  owner: string;
  created_at: string;
  updated_at: string;
}

export interface Stats {
  users: number;
  tables: number;
  buckets: number;
  objects: number;
  db_size_pretty: string;
}

/** Raw result of a SQL-console query. */
export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  fields: { name: string; dataTypeID: number }[];
}

export interface TablePage {
  rows: Record<string, unknown>[];
  count: number;
}

/** A single column identifier validated to exist on a table. */
export interface TableShape {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: string[];
  pk: string[];
}

// -- The DI interface ---------------------------------------------------------

export interface Db {
  /** Liveness check for /health. */
  ping(): Promise<void>;

  // Introspection
  listSchemas(): Promise<SchemaInfo[]>;
  /** Validate that schema.table exists; return its shape or null. */
  getTableShape(schema: string, name: string): Promise<TableShape | null>;

  // Table data (admin SELECT — bypasses RLS). Identifiers MUST be validated.
  selectTable(opts: {
    schema: string;
    name: string;
    limit: number;
    offset: number;
    orderBy?: string;
    orderDir?: 'asc' | 'desc';
  }): Promise<TablePage>;
  insertRow(
    schema: string,
    name: string,
    values: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  updateRows(
    schema: string,
    name: string,
    where: Record<string, unknown>,
    set: Record<string, unknown>
  ): Promise<number>;
  deleteRows(
    schema: string,
    name: string,
    where: Record<string, unknown>
  ): Promise<number>;

  // SQL console — arbitrary SQL (key-gated). Wrapped in a statement timeout.
  query(sql: string, params?: unknown[]): Promise<QueryResult>;

  // Management
  listPolicies(): Promise<PolicyInfo[]>;
  listRoles(): Promise<RoleInfo[]>;
  listAuthUsers(limit: number, offset: number): Promise<AdminUser[]>;
  deleteAuthUser(id: string): Promise<boolean>;
  listBuckets(): Promise<BucketInfo[]>;
  listObjects(bucket: string | undefined, limit: number): Promise<ObjectInfo[]>;
  stats(): Promise<Stats>;

  close(): Promise<void>;
}

// System schemas excluded from introspection.
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

/** Postgres-backed Db. Parameterized values; %I-quoted, catalog-checked idents. */
export function createPgDb(config: AdminConfig): Db {
  const pool = config.databaseUrl
    ? new pg.Pool({ connectionString: config.databaseUrl })
    : new pg.Pool({
        host: config.pg.host,
        port: config.pg.port,
        user: config.pg.user,
        password: config.pg.password,
        database: config.pg.database,
      });

  const sysList = SYSTEM_SCHEMAS.map((_, i) => `$${i + 1}`).join(', ');

  async function getTableShape(
    schema: string,
    name: string
  ): Promise<TableShape | null> {
    const meta = await pool.query<{ kind: 'table' | 'view' }>(
      `SELECT CASE WHEN c.relkind = 'v' OR c.relkind = 'm' THEN 'view' ELSE 'table' END AS kind
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
          AND c.relkind IN ('r','v','m','p','f')
        LIMIT 1`,
      [schema, name]
    );
    if (meta.rowCount === 0) return null;

    const cols = await pool.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [schema, name]
    );

    const pk = await pool.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
        WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary`,
      [schema, name]
    );

    return {
      schema,
      name,
      kind: meta.rows[0].kind,
      columns: cols.rows.map((r) => r.column_name),
      pk: pk.rows.map((r) => r.column_name),
    };
  }

  return {
    async ping() {
      await pool.query('SELECT 1');
    },

    async listSchemas() {
      const schemas = await pool.query<{ schema_name: string }>(
        `SELECT nspname AS schema_name
           FROM pg_namespace
          WHERE nspname NOT IN (${sysList})
            AND nspname NOT LIKE 'pg_temp%'
            AND nspname NOT LIKE 'pg_toast_temp%'
          ORDER BY nspname`,
        SYSTEM_SCHEMAS
      );

      const tables = await pool.query<{
        table_schema: string;
        table_name: string;
        kind: 'table' | 'view';
      }>(
        `SELECT n.nspname AS table_schema,
                c.relname AS table_name,
                CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS kind
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r','v','m','p')
            AND n.nspname NOT IN (${sysList})
            AND n.nspname NOT LIKE 'pg_temp%'
          ORDER BY n.nspname, c.relname`,
        SYSTEM_SCHEMAS
      );

      const columns = await pool.query<{
        table_schema: string;
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: boolean;
        column_default: string | null;
        is_pk: boolean;
      }>(
        `SELECT n.nspname AS table_schema,
                c.relname AS table_name,
                a.attname AS column_name,
                format_type(a.atttypid, a.atttypmod) AS data_type,
                NOT a.attnotnull AS is_nullable,
                pg_get_expr(d.adbin, d.adrelid) AS column_default,
                COALESCE(pk.is_pk, false) AS is_pk
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           LEFT JOIN (
             SELECT i.indrelid, k.attnum, true AS is_pk
               FROM pg_index i
               JOIN pg_attribute k ON k.attrelid = i.indrelid AND k.attnum = ANY (i.indkey)
              WHERE i.indisprimary
           ) pk ON pk.indrelid = a.attrelid AND pk.attnum = a.attnum
          WHERE c.relkind IN ('r','v','m','p')
            AND a.attnum > 0 AND NOT a.attisdropped
            AND n.nspname NOT IN (${sysList})
            AND n.nspname NOT LIKE 'pg_temp%'
          ORDER BY n.nspname, c.relname, a.attnum`,
        SYSTEM_SCHEMAS
      );

      const tableMap = new Map<string, TableInfo>();
      for (const t of tables.rows) {
        const key = `${t.table_schema}.${t.table_name}`;
        tableMap.set(key, {
          schema: t.table_schema,
          name: t.table_name,
          kind: t.kind,
          columns: [],
        });
      }
      for (const col of columns.rows) {
        const key = `${col.table_schema}.${col.table_name}`;
        const t = tableMap.get(key);
        if (!t) continue;
        t.columns.push({
          name: col.column_name,
          type: col.data_type,
          nullable: col.is_nullable,
          default: col.column_default,
          is_pk: col.is_pk,
        });
      }

      const result: SchemaInfo[] = schemas.rows.map((s) => ({
        name: s.schema_name,
        tables: [],
      }));
      const byName = new Map(result.map((s) => [s.name, s]));
      for (const t of tableMap.values()) {
        byName.get(t.schema)?.tables.push(t);
      }
      return result;
    },

    getTableShape,

    async selectTable({ schema, name, limit, offset, orderBy, orderDir }) {
      // schema/name/orderBy are validated by the handler against getTableShape
      // and re-quoted here with %I server-side as defence in depth.
      const dir = orderDir === 'desc' ? 'DESC' : 'ASC';
      const orderClause = orderBy
        ? await buildOrderClause(pool, orderBy, dir)
        : '';
      const fq = await quoteQualified(pool, schema, name);

      const dataSql = `SELECT * FROM ${fq}${orderClause} LIMIT $1 OFFSET $2`;
      const countSql = `SELECT count(*)::bigint AS count FROM ${fq}`;
      const [data, cnt] = await Promise.all([
        pool.query(dataSql, [limit, offset]),
        pool.query<{ count: string }>(countSql),
      ]);
      return {
        rows: data.rows as Record<string, unknown>[],
        count: Number(cnt.rows[0]?.count ?? 0),
      };
    },

    async insertRow(schema, name, values) {
      const fq = await quoteQualified(pool, schema, name);
      const keys = Object.keys(values);
      if (keys.length === 0) {
        const { rows } = await pool.query(
          `INSERT INTO ${fq} DEFAULT VALUES RETURNING *`
        );
        return rows[0] as Record<string, unknown>;
      }
      const cols = await quoteIdentList(pool, keys);
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const params = keys.map((k) => values[k]);
      const { rows } = await pool.query(
        `INSERT INTO ${fq} (${cols}) VALUES (${placeholders}) RETURNING *`,
        params
      );
      return rows[0] as Record<string, unknown>;
    },

    async updateRows(schema, name, where, set) {
      const fq = await quoteQualified(pool, schema, name);
      const setKeys = Object.keys(set);
      const whereKeys = Object.keys(where);
      const params: unknown[] = [];
      const setParts: string[] = [];
      for (const k of setKeys) {
        params.push(set[k]);
        setParts.push(`${await quoteIdent(pool, k)} = $${params.length}`);
      }
      const whereParts: string[] = [];
      for (const k of whereKeys) {
        params.push(where[k]);
        whereParts.push(`${await quoteIdent(pool, k)} = $${params.length}`);
      }
      const whereClause =
        whereParts.length > 0 ? ` WHERE ${whereParts.join(' AND ')}` : '';
      const res = await pool.query(
        `UPDATE ${fq} SET ${setParts.join(', ')}${whereClause}`,
        params
      );
      return res.rowCount ?? 0;
    },

    async deleteRows(schema, name, where) {
      const fq = await quoteQualified(pool, schema, name);
      const whereKeys = Object.keys(where);
      const params: unknown[] = [];
      const whereParts: string[] = [];
      for (const k of whereKeys) {
        params.push(where[k]);
        whereParts.push(`${await quoteIdent(pool, k)} = $${params.length}`);
      }
      const whereClause =
        whereParts.length > 0 ? ` WHERE ${whereParts.join(' AND ')}` : '';
      const res = await pool.query(`DELETE FROM ${fq}${whereClause}`, params);
      return res.rowCount ?? 0;
    },

    async query(sql, params) {
      // The SQL console. Wrap in a transaction with a LOCAL statement timeout so
      // a runaway query can't pin the connection. Errors propagate to the
      // handler, which returns them as clean JSON.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SET LOCAL statement_timeout = ${Number(config.statementTimeoutMs)}`
        );
        const res = await client.query(sql, params);
        await client.query('COMMIT');
        return {
          rows: (res.rows ?? []) as Record<string, unknown>[],
          rowCount: res.rowCount ?? 0,
          fields: (res.fields ?? []).map((f) => ({
            name: f.name,
            dataTypeID: f.dataTypeID,
          })),
        };
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore rollback failure */
        }
        throw e;
      } finally {
        client.release();
      }
    },

    async listPolicies() {
      const { rows } = await pool.query<{
        schemaname: string;
        tablename: string;
        policyname: string;
        cmd: string;
        roles: string[];
        qual: string | null;
        with_check: string | null;
      }>(
        `SELECT schemaname, tablename, policyname, cmd, roles, qual, with_check
           FROM pg_policies
          ORDER BY schemaname, tablename, policyname`
      );
      const rls = await pool.query<{
        schemaname: string;
        tablename: string;
        rls: boolean;
      }>(
        `SELECT n.nspname AS schemaname, c.relname AS tablename, c.relrowsecurity AS rls
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r','p')
            AND n.nspname NOT IN (${sysList})`,
        SYSTEM_SCHEMAS
      );
      const rlsMap = new Map(
        rls.rows.map((r) => [`${r.schemaname}.${r.tablename}`, r.rls])
      );
      return rows.map((r) => ({
        schema: r.schemaname,
        table: r.tablename,
        policyname: r.policyname,
        cmd: r.cmd,
        roles: r.roles ?? [],
        qual: r.qual,
        with_check: r.with_check,
        rls_enabled: rlsMap.get(`${r.schemaname}.${r.tablename}`) ?? false,
      }));
    },

    async listRoles() {
      const { rows } = await pool.query<{
        rolname: string;
        rolcanlogin: boolean;
        rolbypassrls: boolean;
        memberof: string[] | null;
      }>(
        `SELECT r.rolname,
                r.rolcanlogin,
                r.rolbypassrls,
                ARRAY(
                  SELECT g.rolname
                    FROM pg_auth_members m
                    JOIN pg_roles g ON g.oid = m.roleid
                   WHERE m.member = r.oid
                   ORDER BY g.rolname
                ) AS memberof
           FROM pg_roles r
          ORDER BY r.rolname`
      );
      return rows.map((r) => ({
        rolname: r.rolname,
        login: r.rolcanlogin,
        bypassrls: r.rolbypassrls,
        memberof: r.memberof ?? [],
      }));
    },

    async listAuthUsers(limit, offset) {
      // NEVER select password_hash.
      const { rows } = await pool.query<AdminUser>(
        `SELECT id, username, is_anonymous, created_at
           FROM auth.users
          ORDER BY created_at DESC
          LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return rows;
    },

    async deleteAuthUser(id) {
      const res = await pool.query(`DELETE FROM auth.users WHERE id = $1`, [id]);
      return (res.rowCount ?? 0) > 0;
    },

    async listBuckets() {
      const { rows } = await pool.query<BucketInfo>(
        `SELECT name, public, created_at FROM storage.buckets ORDER BY name`
      );
      return rows;
    },

    async listObjects(bucket, limit) {
      if (bucket) {
        const { rows } = await pool.query<ObjectInfo>(
          `SELECT id, bucket, path, size, mime, owner, created_at, updated_at
             FROM storage.objects
            WHERE bucket = $1
            ORDER BY created_at DESC
            LIMIT $2`,
          [bucket, limit]
        );
        return rows;
      }
      const { rows } = await pool.query<ObjectInfo>(
        `SELECT id, bucket, path, size, mime, owner, created_at, updated_at
           FROM storage.objects
          ORDER BY created_at DESC
          LIMIT $1`,
        [limit]
      );
      return rows;
    },

    async stats() {
      const q = async (sql: string): Promise<number> => {
        try {
          const { rows } = await pool.query<{ n: string }>(sql);
          return Number(rows[0]?.n ?? 0);
        } catch {
          return 0;
        }
      };
      const [users, buckets, objects] = await Promise.all([
        q(`SELECT count(*)::bigint AS n FROM auth.users`),
        q(`SELECT count(*)::bigint AS n FROM storage.buckets`),
        q(`SELECT count(*)::bigint AS n FROM storage.objects`),
      ]);
      const tables = await q(
        `SELECT count(*)::bigint AS n
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r','p')
            AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')`
      );
      let dbSize = 'unknown';
      try {
        const { rows } = await pool.query<{ s: string }>(
          `SELECT pg_size_pretty(pg_database_size(current_database())) AS s`
        );
        dbSize = rows[0]?.s ?? 'unknown';
      } catch {
        /* leave as unknown */
      }
      return {
        users,
        tables,
        buckets,
        objects,
        db_size_pretty: dbSize,
      };
    },

    async close() {
      await pool.end();
    },
  };
}

// -- Server-side identifier quoting via format('%I', …) -----------------------
// We always round-trip identifiers through Postgres' own quote_ident so the DB
// (not us) produces the safely-escaped, double-quoted form. Combined with the
// handler-side catalog whitelist this is belt-and-braces against injection.

async function quoteIdent(pool: pg.Pool, ident: string): Promise<string> {
  const { rows } = await pool.query<{ q: string }>(
    `SELECT quote_ident($1) AS q`,
    [ident]
  );
  return rows[0].q;
}

async function quoteIdentList(pool: pg.Pool, idents: string[]): Promise<string> {
  const quoted = await Promise.all(idents.map((i) => quoteIdent(pool, i)));
  return quoted.join(', ');
}

async function quoteQualified(
  pool: pg.Pool,
  schema: string,
  name: string
): Promise<string> {
  const { rows } = await pool.query<{ s: string; t: string }>(
    `SELECT quote_ident($1) AS s, quote_ident($2) AS t`,
    [schema, name]
  );
  return `${rows[0].s}.${rows[0].t}`;
}

async function buildOrderClause(
  pool: pg.Pool,
  orderBy: string,
  dir: 'ASC' | 'DESC'
): Promise<string> {
  const col = await quoteIdent(pool, orderBy);
  return ` ORDER BY ${col} ${dir}`;
}
