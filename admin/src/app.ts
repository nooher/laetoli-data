// Express app factory. The Db and admin key are injected, so the app can be
// constructed in tests with a fake Db (no Postgres) and any test key.

import express, { type Express, type Request, type Response } from 'express';
import type { Db } from './db.js';
import { requireAdminKey } from './auth.js';
import {
  handleSchema,
  handleSelectTable,
  handleInsert,
  handleUpdate,
  handleDelete,
  handleSql,
  handlePolicies,
  handleRoles,
  handleAuthUsers,
  handleDeleteAuthUser,
  handleBuckets,
  handleObjects,
  handleStats,
  handleListProjects,
  handleCreateProject,
  handleDeleteProject,
  handleListKeys,
  handleCreateKey,
  handleRevokeKey,
  handleUsage,
  type HandlerDeps,
} from './handlers.js';

export interface AppDeps {
  db: Db;
  adminApiKey: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.set('trust proxy', true);
  // SQL console payloads can be larger than auth bodies; allow up to 1 MB.
  app.use(express.json({ limit: '1mb' }));

  const handlerDeps: HandlerDeps = { db: deps.db };

  const send = (res: Response, r: { status: number; body: unknown }) =>
    res.status(r.status).json(r.body);

  // Health is the ONLY unauthenticated route.
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Everything below requires the admin key (constant-time).
  app.use(requireAdminKey(deps.adminApiKey));

  app.get('/schema', async (_req, res, next) => {
    try {
      send(res, await handleSchema(handlerDeps));
    } catch (e) {
      next(e);
    }
  });

  app.get('/table/:schema/:name', async (req, res, next) => {
    try {
      send(
        res,
        await handleSelectTable(handlerDeps, req.params.schema, req.params.name, req.query)
      );
    } catch (e) {
      next(e);
    }
  });

  app.post('/table/:schema/:name', async (req, res, next) => {
    try {
      send(res, await handleInsert(handlerDeps, req.params.schema, req.params.name, req.body));
    } catch (e) {
      next(e);
    }
  });

  app.patch('/table/:schema/:name', async (req, res, next) => {
    try {
      send(res, await handleUpdate(handlerDeps, req.params.schema, req.params.name, req.body));
    } catch (e) {
      next(e);
    }
  });

  app.delete('/table/:schema/:name', async (req, res, next) => {
    try {
      send(res, await handleDelete(handlerDeps, req.params.schema, req.params.name, req.body));
    } catch (e) {
      next(e);
    }
  });

  app.post('/sql', async (req, res, next) => {
    try {
      send(res, await handleSql(handlerDeps, req.body ?? {}));
    } catch (e) {
      next(e);
    }
  });

  app.get('/policies', async (_req, res, next) => {
    try {
      send(res, await handlePolicies(handlerDeps));
    } catch (e) {
      next(e);
    }
  });

  app.get('/roles', async (_req, res, next) => {
    try {
      send(res, await handleRoles(handlerDeps));
    } catch (e) {
      next(e);
    }
  });

  app.get('/auth/users', async (req, res, next) => {
    try {
      send(res, await handleAuthUsers(handlerDeps, req.query));
    } catch (e) {
      next(e);
    }
  });

  app.delete('/auth/users/:id', async (req, res, next) => {
    try {
      send(res, await handleDeleteAuthUser(handlerDeps, req.params.id));
    } catch (e) {
      next(e);
    }
  });

  app.get('/storage/buckets', async (_req, res, next) => {
    try {
      send(res, await handleBuckets(handlerDeps));
    } catch (e) {
      next(e);
    }
  });

  app.get('/storage/objects', async (req, res, next) => {
    try {
      send(res, await handleObjects(handlerDeps, req.query));
    } catch (e) {
      next(e);
    }
  });

  app.get('/stats', async (_req, res, next) => {
    try {
      send(res, await handleStats(handlerDeps));
    } catch (e) {
      next(e);
    }
  });

  // ---- API keys / projects / quotas (multi-tenant) ------------------------
  app.get('/projects', async (_req, res, next) => {
    try {
      send(res, await handleListProjects(handlerDeps));
    } catch (e) {
      next(e);
    }
  });

  app.post('/projects', async (req, res, next) => {
    try {
      send(res, await handleCreateProject(handlerDeps, req.body ?? {}));
    } catch (e) {
      next(e);
    }
  });

  app.delete('/projects/:id', async (req, res, next) => {
    try {
      send(res, await handleDeleteProject(handlerDeps, req.params.id));
    } catch (e) {
      next(e);
    }
  });

  app.get('/projects/:id/keys', async (req, res, next) => {
    try {
      send(res, await handleListKeys(handlerDeps, req.params.id));
    } catch (e) {
      next(e);
    }
  });

  app.post('/projects/:id/keys', async (req, res, next) => {
    try {
      send(res, await handleCreateKey(handlerDeps, req.params.id, req.body ?? {}));
    } catch (e) {
      next(e);
    }
  });

  app.delete('/keys/:id', async (req, res, next) => {
    try {
      send(res, await handleRevokeKey(handlerDeps, req.params.id));
    } catch (e) {
      next(e);
    }
  });

  app.get('/usage', async (req, res, next) => {
    try {
      send(res, await handleUsage(handlerDeps, req.query));
    } catch (e) {
      next(e);
    }
  });

  // JSON 404 + error handler (never leak internals).
  app.use((_req, res) => {
    res.status(404).json({ error: 'Njia haipatikani. (Route not found.)' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use(
    (e: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
      if (
        e &&
        typeof e === 'object' &&
        'type' in e &&
        (e as { type?: string }).type === 'entity.parse.failed'
      ) {
        res.status(400).json({ error: 'Mwili wa ombi si JSON sahihi. (Invalid JSON body.)' });
        return;
      }
      console.error('[admin] unhandled error:', e);
      res.status(500).json({ error: 'Hitilafu ya seva. (Server error.)' });
    }
  );

  return app;
}
