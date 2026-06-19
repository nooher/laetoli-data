import { vi } from 'vitest';
import { memoryStorage } from '../src/storage';
import type { ClientOptions } from '../src/types';

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockResponse {
  status?: number;
  statusText?: string;
  json?: unknown;
  text?: string;
}

/** A fetch mock that records calls and returns queued responses. */
export function makeFetch(responses: MockResponse[] = []) {
  const calls: Recorded[] = [];
  let i = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) for (const [k, v] of Object.entries(rawHeaders)) headers[k] = v;
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method: init?.method ?? 'GET', headers, body });

    const r = responses[i] ?? responses[responses.length - 1] ?? {};
    i++;
    const status = r.status ?? 200;
    const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : '');
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: r.statusText ?? '',
      text: async () => text,
    } as unknown as Response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

/** Make a base64url JWT (unsigned) with given claims for decode tests. */
export function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

export function baseOpts(fetchImpl: typeof fetch, extra: Partial<ClientOptions> = {}): ClientOptions {
  return { fetch: fetchImpl, storage: memoryStorage(), ...extra };
}

/** Parse the query string of a recorded URL into ordered entries. */
export function queryEntries(url: string): [string, string][] {
  const qs = url.split('?')[1] ?? '';
  return qs.split('&').filter(Boolean).map((p) => {
    const idx = p.indexOf('=');
    return [p.slice(0, idx), p.slice(idx + 1)] as [string, string];
  });
}
