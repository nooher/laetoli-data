// server.ts — wires the WebSocket server, the Postgres listener, and the Hub.
//
// One http.Server serves both:
//   * GET /health  — JSON liveness (also reports the LISTEN connection state).
//   * WS  /realtime — the realtime subscription endpoint (Caddy strips the
//                     /realtime prefix, so the path arrives as "/" or
//                     "/realtime"; we accept either).
//
// On a WS upgrade we verify the JWT (from ?token= primarily, or a first
// {type:'auth',token} message), register the socket with the Hub, then let the
// Hub handle subscribe/unsubscribe and fan-out. The dedicated pg listener feeds
// every NOTIFY into Hub.dispatch().

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { RealtimeConfig } from './config.js';
import { loadConfig } from './config.js';
import { verifyAccessToken } from './jwt.js';
import { Hub, parseNotification } from './hub.js';
import {
  createPgListener,
  type NotificationSource,
} from './listener.js';

export interface ServerDeps {
  config: RealtimeConfig;
  /** Injected for tests; defaults to the real pg listener. */
  listener?: NotificationSource;
}

export interface RealtimeServer {
  hub: Hub;
  httpServer: http.Server;
  wss: WebSocketServer;
  listener: NotificationSource;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createServer(deps: ServerDeps): RealtimeServer {
  const { config } = deps;
  const authGraceMs = config.authGraceMs; // window to send {type:'auth'} if no ?token=.
  const hub = new Hub();
  const listener = deps.listener ?? createPgListener(config);

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/realtime/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'laetoli-realtime',
          listening: listener.isHealthy(),
          clients: hub.clientCount,
        })
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Njia haipatikani.' }));
  });

  // noServer: we handle the upgrade ourselves so we can gate on path + JWT.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname, searchParams } = safeUrl(req.url);
    // Caddy strips /realtime/*, so accept "/", "/realtime", or "/realtime/".
    if (pathname !== '/' && pathname !== '/realtime' && pathname !== '/realtime/') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws, searchParams.get('token'));
    });
  });

  function onConnection(ws: WebSocket, queryToken: string | null): void {
    let authed = false;

    const authenticate = (token: string | null): boolean => {
      if (!token) return false;
      try {
        const claims = verifyAccessToken(token, config.jwtSecret);
        hub.add(ws, { sub: claims.sub, role: claims.role });
        authed = true;
        return true;
      } catch {
        return false;
      }
    };

    // Primary path: ?token= on the connect URL.
    if (queryToken) {
      if (!authenticate(queryToken)) {
        ws.close(4401, 'Unauthorized');
        return;
      }
    }

    // If not yet authed, allow a brief window for a {type:'auth',token} message.
    const graceTimer = authed
      ? null
      : setTimeout(() => {
          if (!authed) ws.close(4401, 'Unauthorized');
        }, authGraceMs);
    graceTimer?.unref?.();

    ws.on('message', (data) => {
      const raw = data.toString();
      if (!authed) {
        // Only an auth message is accepted before authentication.
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          ws.send(Hub.errorFrame('Lazima uthibitishe kwanza. (Authenticate first.)'));
          return;
        }
        const m = parsed as Record<string, unknown>;
        if (m && m.type === 'auth' && typeof m.token === 'string') {
          if (authenticate(m.token)) {
            if (graceTimer) clearTimeout(graceTimer);
            ws.send(JSON.stringify({ type: 'authenticated' }));
          } else {
            ws.close(4401, 'Unauthorized');
          }
          return;
        }
        ws.send(Hub.errorFrame('Lazima uthibitishe kwanza. (Authenticate first.)'));
        return;
      }
      hub.handleMessage(ws, raw);
    });

    ws.on('close', () => {
      if (graceTimer) clearTimeout(graceTimer);
      hub.remove(ws);
    });
    ws.on('error', () => {
      hub.remove(ws);
    });
  }

  return {
    hub,
    httpServer,
    wss,
    listener,
    async listen() {
      await listener.start((raw) => {
        const note = parseNotification(raw);
        if (note) hub.dispatch(note);
        else console.warn('[realtime] dropped malformed NOTIFY payload');
      });
      await new Promise<void>((resolve) => {
        httpServer.listen(config.port, () => {
          console.log(
            `[realtime] Laetoli Data realtime service listening on :${config.port} ` +
              `(WS /realtime, LISTEN ${config.channel})`
          );
          resolve();
        });
      });
    },
    async close() {
      await listener.stop();
      for (const client of wss.clients) {
        try {
          client.close();
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function safeUrl(url: string | undefined): { pathname: string; searchParams: URLSearchParams } {
  try {
    const u = new URL(url ?? '/', 'http://localhost');
    return { pathname: u.pathname, searchParams: u.searchParams };
  } catch {
    return { pathname: '/', searchParams: new URLSearchParams() };
  }
}

// ---- entry point ----------------------------------------------------------

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
    return;
  }

  const server = createServer({ config });
  await server.listen();

  const shutdown = (signal: string) => {
    console.log(`[realtime] ${signal} received, shutting down...`);
    server.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url.endsWith('/server.js')) {
  void main();
}
