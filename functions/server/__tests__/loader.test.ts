import { describe, it, expect, afterEach } from 'vitest';
import {
  FunctionLoader,
  FunctionNotFoundError,
  InvalidFunctionError,
  isValidName,
  listFunctions,
  resolveFunctionFile,
} from '../loader.js';
import { tempFns, type TempFns } from './helpers.js';

let fns: TempFns | undefined;
afterEach(() => {
  fns?.cleanup();
  fns = undefined;
});

describe('isValidName', () => {
  it('accepts safe names and rejects traversal/paths', () => {
    expect(isValidName('hello')).toBe(true);
    expect(isValidName('my-fn_2')).toBe(true);
    expect(isValidName('..')).toBe(false);
    expect(isValidName('a/b')).toBe(false);
    expect(isValidName('a.b')).toBe(false);
    expect(isValidName('')).toBe(false);
  });
});

describe('resolveFunctionFile + listFunctions', () => {
  it('finds <name>.<ext> and <name>/index.<ext>, and lists them', () => {
    fns = tempFns();
    fns.write('hello.mjs', 'export default () => ({});');
    fns.write('grouped/index.mjs', 'export default () => ({});');
    fns.write('notes.txt', 'ignored');

    expect(resolveFunctionFile(fns.root, 'hello')).toContain('hello.mjs');
    expect(resolveFunctionFile(fns.root, 'grouped')).toContain('index.mjs');
    expect(resolveFunctionFile(fns.root, 'missing')).toBeNull();
    // Traversal is refused at name validation.
    expect(resolveFunctionFile(fns.root, '../etc')).toBeNull();

    expect(listFunctions(fns.root)).toEqual(['grouped', 'hello']);
  });

  it('returns [] for a non-existent root', () => {
    expect(listFunctions('/no/such/dir/xyz')).toEqual([]);
  });
});

describe('FunctionLoader', () => {
  it('loads a default-exported handler and caches it', async () => {
    let imports = 0;
    const loader = new FunctionLoader({
      root: '/virtual',
      fileSystem: { existsSync: (p: string) => String(p).includes('hello') } as never,
      importer: async () => {
        imports++;
        return { default: async () => ({ ok: true }) };
      },
    });
    const a = await loader.load('hello');
    const b = await loader.load('hello');
    expect(a).toBe(b);
    expect(imports).toBe(1); // cached
  });

  it('throws FunctionNotFoundError for an unknown name', async () => {
    const loader = new FunctionLoader({
      root: '/virtual',
      fileSystem: { existsSync: () => false } as never,
      importer: async () => ({ default: () => ({}) }),
    });
    await expect(loader.load('nope')).rejects.toBeInstanceOf(FunctionNotFoundError);
  });

  it('throws InvalidFunctionError when there is no function export', async () => {
    const loader = new FunctionLoader({
      root: '/virtual',
      fileSystem: { existsSync: () => true } as never,
      importer: async () => ({ default: 42 }),
    });
    await expect(loader.load('bad')).rejects.toBeInstanceOf(InvalidFunctionError);
  });

  it('clear() drops the cache so the next load re-imports', async () => {
    let imports = 0;
    const loader = new FunctionLoader({
      root: '/virtual',
      fileSystem: { existsSync: () => true } as never,
      importer: async () => {
        imports++;
        return { default: () => ({}) };
      },
    });
    await loader.load('x');
    loader.clear('x');
    await loader.load('x');
    expect(imports).toBe(2);
  });
});
