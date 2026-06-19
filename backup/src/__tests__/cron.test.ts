import { describe, it, expect } from 'vitest';
import { parseCron, nextRun } from '../cron.js';

describe('parseCron', () => {
  it('parses the daily 03:00 default', () => {
    const f = parseCron('0 3 * * *');
    expect([...f.minute]).toEqual([0]);
    expect([...f.hour]).toEqual([3]);
    expect(f.domRestricted).toBe(false);
    expect(f.dowRestricted).toBe(false);
  });

  it('parses lists, ranges and steps', () => {
    const f = parseCron('0,30 9-17 * * 1-5');
    expect([...f.minute].sort((a, b) => a - b)).toEqual([0, 30]);
    expect([...f.hour].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...f.dow].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses */n steps', () => {
    const f = parseCron('*/15 * * * *');
    expect([...f.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('treats dow 7 as Sunday (0)', () => {
    const f = parseCron('0 0 * * 7');
    expect(f.dow.has(0)).toBe(true);
  });

  it('rejects wrong field counts', () => {
    expect(() => parseCron('0 3 * *')).toThrow();
    expect(() => parseCron('0 3 * * * *')).toThrow();
  });

  it('rejects out-of-range values', () => {
    expect(() => parseCron('99 3 * * *')).toThrow();
  });
});

describe('nextRun', () => {
  it('finds the next 03:00 UTC for a daily cron', () => {
    const f = parseCron('0 3 * * *');
    // from 2026-06-19 01:00Z -> same day 03:00Z
    const next = nextRun(f, new Date('2026-06-19T01:00:00Z'));
    expect(next.toISOString()).toBe('2026-06-19T03:00:00.000Z');
  });

  it('rolls to the next day when the time has passed', () => {
    const f = parseCron('0 3 * * *');
    const next = nextRun(f, new Date('2026-06-19T05:00:00Z'));
    expect(next.toISOString()).toBe('2026-06-20T03:00:00.000Z');
  });

  it('is exclusive of the current minute', () => {
    const f = parseCron('0 3 * * *');
    const next = nextRun(f, new Date('2026-06-19T03:00:00Z'));
    expect(next.toISOString()).toBe('2026-06-20T03:00:00.000Z');
  });

  it('respects every-15-minutes', () => {
    const f = parseCron('*/15 * * * *');
    const next = nextRun(f, new Date('2026-06-19T03:07:00Z'));
    expect(next.toISOString()).toBe('2026-06-19T03:15:00.000Z');
  });

  it('honours day-of-week restriction (next Monday)', () => {
    const f = parseCron('0 0 * * 1'); // Mondays at 00:00
    // 2026-06-19 is a Friday; next Monday is 2026-06-22
    const next = nextRun(f, new Date('2026-06-19T12:00:00Z'));
    expect(next.toISOString()).toBe('2026-06-22T00:00:00.000Z');
  });

  it('uses OR semantics when both DOM and DOW are restricted', () => {
    const f = parseCron('0 0 15 * 1'); // 15th OR any Monday
    // From 2026-06-19 (Fri). Next Monday = 06-22, which is earlier than the 15th
    // of next month, so Monday wins.
    const next = nextRun(f, new Date('2026-06-19T12:00:00Z'));
    expect(next.toISOString()).toBe('2026-06-22T00:00:00.000Z');
  });
});
