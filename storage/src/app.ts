// Express app factory. The Db, object store, and config are injected, so the
// app can be constructed in tests with a fake Db + temp-dir store (no Postgres,
// no Docker required). Mirrors auth/src/app.ts.

import express, { type Express, type Request, type Response } from 'express';
import type { Db } from './db.js';
import type { ObjectStore } from './store.js';
import {
  handleUpload,
  handleDownload,
  handleList,
  handleDelete,
  handleCreateBucket,
  handleListBuckets,
  handleDeleteBucket,
  handleSign,
  handleSigned,
  isStreamResult,
  type HandlerDeps,
  type JsonResult,
  type StreamResult,
} from './handlers.js';

export interface AppDeps {
  db: Db;
  store: ObjectStore;
  jwtSecret: string;
  /** Max upload size in bytes. */
  maxUploadBytes?: number;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.set('trust proxy', true);

  // JSON only for the metadata/bucket/sign endpoints. Object bodies are read as
  // raw streams (no body parser) so uploads never buffer fully in memory.
  const json = express.json({ limit: '64kb' });

  const handlerDeps: HandlerDeps = {
    db: deps.db,
    store: deps.store,
    jwtSecret: deps.jwtSecret,
  };
  const maxUploadBytes = deps.maxUploadBytes ?? 50 * 1024 * 1024;

  const sendJson = (res: Response, r: JsonResult) =>
    res.status(r.status).json(r.body);

  const sendResult = (res: Response, r: JsonResult | StreamResult) => {
    if (isStreamResult(r)) {
      res.status(200);
      res.setHeader('Content-Type', r.mime);
      res.setHeader('Content-Length', String(r.size));
      r.stream.on('error', () => {
        if (!res.headersSent) res.status(500);
        res.end();
      });
      r.stream.pipe(res);
      return;
    }
    res.status(r.status).json(r.body);
  };

  // The `*` wildcard captures the object path (everything after :bucket).
  const objectPath = (req: Request): string =>
    (req.params[0] as string) ?? '';

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'laetoli-storage' });
  });

  // ---- buckets ------------------------------------------------------------
  app.post('/bucket', json, async (req, res, next) => {
    try {
      sendJson(
        res,
        await handleCreateBucket(
          handlerDeps,
          req.header('authorization'),
          req.body ?? {}
        )
      );
    } catch (e) {
      next(e);
    }
  });

  app.get('/bucket', async (req, res, next) => {
    try {
      sendJson(
        res,
        await handleListBuckets(handlerDeps, req.header('authorization'))
      );
    } catch (e) {
      next(e);
    }
  });

  app.delete('/bucket/:name', async (req, res, next) => {
    try {
      sendJson(
        res,
        await handleDeleteBucket(
          handlerDeps,
          req.header('authorization'),
          req.params.name
        )
      );
    } catch (e) {
      next(e);
    }
  });

  // ---- listing ------------------------------------------------------------
  app.get('/list/:bucket', async (req, res, next) => {
    try {
      sendJson(
        res,
        await handleList(handlerDeps, req.header('authorization'), req.params.bucket, {
          prefix: req.query.prefix,
          limit: req.query.limit,
        })
      );
    } catch (e) {
      next(e);
    }
  });

  // ---- signed URLs --------------------------------------------------------
  app.post('/sign/:bucket/*', json, async (req, res, next) => {
    try {
      sendJson(
        res,
        await handleSign(
          handlerDeps,
          req.header('authorization'),
          req.params.bucket,
          objectPath(req),
          req.body ?? {}
        )
      );
    } catch (e) {
      next(e);
    }
  });

  app.get('/signed/:bucket/*', async (req, res, next) => {
    try {
      sendResult(
        res,
        await handleSigned(
          handlerDeps,
          req.params.bucket,
          objectPath(req),
          req.query.token
        )
      );
    } catch (e) {
      next(e);
    }
  });

  // ---- objects ------------------------------------------------------------
  app.put(
    '/object/:bucket/*',
    express.raw({ type: () => true, limit: maxUploadBytes }),
    async (req, res, next) => {
      try {
        // express.raw buffers into req.body (a Buffer). Wrap it as a stream for
        // the store. (Streaming the raw req directly is possible but raw() gives
        // us the size limit enforcement for free.)
        const { Readable } = await import('node:stream');
        const buf: Buffer = Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.alloc(0);
        const body = Readable.from(buf);
        sendJson(
          res,
          await handleUpload(
            handlerDeps,
            req.header('authorization'),
            req.params.bucket,
            objectPath(req),
            body,
            req.header('content-type')
          )
        );
      } catch (e) {
        next(e);
      }
    }
  );

  app.get('/object/:bucket/*', async (req, res, next) => {
    try {
      sendResult(
        res,
        await handleDownload(
          handlerDeps,
          req.header('authorization'),
          req.params.bucket,
          objectPath(req)
        )
      );
    } catch (e) {
      next(e);
    }
  });

  app.delete('/object/:bucket/*', async (req, res, next) => {
    try {
      sendJson(
        res,
        await handleDelete(
          handlerDeps,
          req.header('authorization'),
          req.params.bucket,
          objectPath(req)
        )
      );
    } catch (e) {
      next(e);
    }
  });

  // JSON 404 + error handler (never leak internals).
  app.use((_req, res) => {
    res.status(404).json({ error: 'Njia haipatikani.' });
  });

  app.use(
    (
      e: unknown,
      _req: Request,
      res: Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      // Payload too large from express.raw / express.json.
      if (
        e &&
        typeof e === 'object' &&
        'type' in e &&
        (e as { type?: string }).type === 'entity.too.large'
      ) {
        res.status(413).json({ error: 'Faili ni kubwa mno.' });
        return;
      }
      if (
        e &&
        typeof e === 'object' &&
        'type' in e &&
        (e as { type?: string }).type === 'entity.parse.failed'
      ) {
        res.status(400).json({ error: 'Mwili wa ombi si JSON sahihi.' });
        return;
      }
      console.error('[storage] unhandled error:', e);
      res.status(500).json({ error: 'Hitilafu ya seva.' });
    }
  );

  return app;
}
