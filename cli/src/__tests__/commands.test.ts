import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cmdInit,
  cmdMigrate,
  cmdBackup,
  cmdRestore,
  cmdSecret,
  backupFilename,
  initEnvValues,
  type Ctx,
} from '../commands.js';
import { parseArgs } from '../lib/args.js';
import { checksum, type PlannedMigration } from '../lib/migrate-plan.js';
import type { Db } from '../lib/db.js';
import type { RunResult } from '../lib/runner.js';

let root: string;
let outBuf: string;
let errBuf: string;

// A fake in-memory Db so migrate/seed tests never touch Postgres.
class FakeDb implements Db {
  applied: { name: string; checksum: string }[] = [];
  ensured = false;
  constructor(seed: { name: string; checksum: string }[] = []) {
    this.applied = [...seed];
  }
  async ensureTrackingTable() {
    this.ensured = true;
  }
  async appliedMigrations() {
    return this.applied;
  }
  async applyMigration(m: PlannedMigration) {
    this.applied.push({ name: m.name, checksum: m.checksum });
  }
  async runSql() {}
  async end() {}
}

function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    root,
    runner: async (): Promise<RunResult> => ({ code: 0, stdout: '', stderr: '' }),
    openDb: () => new FakeDb(),
    out: (s) => (outBuf += s),
    err: (s) => (errBuf += s),
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ld-cli-'));
  outBuf = '';
  errBuf = '';
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('cmdInit', () => {
  it('creates .env from .env.example with fresh secrets', async () => {
    writeFileSync(join(root, '.env.example'), 'POSTGRES_PASSWORD=\nJWT_SECRET=\nCADDY_DOMAIN=\n');
    const code = await cmdInit(makeCtx());
    expect(code).toBe(0);
    const env = readFileSync(join(root, '.env'), 'utf8');
    expect(env).toMatch(/POSTGRES_PASSWORD=.+/);
    expect(env).toMatch(/JWT_SECRET=.+/);
    expect(env).toContain('CADDY_DOMAIN=:80');
  });

  it('never overwrites an existing .env', async () => {
    writeFileSync(join(root, '.env.example'), 'POSTGRES_PASSWORD=\n');
    writeFileSync(join(root, '.env'), 'POSTGRES_PASSWORD=keepme\n');
    const code = await cmdInit(makeCtx());
    expect(code).toBe(0);
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain('keepme');
    expect(outBuf.toLowerCase()).toContain('already exists');
  });

  it('initEnvValues yields all three keys with values', () => {
    const v = initEnvValues();
    expect(v.POSTGRES_PASSWORD).toBeTruthy();
    expect(v.JWT_SECRET).toBeTruthy();
    expect(v.CADDY_DOMAIN).toBe(':80');
  });
});

