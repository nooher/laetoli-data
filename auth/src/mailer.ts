// Real SMTP email sender (sovereign: any server the operator runs).
//
// nodemailer is a pure SMTP client — no third-party SaaS, no lock-in. The
// transport is injectable so tests never touch the network, and a missing
// SMTP_HOST degrades GRACEFULLY to a logged warning (behaves like 'log') instead
// of throwing, so a half-configured node still serves requests.

import nodemailer from 'nodemailer';
import type { AuthConfig } from './config.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** The minimal transport surface we depend on (nodemailer-compatible). */
export interface MailTransport {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
}

export interface Mailer {
  /** Send an email. Never throws on a misconfigured node — logs + no-ops. */
  sendEmail(message: EmailMessage): Promise<void>;
}

/**
 * Build a Mailer from config. If SMTP_HOST is unset we do NOT throw: we return a
 * mailer that logs a clear warning and behaves like 'log'. Pass `transport` in
 * tests to capture sends without a real SMTP server.
 */
export function createMailer(
  config: AuthConfig,
  transport?: MailTransport
): Mailer {
  const { smtp } = config;

  // Explicit injected transport (tests) — always use it.
  if (transport) {
    return {
      async sendEmail(message) {
        await transport.sendMail({ from: smtp.from, ...message });
      },
    };
  }

  // No SMTP host → graceful degradation (log mode). Never throws.
  if (!smtp.host) {
    let warned = false;
    return {
      async sendEmail(message) {
        if (!warned) {
          console.warn(
            '[auth] SMTP_HOST haijawekwa — barua pepe haitatumwa kweli ' +
              '(inafanya kazi kama "log"). Weka SMTP_* ili kutuma kwa kweli. ' +
              '(SMTP not configured; email delivery is a no-op.)'
          );
          warned = true;
        }
        console.log(`[auth] (smtp not configured) would email ${message.to}: ${message.subject}`);
      },
    };
  }

  const real: MailTransport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });

  return {
    async sendEmail(message) {
      await real.sendMail({ from: smtp.from, ...message });
    },
  };
}
