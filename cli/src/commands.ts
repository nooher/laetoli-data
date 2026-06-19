// commands.ts — command handlers. Side-effecting glue that wires the pure
// modules (env, secret, migrate-plan) to fs / docker / pg. Shelling-out is done
// through an injected Runner so the heavy commands can be tested without spawn.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fillEnv, databaseUrl, type EnvMap } from './lib/env.js';
import { generatePassword, generateJwtSecret, generateSecret } from './lib/secret.js';
import { isSqlFile, planMigrations, type MigrationFile } from './lib/migrate-plan.js';
import { dockerCommand, realRunner, type Runner } from './lib/runner.js';
import { findProjectRoot, loadEnv } from './lib/project.js';
import { openDb, type Db } from './lib/db.js';
import { flagStr, type ParsedArgs } from './lib/args.js';

export interface Ctx {
  root: string;
  runner: Runner;
  /** Factory so tests can inject a fake Db. */
  openDb: (connectionString: string) => Db;
  out: (s: string) => void;
  err: (s: string) => void;
}

export function defaultCtx(): Ctx {
  return {
    root: findProjectRoot(),
    runner: realRunner,
    openDb,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  };
}

// --- init --------------------------------------------------------------------
/** Build the values to inject into a fresh .env (fresh secrets each call). */
export function initEnvValues(): EnvMap {
  return {
    POSTGRES_PASSWORD: generatePassword(),
    JWT_SECRET: generateJwtSecret(),
    CADDY_DOMAIN: ':80',
  };
}

export async function cmdInit(ctx: Ctx): Promise<number> {
  const envPath = join(ctx.root, '.env');
  const examplePath = join(ctx.root, '.env.example');
  if (existsSync(envPath)) {
    ctx.out('Taarifa: .env tayari ipo — sitaibadilisha. (.env already exists — not overwriting.)\n');
    return 0;
  }
  if (!existsSync(examplePath)) {
    ctx.err('Hitilafu: .env.example haipatikani. (.env.example not found.)\n');
    return 1;
  }
  const template = readFileSync(examplePath, 'utf8');
  const filled = fillEnv(template, initEnvValues());
  writeFileSync(envPath, filled, 'utf8');
  ctx.out('Imeundwa .env yenye POSTGRES_PASSWORD + JWT_SECRET mpya. (.env created with fresh secrets.)\n');
  ctx.out('\nHatua zinazofuata / Next steps:\n');
  ctx.out('  laetoli-data up        # anzisha stack (docker compose up -d)\n');
  ctx.out('  laetoli-data migrate   # tumia migrations za db/migrations\n');
  ctx.out('  laetoli-data status    # angalia hali ya stack\n');
  return 0;
}

// --- docker wrappers ---------------------------------------------------------
async function compose(ctx: Ctx, args: string[], inherit = true) {
  const docker = dockerCommand();
  return ctx.runner(docker, ['compose', ...args], { cwd: ctx.root, inherit });
}

export async function cmdUp(ctx: Ctx, passthrough: string[]): Promise<number> {
  ctx.out('Inaanzisha stack… (docker compose up -d)\n');
  const r = await compose(ctx, ['up', '-d', ...passthrough]);
  return r.code;
}

export async function cmdDown(ctx: Ctx, passthrough: string[]): Promise<number> {
  ctx.out('Inasimamisha stack… (docker compose down)\n');
  const r = await compose(ctx, ['down', ...passthrough]);
  return r.code;
}

