import { describe, it, expect } from 'vitest';
import { constantTimeEqual, extractKey } from '../auth.js';
import type { Request } from 'express';

function fakeReq(headers: Record<string, string>): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    header(name: string) {
      return lower[name.toLowerCase()];
    },
  } as unknown as Request;
}

describe('constantTimeEqual', () => {
  it('true for equal strings', () => {
    expect(constantTimeEqual('abc123', 'abc123')).toBe(true);
  });
  it('false for different same-length strings', () => {
    expect(constantTimeEqual('abc123', 'abc124')).toBe(false);
  });
  it('false (no throw) for different-length strings', () => {
    expect(constantTimeEqual('short', 'muchlongerkey')).toBe(false);
  });
});

describe('extractKey', () => {
  it('reads Authorization: Bearer', () => {
    expect(extractKey(fakeReq({ authorization: 'Bearer secret-key' }))).toBe('secret-key');
  });
  it('reads x-admin-key', () => {
    expect(extractKey(fakeReq({ 'x-admin-key': 'secret-key' }))).toBe('secret-key');
  });
  it('returns null when neither present', () => {
    expect(extractKey(fakeReq({}))).toBeNull();
  });
});
