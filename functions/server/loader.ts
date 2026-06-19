// Resolves a function name to a module on disk, dynamically imports it, and
// caches the result. Pure/injectable: the filesystem + importer are passed in
// so tests can drive it with temp files or fakes.
//
// Layout supported under the functions root:
//   <root>/<name>.ts       <root>/<name>.js       <root>/<name>.mjs
//   <root>/<name>/index.ts <root>/<name>/index.js <root>/<name>/index.mjs
//
// Name safety: a request name is a single path segment matching [A-Za-z0-9_-].
// This blocks "../" traversal and nested paths from reaching the importer.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FunctionHandler, LoadedFunction } from './types.js';

const VALID_NAME = /^[A-Za-z0-9_-]+$/;
const CANDIDATE_EXTS = ['.ts', '.js', '.mjs', '.cjs'];

export interface LoaderDeps {
  root: string;
  /** fs facade — defaults to node:fs (sync). Injectable for tests. */
  fileSystem?: Pick<typeof fs, 'existsSync' | 'readdirSync' | 'statSync'>;
  /** Dynamic importer — defaults to native import(). Injectable for tests. */
  importer?: (specifier: string) => Promise<unknown>;
}

export class FunctionNotFoundError extends Error {
  constructor(public readonly name: string) {
    super(`Function not found: ${name}`);
    this.name = 'FunctionNotFoundError';
  }
}

export class InvalidFunctionError extends Error {
  constructor(public readonly name: string, reason: string) {
    super(`Invalid function "${name}": ${reason}`);
    this.name = 'InvalidFunctionError';
  }
}

export function isValidName(name: string): boolean {
  return VALID_NAME.test(name);
}

/** Resolve the on-disk file path for a function name, or null if none exists. */
export function resolveFunctionFile(
  root: string,
  name: string,
  fileSystem: Pick<typeof fs, 'existsSync'> = fs
): string | null {
  if (!isValidName(name)) return null;
  // <root>/<name>.<ext>
  for (const ext of CANDIDATE_EXTS) {
    const p = path.join(root, `${name}${ext}`);
    if (fileSystem.existsSync(p)) return p;
  }
  // <root>/<name>/index.<ext>
  for (const ext of CANDIDATE_EXTS) {
    const p = path.join(root, name, `index${ext}`);
    if (fileSystem.existsSync(p)) return p;
  }
  return null;
}

/** List the names of available functions under the root (sorted, unique). */
export function listFunctions(
  root: string,
  fileSystem: Pick<typeof fs, 'existsSync' | 'readdirSync' | 'statSync'> = fs
): string[] {
  if (!fileSystem.existsSync(root)) return [];
  const names = new Set<string>();
  for (const entry of fileSystem.readdirSync(root)) {
    const full = path.join(root, entry);
    let isDir = false;
    try {
      isDir = fileSystem.statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      // A directory counts only if it has an index.<ext> and a valid name.
      if (isValidName(entry) && resolveFunctionFile(root, entry, fileSystem)) {
        names.add(entry);
      }
      continue;
    }
    const ext = path.extname(entry);
    if (!CANDIDATE_EXTS.includes(ext)) continue;
    const base = entry.slice(0, -ext.length);
    if (base === 'index') continue; // index belongs to its parent dir
    if (isValidName(base)) names.add(base);
  }
  return [...names].sort();
}

/**
 * A lazy, caching function loader. `load(name)` dynamically imports the module
 * (once) and validates that it default-exports a function. `clear()` empties
 * the cache (used by the optional reload path).
 */
export class FunctionLoader {
  private readonly cache = new Map<string, LoadedFunction>();
  private readonly fileSystem: NonNullable<LoaderDeps['fileSystem']>;
  private readonly importer: NonNullable<LoaderDeps['importer']>;

  constructor(private readonly deps: LoaderDeps) {
    this.fileSystem = deps.fileSystem ?? fs;
    this.importer =
      deps.importer ??
      ((specifier) => import(/* @vite-ignore */ specifier));
  }

  get root(): string {
    return this.deps.root;
  }

  names(): string[] {
    return listFunctions(this.deps.root, this.fileSystem);
  }

  clear(name?: string): void {
    if (name) this.cache.delete(name);
    else this.cache.clear();
  }

  async load(name: string): Promise<LoadedFunction> {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const file = resolveFunctionFile(this.deps.root, name, this.fileSystem);
    if (!file) throw new FunctionNotFoundError(name);

    // Cache-bust the URL so reloads pick up file changes in dev.
    const url = `${pathToFileURL(file).href}?t=${Date.now()}`;
    let mod: unknown;
    try {
      mod = await this.importer(url);
    } catch (e) {
      throw new InvalidFunctionError(
        name,
        e instanceof Error ? e.message : String(e)
      );
    }

    const handler = pickDefault(mod);
    if (typeof handler !== 'function') {
      throw new InvalidFunctionError(name, 'module must default-export a function');
    }

    const loaded: LoadedFunction = { name, handler: handler as FunctionHandler };
    this.cache.set(name, loaded);
    return loaded;
  }
}

/** Pick the handler: ESM default, CJS module.exports, or a named `handler`. */
function pickDefault(mod: unknown): unknown {
  if (mod && typeof mod === 'object') {
    const o = mod as Record<string, unknown>;
    if (typeof o.default === 'function') return o.default;
    if (typeof o.handler === 'function') return o.handler;
  }
  if (typeof mod === 'function') return mod;
  return undefined;
}
