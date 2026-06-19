import { describe, it, expect } from 'vitest';
import { parseCron, nextRun } from './cron.js';

// Smoke tests for the vendored cron module (exhaustive coverage lives in
// backup/). These assert the behaviour the scheduler relies on.

describe('parseCron', () => {
  it('parses a 5-field expression', () => {
    const f = parseCron('*/5 * * * *');
    expect(f.minute.has(0)).toBe(true);
    expect(f.minute.has(5)).toBe(true);
    expect(f.minute.has(3)).toBe(false);
  });
  it('rejects a non-5-field expression', () => {
    expect(() => parseCron('* * *')).toThrow();
  });
  it('treats dow 7 as Sunday (0)', () => {
    const f = parseCron('0 0 * * 7');
    expect(f.dow.has(0)).toBe(true);
  });
});

describe('nextRun', () => {
  it('finds the next matching minute strictly after from (UTC)', () => {
    const f = parseCron('0 2 * * *');
    expect(nextRun(f, new Date('2026-06-19T12:00:00Z')).toISOString()).toBe(
      '2026-06-20T02:00:00.000Z'
    );
  });
  it('handles step minutes', () => {
    const f = parseCron('*/15 * * * *');
    expect(nextRun(f, new Date('2026-06-19T12:01:00Z')).toISOString()).toBe(
      '2026-06-19T12:15:00.000Z'
    );
  });
});
