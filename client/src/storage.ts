import type { TokenStorage } from './types';

export const DEFAULT_STORAGE_KEY = 'laetoli-data:token';

/** In-memory fallback for Node / SSR / private-mode browsers. */
export function memoryStorage(): TokenStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/**
 * Resolve a usable storage: localStorage when present and functional,
 * otherwise an in-memory map. Guarded so it never throws in non-browser
 * environments or when storage access is blocked.
 */
export function resolveStorage(custom?: TokenStorage): TokenStorage {
  if (custom) return custom;
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      const ls = (globalThis as { localStorage?: TokenStorage }).localStorage;
      if (ls) {
        // Probe — Safari private mode throws on setItem.
        const probe = '__laetoli_probe__';
        ls.setItem(probe, '1');
        ls.removeItem(probe);
        return ls;
      }
    }
  } catch {
    /* fall through to memory */
  }
  return memoryStorage();
}