export async function cmdStatus(ctx: Ctx): Promise<number> {
  const ps = await compose(ctx, ['ps'], false);
  ctx.out(ps.stdout || ps.stderr);
  if (!ps.stdout.endsWith('\n')) ctx.out('\n');

  const env = loadEnv(ctx.root);
  const url = env.LAETOLI_DATA_URL;
  if (url) {
    ctx.out(`\nInapima afya ya ${url} … (probing health)\n`);
    try {
      const res = await fetch(url.replace(/\/$/, '') + '/rest/', { method: 'GET' });
      ctx.out(`  /rest/  -> HTTP ${res.status}\n`);
    } catch (e) {
      ctx.out(`  /rest/  -> haifikiki (unreachable): ${(e as Error).message}\n`);
    }
    try {
      const res = await fetch(url.replace(/\/$/, '') + '/auth/health', { method: 'GET' });
      ctx.out(`  /auth/health -> HTTP ${res.status}\n`);
    } catch (e) {
      ctx.out(`  /auth/health -> haifikiki (unreachable): ${(e as Error).message}\n`);
    }
  } else {
    ctx.out('\n(LAETOLI_DATA_URL haijawekwa katika .env — siwezi kupima afya.)\n');
  }
  return ps.code;
}

// --- migrate -----------------------------------------------------------------
/** Read all *.sql migration files from db/migrations (sorted later by planner). */
export function readMigrationFiles(root: string): MigrationFile[] {
  const dir = join(root, 'db', 'migrations');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(isSqlFile)
    .map((name) => ({ name, contents: readFileSync(join(dir, name), 'utf8') }));
}

export async function cmdMigrate(ctx: Ctx, statusOnly: boolean): Promise<number> {
  const env = loadEnv(ctx.root);
  const conn = databaseUrl(env);
  const files = readMigrationFiles(ctx.root);
  const db = ctx.openDb(conn);
  try {
    await db.ensureTrackingTable();
    const applied = await db.appliedMigrations();
    const plan = planMigrations(files, applied);

    if (plan.changed.length) {
      ctx.err('Hitilafu: faili za migration zilizotumika tayari zimebadilika (checksum mismatch):\n');
      for (const c of plan.changed) {
        ctx.err(`  - ${c.name}\n      ilivyokuwa: ${c.oldChecksum.slice(0, 12)}…\n      sasa:       ${c.newChecksum.slice(0, 12)}…\n`);
      }
      ctx.err('Migrations zilizotumika hazipaswi kuhaririwa. Tengeneza migration mpya badala yake.\n');
      ctx.err('(Applied migrations must not be edited — add a new migration instead.)\n');
      return 1;
    }

    if (statusOnly) {
      ctx.out(`Zilizotumika / Applied (${plan.applied.length}):\n`);
      for (const a of plan.applied) ctx.out(`  [x] ${a.name}\n`);
      ctx.out(`Zinazosubiri / Pending (${plan.pending.length}):\n`);
      for (const p of plan.pending) ctx.out(`  [ ] ${p.name}\n`);
      if (plan.missing.length) {
        ctx.out(`Zimekosekana diskini / Recorded but missing on disk (${plan.missing.length}):\n`);
        for (const m of plan.missing) ctx.out(`  [?] ${m}\n`);
      }
      return 0;
    }

    if (!plan.pending.length) {
      ctx.out('Hakuna migration mpya. Database iko sawa. (No pending migrations — up to date.)\n');
      return 0;
    }

    for (const m of plan.pending) {
      ctx.out(`Inatumia / Applying ${m.name} …\n`);
      await db.applyMigration(m);
    }
    ctx.out(`Imekamilika: ${plan.pending.length} migration zimetumika. (Done — ${plan.pending.length} applied.)\n`);
    return 0;
  } catch (e) {
    ctx.err(`Hitilafu ya migration: ${(e as Error).message}\n`);
    return 1;
  } finally {
    await db.end();
  }
}

