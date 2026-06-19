// project.ts — locate the Laetoli Data project root and read its .env. The CLI
// may be invoked from anywhere (global bin) or from within the repo; walk up
// from cwd looking for docker-compose.yml, falling back to cwd.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv, type EnvMap } from './env.js';

/** Walk up from `start` until a docker-compose.yml is found; else return start. */
export function findProjectRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'docker-compose.yml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start);
}

/** Load and parse the project's .env (empty map if absent). */
export function loadEnv(root: string): EnvMap {
  const p = join(root, '.env');
  if (!existsSync(p)) return {};
  return parseEnv(readFileSync(p, 'utf8'));
}
