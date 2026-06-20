// Delivery: real email (SMTP via injected transport) + real SMS (NextSMS via
// injected fetch). All hermetic — no network. Also asserts graceful degradation
// when SMTP/SMS are unconfigured, and that /password/forgot still returns the
// generic 200 even when the mailer throws.

import { describe, it, expect, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { createMailer, type MailTransport } from '../mailer.js';
import { createSmsSender } from '../sms.js';
import {
  handleSignup,
  handlePasswordForgot,
  handleEmailVerifyRequest,
  type HandlerDeps,
} from '../handlers.js';
import { createFakeDb } from './fakeDb.js';

const SECRET = 'd'.repeat(40);
const BASE_ENV = { JWT_SECRET: SECRET };

function deps(over?: Partial<HandlerDeps>): HandlerDeps & {
  db: ReturnType<typeof createFakeDb>;
} {
  const db = createFakeDb();
  return {
    db,
    jwtSecret: SECRET,
    jwtExpiry: 3600,
    resetExpiry: 3600,
    emailVerifyExpiry: 3600,
    ...over,
  } as HandlerDeps & { db: ReturnType<typeof createFakeDb> };
}

describe('email delivery (SMTP via injected transport)', () => {
  it('sends the reset token to the user email through the transport', async () => {
    const sent: any[] = [];
    const transport: MailTransport = {
      async sendMail(m) {
        sent.push(m);
        return { messageId: 'x' };
      },
    };
    const config = loadConfig({ ...BASE_ENV, SMTP_HOST: 'smtp.example.tz' });
    const mailer = createMailer(config, transport);

    const d = deps({ resetDelivery: 'email', mailer });
    await handleSignup(d, {
      username: 'asha',
      password: 'siri1234',
      email: 'asha@example.com',
    });
    const r = await handlePasswordForgot(d, { username: 'asha' });

    expect(r.status).toBe(200);
    expect((r.body as any).reset_token).toBeUndefined(); // not 'log' mode
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('asha@example.com');
    // A token was issued + stored (hashed) and the message carries the raw token
    // (no baseUrl → the message embeds "Tokeni / token: <value>").
    expect(d.db.resetTokens).toHaveLength(1);
    expect(sent[0].text).toMatch(/token:/i);
    expect(sent[0].subject).toMatch(/nenosiri/i);
  });

  it('builds a clickable link when baseUrl is set', async () => {
    const sent: any[] = [];
    const transport: MailTransport = {
      async sendMail(m) {
        sent.push(m);
      },
    };
    const config = loadConfig({ ...BASE_ENV, SMTP_HOST: 'smtp.example.tz' });
    const mailer = createMailer(config, transport);

    const d = deps({
      emailDelivery: 'email',
      mailer,
      baseUrl: 'https://data.example.tz',
    });
    const signup = await handleSignup(d, {
      username: 'asha',
      password: 'siri1234',
      email: 'asha@example.com',
    });
    await handleEmailVerifyRequest(d, `Bearer ${(signup.body as any).access_token}`);

    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain('https://data.example.tz/auth/email/verify/confirm?token=');
  });

  it('unconfigured SMTP degrades to no-throw (log mode)', async () => {
    const config = loadConfig({ ...BASE_ENV }); // no SMTP_HOST
    const mailer = createMailer(config); // no transport
    await expect(
      mailer.sendEmail({ to: 'x@y.tz', subject: 's', text: 't' })
    ).resolves.toBeUndefined();
  });

  it('/password/forgot still returns generic 200 when the mailer throws', async () => {
    const transport: MailTransport = {
      async sendMail() {
        throw new Error('SMTP down');
      },
    };
    const config = loadConfig({ ...BASE_ENV, SMTP_HOST: 'smtp.example.tz' });
    const mailer = createMailer(config, transport);

    const d = deps({ resetDelivery: 'email', mailer });
    await handleSignup(d, {
      username: 'asha',
      password: 'siri1234',
      email: 'asha@example.com',
    });
    const r = await handlePasswordForgot(d, { username: 'asha' });
    expect(r.status).toBe(200);
    expect((r.body as any).message).toBeTruthy();
    expect((r.body as any).reset_token).toBeUndefined();
  });
});

describe('sms delivery (NextSMS via injected fetch)', () => {
  it('POSTs the NextSMS shape with Basic auth to the single endpoint', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fakeFetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => '' } as Response;
    });
    const config = loadConfig({
      ...BASE_ENV,
      SMS_API_TOKEN: 'base64token==',
      SMS_DEFAULT_SENDER_ID: 'LAETOLI',
    });
    const sms = createSmsSender(config, fakeFetch as unknown as typeof fetch);

    await sms.sendSms({ to: '+255700000000', text: 'habari' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://messaging-service.co.tz/api/sms/v1/text/single');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Basic base64token==');
    const body = JSON.parse(calls[0].init.body);
    expect(body.from).toBe('LAETOLI');
    expect(body.to).toBe('+255700000000');
    expect(body.text).toBe('habari');
    expect(typeof body.reference).toBe('string');
  });

  it('reset delivery=sms texts the token to the user phone', async () => {
    const calls: any[] = [];
    const fakeFetch = vi.fn(async (_url: any, init: any) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => '' } as Response;
    });
    const config = loadConfig({ ...BASE_ENV, SMS_API_TOKEN: 'tok' });
    const sms = createSmsSender(config, fakeFetch as unknown as typeof fetch);

    const d = deps({ resetDelivery: 'sms', sms });
    // Seed a user WITH a phone (createUser has none, so set directly).
    await handleSignup(d, { username: 'asha', password: 'siri1234' });
    d.db.rows[0].phone = '+255711111111';

    const r = await handlePasswordForgot(d, { username: 'asha' });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe('+255711111111');
    const token = d.db.resetTokens[0].token_hash;
    expect(token).toBeTruthy(); // token was issued + stored hashed
    expect(calls[0].text.length).toBeGreaterThan(0);
  });

  it('unconfigured SMS_API_TOKEN degrades to no-throw (log mode)', async () => {
    const config = loadConfig({ ...BASE_ENV }); // no SMS_API_TOKEN
    const sms = createSmsSender(config);
    await expect(sms.sendSms({ to: '+255700000000', text: 'x' })).resolves.toBeUndefined();
  });

  it('non-2xx NextSMS response throws (caught by deliver, never crashes request)', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    })) as unknown as typeof fetch;
    const config = loadConfig({ ...BASE_ENV, SMS_API_TOKEN: 'bad' });
    const sms = createSmsSender(config, fakeFetch);
    await expect(sms.sendSms({ to: '+255700000000', text: 'x' })).rejects.toThrow(/401/);
  });
});
