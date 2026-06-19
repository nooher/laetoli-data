import { describe, it, expect, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { WebSocket, type AddressInfo } from 'ws';
import { createServer, type RealtimeServer } from '../server.js';
import { FakeListener } from '../listener.js';
import type { RealtimeConfig } from '../config.js';

const SECRET = 'a'.repeat(40);

const config: RealtimeConfig = {
  jwtSecret: SECRET,
  port: 0, // ephemeral
  channel: 'laetoli_realtime',
  authGraceMs: 150, // keep the no-token rejection test fast

  pg: { host: 'db', port: 5432, user: 'laetoli_realtime', password: '', database: 'laetoli' },
};

function token(sub = 'u1'): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ sub, role: 'authenticated', iat: now, exp: now + 3600 }, SECRET, { algorithm: 'HS256' });
}

let srv: RealtimeServer | null = null;
let fake: FakeListener;

async function boot(): Promise<{ url: string }> {
  fake = new FakeListener();
  srv = createServer({ config, listener: fake });
  await srv.listen();
  const port = (srv.httpServer.address() as AddressInfo).port;
  return { url: `ws://127.0.0.1:${port}/realtime` };
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (d) => resolve(JSON.parse(d.toString())));
  });
}

function nextClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

afterEach(async () => {
  if (srv) await srv.close();
  srv = null;
});

describe('realtime server (WS)', () => {
  it('rejects a connection with no token (close 4401)', async () => {
    const { url } = await boot();
    const ws = await open(url);
    const code = await nextClose(ws);
    expect(code).toBe(4401);
  });

  it('rejects an invalid token (close 4401)', async () => {
    const { url } = await boot();
    const ws = await open(`${url}?token=garbage`);
    const code = await nextClose(ws);
    expect(code).toBe(4401);
  });

  it('accepts ?token=, subscribes, and receives a NOTIFY fan-out', async () => {
    const { url } = await boot();
    const ws = await open(`${url}?token=${token()}`);
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'notes', event: '*' }));
    const ack = await nextMessage(ws);
    expect(ack).toEqual({ type: 'subscribed', channel: 'notes' });

    const got = nextMessage(ws);
    fake.emit(
      JSON.stringify({ schema: 'public', table: 'notes', type: 'INSERT', record: { id: '1', body: 'hi' }, old: null }),
    );
    const change = await got;
    expect(change.type).toBe('change');
    expect(change.event).toBe('INSERT');
    expect((change.record as Record<string, unknown>).id).toBe('1');
    ws.close();
  });

  it('supports auth via a first {type:auth} message', async () => {
    const { url } = await boot();
    const ws = await open(url); // no ?token=
    ws.send(JSON.stringify({ type: 'auth', token: token() }));
    const authed = await nextMessage(ws);
    expect(authed).toEqual({ type: 'authenticated' });
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    const ack = await nextMessage(ws);
    expect(ack.type).toBe('subscribed');
    ws.close();
  });

  it('GET /health reports listening state', async () => {
    await boot();
    const port = (srv!.httpServer.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('laetoli-realtime');
    expect(body.listening).toBe(true);
  });
});
