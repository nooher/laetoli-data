#!/usr/bin/env node
// =============================================================================
// laetoli-data — the Laetoli Data command-line tool. Operate the sovereign
// backend stack (docker), run repeatable DB migrations, seed, back up & restore
// — without memorizing docker/psql. Zero heavy deps, hand-rolled arg parsing,
// Kiswahili-aware help (Laetoli: Kiswahili kwanza).
//
//   laetoli-data <amri> [chaguo]
// =============================================================================
import { parseArgs, flagStr, hasFlag } from './lib/args.js';
import {
  defaultCtx,
  cmdInit,
  cmdUp,
  cmdDown,
  cmdStatus,
  cmdMigrate,
  cmdSeed,
  cmdBackup,
  cmdRestore,
  cmdSecret,
} from './commands.js';

const TOLEO = '@laetoli/data-cli 0.1.0';

const MSAADA = `Laetoli Data — chombo cha mstari wa amri (sovereign backend CLI)

Matumizi / Usage:
  laetoli-data <amri> [chaguo]

Amri / Commands:
  init                 Tengeneza .env kutoka .env.example na ujaze siri mpya
                       (POSTGRES_PASSWORD + JWT_SECRET, CADDY_DOMAIN=:80).
                       Haibadilishi .env iliyopo. (scaffold .env with fresh secrets)
  up [-- ...]          Anzisha stack: docker compose up -d. (start the stack)
  down [-- ...]        Simamisha stack: docker compose down. (-- -v to wipe data)
  status               Onyesha hali ya container + pima afya ya URL. (status + health)
  migrate              Tumia migrations zinazosubiri (db/migrations/*.sql),
                       kila moja ndani ya muamala, ikifuatilia _laetoli_migrations.
  migrate --status     Orodhesha zilizotumika / zinazosubiri. (list applied/pending)
  seed                 Endesha db/seed/*.sql kama zipo. (run seeds)
  backup [--out FILE]  pg_dump kupitia docker -> backups/ (au --out FILE).
  restore <FILE>       Rejesha dump (inahitaji --force kuthibitisha).
  secret [--bytes N]   Chapisha siri imara mpya. (print a strong secret)
  msaada | --help      Onyesha ujumbe huu. (show this help)
  --toleo | -v         Onyesha toleo. (show version)

Mifano / Examples:
  laetoli-data init
  laetoli-data up
  laetoli-data migrate --status
  laetoli-data backup --out backups/leo.sql
  laetoli-data down -- -v
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const amri = argv[0];
  const rest = argv.slice(1);

  if (!amri || amri === 'msaada' || amri === '--msaada' || amri === '-h' || amri === '--help') {
    process.stdout.write(MSAADA);
    return 0;
  }
  if (amri === '--toleo' || amri === '-v' || amri === 'toleo') {
    process.stdout.write(TOLEO + '\n');
    return 0;
  }

  const ctx = defaultCtx();

  switch (amri) {
    case 'init':
      return cmdInit(ctx);
    case 'up': {
      const args = parseArgs(rest);
      return cmdUp(ctx, args.passthrough);
    }
    case 'down': {
      const args = parseArgs(rest);
      return cmdDown(ctx, args.passthrough);
    }
    case 'status':
      return cmdStatus(ctx);
    case 'migrate': {
      const args = parseArgs(rest);
      return cmdMigrate(ctx, hasFlag(args, 'status'));
    }
    case 'seed':
      return cmdSeed(ctx);
    case 'backup': {
      const args = parseArgs(rest, ['out']);
      return cmdBackup(ctx, flagStr(args, 'out'));
    }
    case 'restore': {
      const args = parseArgs(rest, []);
      return cmdRestore(ctx, args.positionals[0], hasFlag(args, 'force'));
    }
    case 'secret': {
      const args = parseArgs(rest, ['bytes']);
      return cmdSecret(ctx, args);
    }
    default:
      process.stderr.write(`Hitilafu: amri "${amri}" haijulikani. Jaribu "laetoli-data msaada".\n`);
      process.stderr.write(`(Unknown command "${amri}" — try "laetoli-data msaada".)\n`);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`Hitilafu isiyotarajiwa: ${(e as Error).stack || (e as Error).message}\n`);
    process.exit(1);
  });
