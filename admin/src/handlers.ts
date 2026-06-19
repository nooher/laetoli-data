// Request handlers as small, DB-injected functions. They take plain inputs and
// return a { status, body } result, so they can be unit-tested directly (no HTTP
// server, no live Postgres) by passing the in-memory fake Db.
//
// Identifier safety: for every table operation we FIRST resolve the table via
// db.getTableShape (the live catalog). If the schema/table doesn't exist we 404.
// Every column named in body/order is then checked to be a real column of that
// table; unknown columns are rejected. Values always travel as bound params.

import type { Db } from './db.js';
import {
  validateIdentifier,
  parseLimit,
  parseOffset,
  parseOrder,
  isPlainObject,
} from './validation.js';

export interface HandlerDeps {
  db: Db;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

function err(message: string): { error: string } {
  return { error: message };
}

// -- Schema -------------------------------------------------------------------

export async function handleSchema(deps: HandlerDeps): Promise<HandlerResult> {
  const schemas = await deps.db.listSchemas();
  return { status: 200, body: { schemas } };
}

// -- Table read ---------------------------------------------------------------

export async function handleSelectTable(
  deps: HandlerDeps,
  schema: string,
  name: string,
  query: { limit?: unknown; offset?: unknown; order?: unknown }
): Promise<HandlerResult> {
  const vs = validateIdentifier(schema, 'schema');
  if (!vs.ok) return { status: 400, body: err(vs.error!) };
  const vn = validateIdentifier(name, 'table');
  if (!vn.ok) return { status: 400, body: err(vn.error!) };

  const shape = await deps.db.getTableShape(schema, name);
  if (!shape) {
    return { status: 404, body: err('Jedwali halipatikani. (Table not found.)') };
  }

  const order = parseOrder(query.order);
  if (order && !shape.columns.includes(order.column)) {
    return {
      status: 400,
      body: err('Safu ya kupanga haipo kwenye jedwali. (Unknown order column.)'),
    };
  }

  const page = await deps.db.selectTable({
    schema,
    name,
    limit: parseLimit(query.limit),
    offset: parseOffset(query.offset),
    orderBy: order?.column,
    orderDir: order?.dir,
  });
  return { status: 200, body: page };
}

// -- Table write --------------------------------------------------------------

/** Ensure every key in `obj` is a real column of `columns`. */
function unknownColumn(
  obj: Record<string, unknown>,
  columns: string[]
): string | null {
  for (const k of Object.keys(obj)) {
    if (!columns.includes(k)) return k;
  }
  return null;
}

export async function handleInsert(
  deps: HandlerDeps,
  schema: string,
  name: string,
  body: unknown
): Promise<HandlerResult> {
  const shape = await deps.db.getTableShape(schema, name);
  if (!shape) {
    return { status: 404, body: err('Jedwali halipatikani. (Table not found.)') };
  }
  if (shape.kind === 'view') {
    return { status: 400, body: err('Huwezi kuandika kwenye view. (Cannot write to a view.)') };
  }
  if (!isPlainObject(body)) {
    return { status: 400, body: err('Mwili wa ombi lazima uwe object. (Body must be an object.)') };
  }
  const bad = unknownColumn(body, shape.columns);
  if (bad) {
    return { status: 400, body: err(`Safu haipo: ${bad}. (Unknown column: ${bad}.)`) };
  }
  const row = await deps.db.insertRow(schema, name, body);
  return { status: 201, body: { row } };
}

export async function handleUpdate(
  deps: HandlerDeps,
  schema: string,
  name: string,
  body: unknown
): Promise<HandlerResult> {
  const shape = await deps.db.getTableShape(schema, name);
  if (!shape) {
    return { status: 404, body: err('Jedwali halipatikani. (Table not found.)') };
  }
  if (shape.kind === 'view') {
    return { status: 400, body: err('Huwezi kuandika kwenye view. (Cannot write to a view.)') };
  }
  if (!isPlainObject(body) || !isPlainObject(body.where) || !isPlainObject(body.set)) {
    return {
      status: 400,
      body: err('Inahitaji { where: {...}, set: {...} }. (Body needs where + set objects.)'),
    };
  }
  if (Object.keys(body.set).length === 0) {
    return { status: 400, body: err('`set` haina safu yoyote. (`set` is empty.)') };
  }
  // Refuse an unbounded UPDATE — require at least one WHERE predicate.
  if (Object.keys(body.where).length === 0) {
    return { status: 400, body: err('`where` inahitajika ili kuepuka kubadili rekodi zote. (`where` is required.)') };
  }
  const badSet = unknownColumn(body.set, shape.columns);
  if (badSet) {
    return { status: 400, body: err(`Safu haipo katika set: ${badSet}.`) };
  }
  const badWhere = unknownColumn(body.where, shape.columns);
  if (badWhere) {
    return { status: 400, body: err(`Safu haipo katika where: ${badWhere}.`) };
  }
  const updated = await deps.db.updateRows(schema, name, body.where, body.set);
  return { status: 200, body: { updated } };
}

export async function handleDelete(
  deps: HandlerDeps,
  schema: string,
  name: string,
  body: unknown
): Promise<HandlerResult> {
  const shape = await deps.db.getTableShape(schema, name);
  if (!shape) {
    return { status: 404, body: err('Jedwali halipatikani. (Table not found.)') };
  }
  if (shape.kind === 'view') {
    return { status: 400, body: err('Huwezi kufuta kutoka view. (Cannot delete from a view.)') };
  }
  if (!isPlainObject(body) || !isPlainObject(body.where)) {
    return {
      status: 400,
      body: err('Inahitaji { where: {...} }. (Body needs a where object.)'),
    };
  }
  // Refuse an unbounded DELETE.
  if (Object.keys(body.where).length === 0) {
    return { status: 400, body: err('`where` inahitajika ili kuepuka kufuta rekodi zote. (`where` is required.)') };
  }
  const bad = unknownColumn(body.where, shape.columns);
  if (bad) {
    return { status: 400, body: err(`Safu haipo katika where: ${bad}.`) };
  }
  const deleted = await deps.db.deleteRows(schema, name, body.where);
  return { status: 200, body: { deleted } };
}

// -- SQL console --------------------------------------------------------------

export async function handleSql(
  deps: HandlerDeps,
  body: unknown
): Promise<HandlerResult> {
  if (!isPlainObject(body) || typeof body.query !== 'string' || body.query.trim() === '') {
    return { status: 400, body: err('`query` (SQL) inahitajika. (`query` string required.)') };
  }
  let params: unknown[] | undefined;
  if (body.params !== undefined) {
    if (!Array.isArray(body.params)) {
      return { status: 400, body: err('`params` lazima iwe array. (`params` must be an array.)') };
    }
    params = body.params;
  }

  // Audit every console query (it runs with BYPASSRLS — the keys to the kingdom).
  const preview = body.query.replace(/\s+/g, ' ').trim().slice(0, 500);
  console.log(`[admin] SQL console: ${preview}`);

  try {
    const result = await deps.db.query(body.query, params);
    return { status: 200, body: result };
  } catch (e) {
    // Return DB errors as clean JSON (admin tool — surfacing the message is fine
    // and useful, but never the stack).
    const message = e instanceof Error ? e.message : String(e);
    const code =
      e && typeof e === 'object' && 'code' in e
        ? (e as { code?: unknown }).code
        : undefined;
    return { status: 400, body: { error: message, code } };
  }
}

// -- Management ---------------------------------------------------------------

export async function handlePolicies(deps: HandlerDeps): Promise<HandlerResult> {
  const policies = await deps.db.listPolicies();
  return { status: 200, body: { policies } };
}

export async function handleRoles(deps: HandlerDeps): Promise<HandlerResult> {
  const roles = await deps.db.listRoles();
  return { status: 200, body: { roles } };
}

export async function handleAuthUsers(
  deps: HandlerDeps,
  query: { limit?: unknown; offset?: unknown }
): Promise<HandlerResult> {
  const users = await deps.db.listAuthUsers(
    parseLimit(query.limit, 50, 500),
    parseOffset(query.offset)
  );
  return { status: 200, body: { users } };
}

export async function handleDeleteAuthUser(
  deps: HandlerDeps,
  id: string
): Promise<HandlerResult> {
  if (typeof id !== 'string' || id.trim() === '') {
    return { status: 400, body: err('Kitambulisho cha mtumiaji kinahitajika. (User id required.)') };
  }
  const ok = await deps.db.deleteAuthUser(id);
  if (!ok) {
    return { status: 404, body: err('Mtumiaji hapatikani. (User not found.)') };
  }
  return { status: 200, body: { deleted: true, id } };
}

export async function handleBuckets(deps: HandlerDeps): Promise<HandlerResult> {
  const buckets = await deps.db.listBuckets();
  return { status: 200, body: { buckets } };
}

export async function handleObjects(
  deps: HandlerDeps,
  query: { bucket?: unknown; limit?: unknown }
): Promise<HandlerResult> {
  const bucket =
    typeof query.bucket === 'string' && query.bucket.trim() !== ''
      ? query.bucket
      : undefined;
  const objects = await deps.db.listObjects(bucket, parseLimit(query.limit, 100, 1000));
  return { status: 200, body: { objects } };
}

export async function handleStats(deps: HandlerDeps): Promise<HandlerResult> {
  const stats = await deps.db.stats();
  return { status: 200, body: stats };
}
