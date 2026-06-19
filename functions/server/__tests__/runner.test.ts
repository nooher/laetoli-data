import { describe, it, expect } from 'vitest';
import { runHandler, normalize, FunctionTimeoutError } from '../runner.js';
import type { FunctionContext } from '../types.js';

function ctx(over: Partial<FunctionContext> = {}): Omit<FunctionContext, 'signal'> {
  return {
    method: 'GET',
    headers: {},
    query: {},
    body: undefined,
    env: {},
    user: null,
    path: '',
    ...over,
  };
}

describe('normalize', () => {
  it('wraps a bare JSON value as 200', () => {
    expect(normalize({ a: 1 })).toEqual({ status: 200, headers: {}, body: { a: 1 } });
    expect(normalize('hi')).toEqual({ status: 200, headers: {}, body: 'hi' });
    expect(normalize([1, 2])).toEqual({ status: 200, headers: {}, body: [1, 2] });
  });

  it('passes a Response-like envelope through with defaults', () => {
    expect(normalize({ body: { ok: true } })).toEqual({ status: 200, headers: {}, body: { ok: true } });
    expect(normalize({ status: 201, headers: { 'X-A': 'b' }, body: 'x' })).toEqual({
      status: 201,
      headers: { 'X-A': 'b' },
      body: 'x',
    });
  });

  it('maps undefined to 204', () => {
    expect(normalize(undefined)).toEqual({ status: 204, headers: {}, body: undefined });
  });
});

describe('runHandler', () => {
  it('runs an async handler and normalizes its result', async () => {
    const out = await runHandler(async () => ({ message: 'hi' }), ctx(), { timeoutMs: 1000 });
    expect(out).toEqual({ status: 200, headers: {}, body: { message: 'hi' } });
  });

  it('passes the ctx (incl. user + signal) through', async () => {
    const out = await runHandler(
      async (c) => ({ user: c.user, hasSignal: typeof c.signal?.aborted === 'boolean' }),
      ctx({ user: { sub: 'u1', role: 'authenticated' } }),
      { timeoutMs: 1000 }
    );
    expect(out.body).toEqual({ user: { sub: 'u1', role: 'authenticated' }, hasSignal: true });
  });

  it('rejects with FunctionTimeoutError past the deadline', async () => {
    const slow = () => new Promise<never>(() => {}); // never resolves
    await expect(runHandler(slow, ctx(), { timeoutMs: 20 })).rejects.toBeInstanceOf(
      FunctionTimeoutError
    );
  });

  it('aborts ctx.signal when the timeout fires', async () => {
    let aborted = false;
    const handler = (c: FunctionContext) =>
      new Promise<never>((_, reject) => {
        c.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    await expect(runHandler(handler, ctx(), { timeoutMs: 20 })).rejects.toBeTruthy();
    expect(aborted).toBe(true);
  });

  it('propagates a handler error', async () => {
    await expect(
      runHandler(async () => {
        throw new Error('boom');
      }, ctx(), { timeoutMs: 1000 })
    ).rejects.toThrow('boom');
  });
});
