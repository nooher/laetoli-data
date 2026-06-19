import { describe, it, expect } from 'vitest';
import { parseArgs, flagStr, hasFlag } from '../lib/args.js';

describe('parseArgs', () => {
  it('collects positionals', () => {
    const a = parseArgs(['foo', 'bar']);
    expect(a.positionals).toEqual(['foo', 'bar']);
  });

  it('treats unknown --flags as boolean', () => {
    const a = parseArgs(['--force', '--status']);
    expect(a.flags.force).toBe(true);
    expect(a.flags.status).toBe(true);
  });

  it('consumes a value for declared value-flags', () => {
    const a = parseArgs(['--out', 'backups/x.sql'], ['out']);
    expect(a.flags.out).toBe('backups/x.sql');
    expect(a.positionals).toEqual([]);
  });

  it('supports --key=value form', () => {
    const a = parseArgs(['--out=foo.sql']);
    expect(a.flags.out).toBe('foo.sql');
  });

  it('collects passthrough after --', () => {
    const a = parseArgs(['up', '--', '-v', '--build']);
    expect(a.positionals).toEqual(['up']);
    expect(a.passthrough).toEqual(['-v', '--build']);
  });

  it('flagStr coerces and hasFlag detects presence', () => {
    const a = parseArgs(['--status'], []);
    expect(hasFlag(a, 'status')).toBe(true);
    expect(hasFlag(a, 'nope')).toBe(false);
    expect(flagStr(a, 'status')).toBe(''); // boolean -> ''
    expect(flagStr(a, 'missing')).toBeUndefined();
  });
});
