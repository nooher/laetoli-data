import { describe, it, expect } from 'vitest';
import {
  handleSignup,
  handleMfaEnroll,
  handleMfaListFactors,
  handleMfaChallenge,
  handleMfaVerify,
  handleMfaUnenroll,
  type HandlerDeps,
} from '../handlers.js';
import { createFakeDb } from './fakeDb.js';
import { totp, base32Decode } from '../totp.js';

const SECRET = 's'.repeat(40);

function deps(): HandlerDeps {
  return { db: createFakeDb(), jwtSecret: SECRET, jwtExpiry: 3600 };
}

async function signedInUser(d: HandlerDeps) {
  const r = await handleSignup(d, { username: 'asha', password: 'siri1234' });
  const body = r.body as { access_token: string };
  return `Bearer ${body.access_token}`;
}

describe('MFA enrollment', () => {
  it('enroll returns a factor id, qr code (svg data URI), secret and otpauth uri', async () => {
    const d = deps();
    const auth = await signedInUser(d);
    const r = await handleMfaEnroll(d, auth, {});
    expect(r.status).toBe(200);
    const body = r.body as { id: string; type: string; totp: { qr_code: string; secret: string; uri: string } };
    expect(body.type).toBe('totp');
    expect(body.id).toBeTruthy();
    expect(body.totp.qr_code).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(body.totp.secret).toMatch(/^[A-Z2-7]+$/); // base32
    expect(body.totp.uri).toMatch(/^otpauth:\/\/totp\//);
  });

  it('enroll requires authentication', async () => {
    const d = deps();
    const r = await handleMfaEnroll(d, undefined, {});
    expect(r.status).toBe(401);
  });

  it('listFactors is empty before enrollment, shows unverified after enroll', async () => {
    const d = deps();
    const auth = await signedInUser(d);
    expect(((await handleMfaListFactors(d, auth)).body as { totp: unknown[] }).totp).toHaveLength(0);

    await handleMfaEnroll(d, auth, {});
    const listed = (await handleMfaListFactors(d, auth)).body as { totp: { status: string }[] };
    expect(listed.totp).toHaveLength(1);
    expect(listed.totp[0].status).toBe('unverified');
  });

  it('full enroll → challenge → verify flow marks the factor verified', async () => {
    const d = deps();
    const auth = await signedInUser(d);

    const enroll = (await handleMfaEnroll(d, auth, {})).body as {
      id: string;
      totp: { secret: string };
    };
    const secretBytes = base32Decode(enroll.totp.secret);
    const code = totp(secretBytes);

    const challenge = (await handleMfaChallenge(d, auth, enroll.id)).body as { id: string };
    expect(challenge.id).toBeTruthy();

    const verify = await handleMfaVerify(d, auth, enroll.id, {
      challenge_id: challenge.id,
      code,
    });
    expect(verify.status).toBe(200);
    expect((verify.body as { status: string }).status).toBe('verified');

    const listed = (await handleMfaListFactors(d, auth)).body as { totp: { status: string }[] };
    expect(listed.totp[0].status).toBe('verified');
  });

  it('verify rejects a wrong code', async () => {
    const d = deps();
    const auth = await signedInUser(d);
    const enroll = (await handleMfaEnroll(d, auth, {})).body as { id: string };
    const challenge = (await handleMfaChallenge(d, auth, enroll.id)).body as { id: string };

    const verify = await handleMfaVerify(d, auth, enroll.id, {
      challenge_id: challenge.id,
      code: '000000',
    });
    expect(verify.status).toBe(400);
  });

  it('verify rejects a code without a matching challenge', async () => {
    const d = deps();
    const auth = await signedInUser(d);
    const enroll = (await handleMfaEnroll(d, auth, {})).body as {
      id: string;
      totp: { secret: string };
    };
    const code = totp(base32Decode(enroll.totp.secret));

    const verify = await handleMfaVerify(d, auth, enroll.id, {
      challenge_id: 'not-a-real-challenge-id',
      code,
    });
    expect(verify.status).toBe(400);
  });

  it('a challenge cannot be reused after successful verification', async () => {
    const d = deps();
    const auth = await signedInUser(d);
    const enroll = (await handleMfaEnroll(d, auth, {})).body as {
      id: string;
      totp: { secret: string };
    };
    const secretBytes = base32Decode(enroll.totp.secret);
    const challenge = (await handleMfaChallenge(d, auth, enroll.id)).body as { id: string };

    const first = await handleMfaVerify(d, auth, enroll.id, {
      challenge_id: challenge.id,
      code: totp(secretBytes),
    });
    expect(first.status).toBe(200);

    // Same challenge, presented again — must not succeed twice.
    const replay = await handleMfaVerify(d, auth, enroll.id, {
      challenge_id: challenge.id,
      code: totp(secretBytes),
    });
    expect(replay.status).toBe(400);
  });

  it('one user cannot challenge or verify another user\'s factor', async () => {
    const d = deps();
    const authA = await signedInUser(d);
    const enrollA = (await handleMfaEnroll(d, authA, {})).body as { id: string };

    const signupB = await handleSignup(d, { username: 'juma', password: 'siri5678' });
    const authB = `Bearer ${(signupB.body as { access_token: string }).access_token}`;

    const challengeAsB = await handleMfaChallenge(d, authB, enrollA.id);
    expect(challengeAsB.status).toBe(404);
  });

  it('unenroll removes the factor', async () => {
    const d = deps();
    const auth = await signedInUser(d);
    const enroll = (await handleMfaEnroll(d, auth, {})).body as { id: string };

    const del = await handleMfaUnenroll(d, auth, enroll.id);
    expect(del.status).toBe(200);

    const listed = (await handleMfaListFactors(d, auth)).body as { totp: unknown[] };
    expect(listed.totp).toHaveLength(0);
  });

  it('unenroll requires ownership', async () => {
    const d = deps();
    const authA = await signedInUser(d);
    const enrollA = (await handleMfaEnroll(d, authA, {})).body as { id: string };

    const signupB = await handleSignup(d, { username: 'zainab', password: 'siri9999' });
    const authB = `Bearer ${(signupB.body as { access_token: string }).access_token}`;

    const del = await handleMfaUnenroll(d, authB, enrollA.id);
    expect(del.status).toBe(404);
  });
});
