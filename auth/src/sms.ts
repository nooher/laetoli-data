// NextSMS / messaging-service.co.tz sender (sovereign: the operator's OWN
// account, configured via env — no third-party SaaS SDK). Mirrors the exact
// contract CargoLink uses:
//   POST `${SMS_API_URL}/api/sms/v1/text/single`
//   header  Authorization: Basic ${SMS_API_TOKEN}
//   JSON    { from, to, text, reference }
//
// Uses the global `fetch` (Node 18+); no axios. The fetch implementation is
// injectable so tests assert the request shape without hitting the network. A
// missing SMS_API_TOKEN degrades to a logged no-op (behaves like 'log').

import { randomUUID } from 'node:crypto';
import type { AuthConfig } from './config.js';

export interface SmsMessage {
  to: string;
  text: string;
  /** Override the configured default sender id. */
  senderId?: string;
  /** Idempotency/tracking reference; one is generated when omitted. */
  reference?: string;
}

export interface SmsSender {
  /** Send an SMS. Never throws on a missing token — logs + no-ops. */
  sendSms(message: SmsMessage): Promise<void>;
}

type FetchFn = typeof fetch;

/**
 * Build an SmsSender from config. When SMS_API_TOKEN is unset we do NOT throw:
 * we warn once and no-op (log mode). Pass `fetchImpl` in tests to capture the
 * outgoing request.
 */
export function createSmsSender(
  config: AuthConfig,
  fetchImpl?: FetchFn
): SmsSender {
  const { sms } = config;
  const doFetch = fetchImpl ?? fetch;

  if (!sms.apiToken) {
    let warned = false;
    return {
      async sendSms(message) {
        if (!warned) {
          console.warn(
            '[auth] SMS_API_TOKEN haijawekwa — SMS haitatumwa kweli ' +
              '(inafanya kazi kama "log"). Weka SMS_API_TOKEN (akaunti yako ya ' +
              'NextSMS) ili kutuma kwa kweli. (SMS not configured; delivery is a no-op.)'
          );
          warned = true;
        }
        console.log(`[auth] (sms not configured) would text ${message.to}`);
      },
    };
  }

  const endpoint = `${sms.apiUrl}/api/sms/v1/text/single`;

  return {
    async sendSms(message) {
      const body = {
        from: message.senderId ?? sms.defaultSenderId,
        to: message.to,
        text: message.text,
        reference: message.reference ?? `LD-${Date.now()}-${randomUUID().slice(0, 8)}`,
      };
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${sms.apiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // Surface a concise error; the caller (deliver) catches + logs it so the
        // request never crashes.
        const detail = await res.text().catch(() => '');
        throw new Error(`NextSMS HTTP ${res.status}: ${detail.slice(0, 200)}`);
      }
    },
  };
}