describe('cmdMigrate', () => {
  function seedMigrations() {
    const dir = join(root, 'db', 'migrations');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a();');
    writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b();');
    writeFileSync(join(dir, 'README.md'), 'not a migration');
    writeFileSync(join(root, '.env'), 'POSTGRES_PASSWORD=pw\n');
  }

  it('applies all pending migrations', async () => {
    seedMigrations();
    const fake = new FakeDb();
    const code = await cmdMigrate(makeCtx({ openDb: () => fake }), false);
    expect(code).toBe(0);
    expect(fake.applied.map((a) => a.name)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(outBuf).toContain('2 applied');
  });

  it('--status lists applied + pending without applying', async () => {
    seedMigrations();
    const fake = new FakeDb([{ name: '0001_a.sql', checksum: checksum('CREATE TABLE a();') }]);
    const code = await cmdMigrate(makeCtx({ openDb: () => fake }), true);
    expect(code).toBe(0);
    expect(outBuf).toContain('[x] 0001_a.sql');
    expect(outBuf).toContain('[ ] 0002_b.sql');
    expect(fake.applied).toHaveLength(1); // unchanged
  });

  it('refuses when an applied migration checksum changed', async () => {
    seedMigrations();
    const fake = new FakeDb([{ name: '0001_a.sql', checksum: checksum('DIFFERENT') }]);
    const code = await cmdMigrate(makeCtx({ openDb: () => fake }), false);
    expect(code).toBe(1);
    expect(errBuf.toLowerCase()).toContain('checksum');
    expect(fake.applied).toHaveLength(1); // nothing new applied
  });

  it('reports up-to-date when nothing pending', async () => {
    seedMigrations();
    const fake = new FakeDb([
      { name: '0001_a.sql', checksum: checksum('CREATE TABLE a();') },
      { name: '0002_b.sql', checksum: checksum('CREATE TABLE b();') },
    ]);
    const code = await cmdMigrate(makeCtx({ openDb: () => fake }), false);
    expect(code).toBe(0);
    expect(outBuf.toLowerCase()).toContain('up to date');
  });
});

describe('cmdBackup', () => {
  it('writes pg_dump stdout to a timestamped file via docker exec', async () => {
    writeFileSync(join(root, '.env'), 'POSTGRES_USER=laetoli\nPOSTGRES_DB=laetoli\n');
    let calledArgs: string[] = [];
    const ctx = makeCtx({
      runner: async (_cmd, args) => {
        calledArgs = args;
        return { code: 0, stdout: '-- dump contents --', stderr: '' };
      },
    });
    const code = await cmdBackup(ctx, undefined);
    expect(code).toBe(0);
    expect(calledArgs).toContain('pg_dump');
    expect(calledArgs).toContain('compose');
    expect(existsSync(join(root, 'backups'))).toBe(true);
    expect(outBuf).toContain('Imehifadhiwa');
  });

  it('respects --out', async () => {
    writeFileSync(join(root, '.env'), 'POSTGRES_DB=laetoli\n');
    const out = join(root, 'custom.sql');
    const ctx = makeCtx({
      runner: async () => ({ code: 0, stdout: 'DUMP', stderr: '' }),
    });
    await cmdBackup(ctx, out);
    expect(readFileSync(out, 'utf8')).toBe('DUMP');
  });
});

describe('backupFilename', () => {
  it('is timestamped and filesystem-safe', () => {
    const name = backupFilename('laetoli', new Date('2026-06-19T12:34:56Z'));
    expect(name).toBe('laetoli_2026-06-19_12-34-56.sql');
  });
});

describe('cmdRestore', () => {
  it('refuses without --force', async () => {
    const file = join(root, 'dump.sql');
    writeFileSync(file, 'SELECT 1;');
    writeFileSync(join(root, '.env'), 'POSTGRES_DB=laetoli\n');
    const code = await cmdRestore(makeCtx(), file, false);
    expect(code).toBe(1);
    expect(errBuf.toLowerCase()).toContain('--force');
  });

  it('restores with --force, piping the dump to psql stdin', async () => {
    const file = join(root, 'dump.sql');
    writeFileSync(file, 'SELECT 1;');
    writeFileSync(join(root, '.env'), 'POSTGRES_DB=laetoli\n');
    let input: string | undefined;
    let args: string[] = [];
    const ctx = makeCtx({
      runner: async (_cmd, a, opts) => {
        args = a;
        input = opts?.input;
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const code = await cmdRestore(ctx, file, true);
    expect(code).toBe(0);
    expect(args).toContain('psql');
    expect(input).toBe('SELECT 1;');
  });

  it('errors on missing file', async () => {
    const code = await cmdRestore(makeCtx(), join(root, 'nope.sql'), true);
    expect(code).toBe(1);
    expect(errBuf.toLowerCase()).toContain('not found');
  });
});

describe('cmdSecret', () => {
  it('prints a secret', () => {
    const ctx = makeCtx();
    const code = cmdSecret(ctx, parseArgs([], ['bytes']));
    expect(code).toBe(0);
    expect(outBuf.trim()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
