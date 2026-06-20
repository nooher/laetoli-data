// Phone-OTP (sovereign passwordless login over SMS). Hermetic — fake Db only.

import { describe, it, expect, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { createSmsSender } from '../sms.js';
import { handleOtpRequest, handleOtpVerify, type HandlerDeps } from '../handlers.js';
import { createFakeDb } from './fakeDb.js';
import { hashToken } from '../tokens.js';

const SECRET = 'o'.repeat(40);

function deps(over?: Partial<HandlerDeps>): HandlerDeps & {
  db: ReturnType<typeof createFakeDb>;
} {
  const db = createFakeDb();
  return {
    db,
    jwtSecret: SECRET,
    jwtExpiry: 3600,
    otpExpiry: 300,
    otpMaxAttempts: 5,
    ...over,
  } as HandlerDeps & { db: ReturnType<typeof createFakeDb> };
}

describe('OTP request', () => {
  it('log mode (no sms sender) returns the code + stores it HASHED (not plaintext)', async () => {
    const d = deps();
    const r = await handleOtpRequest(d, { phone: '0700000000' });
    expect(r.status).toBe(200);
    const code = (r.body as any).code as string;
    expect(code).toMatch(/^\d{6}$/);

    // Stored row keeps only the hash; never the plaintext code.
    expect(d.db.otpCodes).toHaveLength(1);
    const row = d.db.otpCodes[0];
    expect(row.code_hash).not.toBe(code);
    expect(row.code_hash).toBe(hashToken(code));
    // Phone normalized to +255 form; a phone user was created.
    expect(row.phone).toBe('+255700000000');
    expect(d.db.rows[0].phone).toBe('+255700000000');
  });

  it('sms mode texts the code and does NOT return it', async () => {
    const calls: any[] = [];
    const fakeFetch = vi.fn(async (_url: any, init: any) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => '' } as Response;
    });
    const config = loadConfig({ JWT_SECRET: SECRET, SMS_API_TOKEN: 'tok' });
    const sms = createSmsSender(config, fakeFetch as unknown as typeof fetch);

    const d = deps({ sms });
    const r = await handleOtpRequest(d, { phone: '+255711222333' });
    expect(r.status).toBe(200);
    expect((r.body as any).code).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe('+255711222333');
    expect(calls[0].text).toMatch(/\d{6}/);
  });

  it('invalid phone → 400', async () => {
    const d = deps();
    expect((await handleOtpRequest(d, { phone: 'abc' })).status).toBe(400);
    expect((await handleOtpRequest(d, {})).status).toBe(400);
  });

  it('generic 200 even when SMS delivery throws (no crash, no enumeration)', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'boom',
    })) as unknown as typeof fetch;
    const config = loadConfig({ JWT_SECRET: SECRET, SMS_API_TOKEN: 'tok' });
    const sms = createSmsSender(config, fakeFetch);
    const d = deps({ sms });
    const r = await handleOtpRequest(d, { phone: '0722000000' });
    expect(r.status).toBe(200);
    expect((r.body as any).code).toBeUndefined();
  });
});

describe('OTP verify', () => {
  it('correct code issues access + refresh tokens', async () => {
    const d = deps();
    const code = (await handleOtpRequest(d, { phone: '0700000000' }).then(
      (r) => (r.body as any).code
    )) as string;

    const r = await handleOtpVerify(d, { phone: '0700000000', code });
    expect(r.status).toBe(200);
    const b = r.body as any;
    expect(b.access_token).toBeTruthy();
    expect(b.refresh_token).toBeTruthy();
    expect(b.token_type).toBe('bearer');
    expect(b.user.phone).toBe('+255700000000');
    // Code is consumed (single-use).
    expect(d.db.otpCodes[0].used_at).toBeTruthy();
  });

  it('wrong code → 400 and increments attempts', async () => {
    const d = deps();
    await handleOtpRequest(d, { phone: '0700000000' });
    const r = await handleOtpVerify(d, { phone: '0700000000', code: '000000' });
    expect(r.status).toBe(400);
    expect(d.db.otpCodes[0].attempts).toBe(1);
  });

  it('rejects after too many attempts even with the right code', async () => {
    const d = deps({ otpMaxAttempts: 2 });
    const code = (await handleOtpRequest(d, { phone: '0700000000' }).then(
      (r) => (r.body as any).code
    )) as string;

    await handleOtpVerify(d, { phone: '0700000000', code: '111111' }); // 1 wrong
    await handleOtpVerify(d, { phone: '0700000000', code: '222222' }); // 2 wrong → now at max
    const r = await handleOtpVerify(d, { phone: '0700000000', code }); // right, but locked
    expect(r.status).toBe(400);
  });

  it('expired code → 400', async () => {
    const d = deps({ otpExpiry: -10 }); // already expired on issue
    const code = (await handleOtpRequest(d, { phone: '0700000000' }).then(
      (r) => (r.body as any).code
    )) as string;
    const r = await handleOtpVerify(d, { phone: '0700000000', code });
    expect(r.status).toBe(400);
  });

  it('used code cannot be reused', async () => {
    const d = deps();
    const code = (await handleOtpRequest(d, { phone: '0700000000' }).then(
      (r) => (r.body as any).code
    )) as string;
    expect((await handleOtpVerify(d, { phone: '0700000000', code })).status).toBe(200);
    expect((await handleOtpVerify(d, { phone: '0700000000', code })).status).toBe(400);
  });

  it('missing/empty code → 400', async () => {
    const d = deps();
    await handleOtpRequest(d, { phone: '0700000000' });
    expect((await handleOtpVerify(d, { phone: '0700000000', code: '' })).status).toBe(400);
    expect((await handleOtpVerify(d, { phone: '0700000000' })).status).toBe(400);
  });
});
