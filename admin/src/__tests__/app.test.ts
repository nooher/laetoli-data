import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createFakeDb, type FakeDb } from './fakeDb.js';

const KEY = 'k'.repeat(40);

function app(fake?: FakeDb) {
  return createApp({ db: fake ?? createFakeDb(), adminApiKey: KEY });
}

function auth(req: request.Test) {
  return req.set('Authorization', `Bearer ${KEY}`);
}

describe('admin HTTP routes (supertest, fake Db)', () => {
  // -- health + key gating ----------------------------------------------------

  it('GET /health → { ok: true } without a key', async () => {
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /schema without a key → 401', async () => {
    const res = await request(app()).get('/schema');
    expect(res.status).toBe(401);
    expect(res.body.error).toBeTruthy();
  });

  it('GET /schema with WRONG key → 401', async () => {
    const res = await request(app()).get('/schema').set('Authorization', 'Bearer wrong');
    expect(res.status).toBe(401);
  });

  it('GET /schema with x-admin-key header → 200', async () => {
    const res = await request(app()).get('/schema').set('x-admin-key', KEY);
    expect(res.status).toBe(200);
  });

  // -- schema -----------------------------------------------------------------

  it('GET /schema lists schemas, tables, columns', async () => {
    const res = await auth(request(app()).get('/schema'));
    expect(res.status).toBe(200);
    const pub = res.body.schemas.find((s: { name: string }) => s.name === 'public');
    expect(pub).toBeTruthy();
    const notes = pub.tables.find((t: { name: string }) => t.name === 'notes');
    expect(notes.kind).toBe('table');
    const idCol = notes.columns.find((c: { name: string }) => c.name === 'id');
    expect(idCol.is_pk).toBe(true);
  });

  // -- table read -------------------------------------------------------------

  it('GET /table/public/notes → rows + count', async () => {
    const res = await auth(request(app()).get('/table/public/notes'));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.rows).toHaveLength(2);
  });

  it('GET /table for unknown table → 404', async () => {
    const res = await auth(request(app()).get('/table/public/nope'));
    expect(res.status).toBe(404);
  });

  it('GET /table rejects an injection-y identifier → 400', async () => {
    const res = await auth(request(app()).get('/table/public/notes%3B%20drop'));
    expect(res.status).toBe(400);
  });

  it('GET /table rejects an unknown order column → 400', async () => {
    const res = await auth(request(app()).get('/table/public/notes?order=evil'));
    expect(res.status).toBe(400);
  });

  // -- table write ------------------------------------------------------------

  it('POST /table inserts a row', async () => {
    const res = await auth(request(app()).post('/table/public/notes')).send({
      title: 'third',
      owner: 'u3',
    });
    expect(res.status).toBe(201);
    expect(res.body.row.title).toBe('third');
  });

  it('POST /table rejects an unknown column → 400', async () => {
    const res = await auth(request(app()).post('/table/public/notes')).send({ bogus: 1 });
    expect(res.status).toBe(400);
  });

  it('POST /table into a view → 400', async () => {
    const res = await auth(request(app()).post('/table/public/notes_view')).send({ id: 9 });
    expect(res.status).toBe(400);
  });

  it('PATCH /table updates by where', async () => {
    const res = await auth(request(app()).patch('/table/public/notes')).send({
      where: { id: 1 },
      set: { title: 'updated' },
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
  });

  it('PATCH /table without where → 400 (no unbounded update)', async () => {
    const res = await auth(request(app()).patch('/table/public/notes')).send({
      where: {},
      set: { title: 'x' },
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /table deletes by where', async () => {
    const res = await auth(request(app()).delete('/table/public/notes')).send({
      where: { id: 2 },
    });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
  });

  it('DELETE /table without where → 400 (no unbounded delete)', async () => {
    const res = await auth(request(app()).delete('/table/public/notes')).send({ where: {} });
    expect(res.status).toBe(400);
  });

  // -- SQL console ------------------------------------------------------------

  it('POST /sql runs a query and returns rows/rowCount/fields', async () => {
    const res = await auth(request(app()).post('/sql')).send({ query: 'SELECT 1' });
    expect(res.status).toBe(200);
    expect(res.body.rowCount).toBe(1);
    expect(res.body.fields).toHaveLength(1);
  });

  it('POST /sql with no query → 400', async () => {
    const res = await auth(request(app()).post('/sql')).send({});
    expect(res.status).toBe(400);
  });

  it('POST /sql surfaces DB errors as clean JSON (no 500)', async () => {
    const fake = createFakeDb();
    fake.failNextQuery('relation "nope" does not exist', '42P01');
    const res = await auth(request(app(fake)).post('/sql')).send({ query: 'SELECT * FROM nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not exist/);
    expect(res.body.code).toBe('42P01');
  });

  it('POST /sql without key → 401', async () => {
    const res = await request(app()).post('/sql').send({ query: 'SELECT 1' });
    expect(res.status).toBe(401);
  });

  // -- management -------------------------------------------------------------

  it('GET /policies → RLS policies', async () => {
    const res = await auth(request(app()).get('/policies'));
    expect(res.status).toBe(200);
    expect(res.body.policies[0].rls_enabled).toBe(true);
  });

  it('GET /roles → roles incl. bypassrls flag, no password', async () => {
    const res = await auth(request(app()).get('/roles'));
    expect(res.status).toBe(200);
    const admin = res.body.roles.find((r: { rolname: string }) => r.rolname === 'laetoli_admin');
    expect(admin.bypassrls).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });

  it('GET /auth/users → users without password_hash', async () => {
    const res = await auth(request(app()).get('/auth/users'));
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash/);
  });

  it('DELETE /auth/users/:id removes a user', async () => {
    const res = await auth(request(app()).delete('/auth/users/u1'));
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it('DELETE /auth/users/:id unknown → 404', async () => {
    const res = await auth(request(app()).delete('/auth/users/nope'));
    expect(res.status).toBe(404);
  });

  it('GET /storage/buckets', async () => {
    const res = await auth(request(app()).get('/storage/buckets'));
    expect(res.status).toBe(200);
    expect(res.body.buckets[0].name).toBe('avatars');
  });

  it('GET /storage/objects?bucket=', async () => {
    const res = await auth(request(app()).get('/storage/objects?bucket=avatars'));
    expect(res.status).toBe(200);
    expect(res.body.objects).toHaveLength(1);
  });

  it('GET /stats → dashboard counts', async () => {
    const res = await auth(request(app()).get('/stats'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ users: 2, buckets: 1, objects: 1 });
    expect(res.body.db_size_pretty).toBeTruthy();
  });

  // -- generic ----------------------------------------------------------------

  it('unknown route (with key) → 404 JSON', async () => {
    const res = await auth(request(app()).get('/nope'));
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });

  it('malformed JSON → 400', async () => {
    const res = await auth(
      request(app()).post('/sql').set('Content-Type', 'application/json')
    ).send('{not json');
    expect(res.status).toBe(400);
  });

  // -- API keys / projects / quotas -------------------------------------------

  it('GET /projects → seeded default project', async () => {
    const res = await auth(request(app()).get('/projects'));
    expect(res.status).toBe(200);
    expect(res.body.projects.some((p: { name: string }) => p.name === 'default')).toBe(true);
  });

  it('GET /projects without key → 401', async () => {
    const res = await request(app()).get('/projects');
    expect(res.status).toBe(401);
  });

  it('POST /projects creates a project', async () => {
    const res = await auth(request(app()).post('/projects')).send({ name: 'acme' });
    expect(res.status).toBe(201);
    expect(res.body.project.name).toBe('acme');
    expect(res.body.project.id).toBeTruthy();
  });

  it('POST /projects without name → 400', async () => {
    const res = await auth(request(app()).post('/projects')).send({});
    expect(res.status).toBe(400);
  });

  it('POST /projects duplicate name → 409', async () => {
    const a = app();
    await auth(request(a).post('/projects')).send({ name: 'dup' });
    const again = await auth(request(a).post('/projects')).send({ name: 'dup' });
    expect(again.status).toBe(409);
  });

  it('DELETE /projects/:id removes it', async () => {
    const a = app();
    const created = await auth(request(a).post('/projects')).send({ name: 'tmp' });
    const id = created.body.project.id;
    const del = await auth(request(a).delete(`/projects/${id}`));
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
  });

  it('DELETE /projects/:id unknown → 404', async () => {
    const res = await auth(request(app()).delete('/projects/nope'));
    expect(res.status).toBe(404);
  });

  it('POST /projects/:id/keys returns the full apikey ONCE', async () => {
    const a = app();
    const proj = await auth(request(a).post('/projects')).send({ name: 'keys-proj' });
    const id = proj.body.project.id;

    const res = await auth(request(a).post(`/projects/${id}/keys`)).send({
      name: 'server key',
      role: 'service',
    });
    expect(res.status).toBe(201);
    expect(res.body.apikey).toMatch(/^ld_[A-Za-z0-9]+\.[A-Za-z0-9]+$/);
    expect(res.body.role).toBe('service');
    expect(res.body.key_prefix).toBeTruthy();
    expect(res.body.rate_limit_per_min).toBe(120);
    // The hash must never be returned.
    expect(JSON.stringify(res.body)).not.toMatch(/key_hash/);

    // Listing the key must NOT include the apikey or the hash again.
    const list = await auth(request(a).get(`/projects/${id}/keys`));
    expect(list.status).toBe(200);
    expect(list.body.keys).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/apikey|key_hash/);
  });

  it('POST /projects/:id/keys honours rate_limit_per_min', async () => {
    const a = app();
    const proj = await auth(request(a).post('/projects')).send({ name: 'rl-proj' });
    const id = proj.body.project.id;
    const res = await auth(request(a).post(`/projects/${id}/keys`)).send({
      role: 'anon',
      rate_limit_per_min: 30,
    });
    expect(res.status).toBe(201);
    expect(res.body.rate_limit_per_min).toBe(30);
  });

  it('POST /projects/:id/keys with bad role → 400', async () => {
    const a = app();
    const proj = await auth(request(a).post('/projects')).send({ name: 'badrole' });
    const id = proj.body.project.id;
    const res = await auth(request(a).post(`/projects/${id}/keys`)).send({ role: 'root' });
    expect(res.status).toBe(400);
  });

  it('POST /projects/:id/keys for unknown project → 404', async () => {
    const res = await auth(request(app()).post('/projects/nope/keys')).send({ role: 'anon' });
    expect(res.status).toBe(404);
  });

  it('DELETE /keys/:id revokes a key', async () => {
    const a = app();
    const proj = await auth(request(a).post('/projects')).send({ name: 'revoke-proj' });
    const id = proj.body.project.id;
    const key = await auth(request(a).post(`/projects/${id}/keys`)).send({ role: 'anon' });
    const kid = key.body.id;

    const del = await auth(request(a).delete(`/keys/${kid}`));
    expect(del.status).toBe(200);
    expect(del.body.revoked).toBe(true);

    // Revoking again → 404 (already revoked).
    const again = await auth(request(a).delete(`/keys/${kid}`));
    expect(again.status).toBe(404);
  });

  it('GET /usage → rows + total', async () => {
    const res = await auth(request(app()).get('/usage'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.usage)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('GET /usage?project_id= filters', async () => {
    const a = app();
    const proj = await auth(request(a).post('/projects')).send({ name: 'usage-proj' });
    const id = proj.body.project.id;
    const res = await auth(request(a).get(`/usage?project_id=${id}`));
    expect(res.status).toBe(200);
    expect(res.body.usage).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});