// --- seed --------------------------------------------------------------------
export async function cmdSeed(ctx: Ctx): Promise<number> {
  const dir = join(ctx.root, 'db', 'seed');
  if (!existsSync(dir)) {
    ctx.out('Hakuna db/seed/. (No db/seed directory.)\n');
    return 0;
  }
  const files = readdirSync(dir).filter(isSqlFile).sort();
  if (!files.length) {
    ctx.out('Hakuna faili za seed (*.sql) katika db/seed/. (No seed files.)\n');
    return 0;
  }
  const env = loadEnv(ctx.root);
  const db = ctx.openDb(databaseUrl(env));
  try {
    for (const f of files) {
      ctx.out(`Inapanda / Seeding ${f} …\n`);
      await db.runSql(readFileSync(join(dir, f), 'utf8'));
    }
    ctx.out(`Imekamilika: ${files.length} faili za seed. (Done — ${files.length} seed files.)\n`);
    return 0;
  } catch (e) {
    ctx.err(`Hitilafu ya seed: ${(e as Error).message}\n`);
    return 1;
  } finally {
    await db.end();
  }
}

// --- backup ------------------------------------------------------------------
/** Build a timestamped default backup filename. */
export function backupFilename(db: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `${db}_${stamp}.sql`;
}

export async function cmdBackup(ctx: Ctx, outFlag?: string): Promise<number> {
  const env = loadEnv(ctx.root);
  const user = env.POSTGRES_USER || 'laetoli';
  const dbName = env.POSTGRES_DB || 'laetoli';
  const backupsDir = join(ctx.root, 'backups');
  if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });
  const outPath = outFlag || join(backupsDir, backupFilename(dbName));

  // Prefer `docker compose exec` so this works without local Postgres tooling.
  const docker = dockerCommand();
  ctx.out(`Inahifadhi / Backing up ${dbName} -> ${outPath}\n`);
  const r = await ctx.runner(
    docker,
    ['compose', 'exec', '-T', 'db', 'pg_dump', '-U', user, '-d', dbName, '--clean', '--if-exists'],
    { cwd: ctx.root, inherit: false },
  );
  if (r.code !== 0) {
    ctx.err(`Hitilafu ya pg_dump (code ${r.code}): ${r.stderr}\n`);
    return r.code || 1;
  }
  writeFileSync(outPath, r.stdout, 'utf8');
  ctx.out(`Imehifadhiwa: ${outPath}\n`);
  return 0;
}

// --- restore -----------------------------------------------------------------
export async function cmdRestore(ctx: Ctx, file: string | undefined, force: boolean): Promise<number> {
  if (!file) {
    ctx.err('Hitilafu: taja faili la kurejesha. Mfano: laetoli-data restore backups/x.sql\n');
    return 1;
  }
  const path = join(ctx.root, file);
  const resolved = existsSync(file) ? file : existsSync(path) ? path : undefined;
  if (!resolved) {
    ctx.err(`Hitilafu: faili "${file}" halipatikani. (file not found)\n`);
    return 1;
  }
  if (!force) {
    ctx.err('Onyo: kurejesha kutaandika juu ya data iliyopo. Tumia --force kuthibitisha.\n');
    ctx.err('(Restore overwrites existing data — pass --force to confirm.)\n');
    return 1;
  }
  const env = loadEnv(ctx.root);
  const user = env.POSTGRES_USER || 'laetoli';
  const dbName = env.POSTGRES_DB || 'laetoli';
  const docker = dockerCommand();
  const sql = readFileSync(resolved, 'utf8');
  ctx.out(`Inarejesha / Restoring ${resolved} -> ${dbName}\n`);
  const r = await ctx.runner(
    docker,
    ['compose', 'exec', '-T', 'db', 'psql', '-U', user, '-d', dbName],
    { cwd: ctx.root, inherit: false, input: sql },
  );
  if (r.code !== 0) {
    ctx.err(`Hitilafu ya restore (code ${r.code}): ${r.stderr}\n`);
    return r.code || 1;
  }
  ctx.out('Imerejeshwa. (Restored.)\n');
  return 0;
}

// --- secret ------------------------------------------------------------------
export function cmdSecret(ctx: Ctx, args: ParsedArgs): number {
  const bytesStr = flagStr(args, 'bytes');
  const bytes = bytesStr ? Math.max(8, parseInt(bytesStr, 10) || 24) : 32;
  ctx.out(generateSecret(bytes) + '\n');
  return 0;
}
