// env.ts — pure .env parsing / editing / generation. No fs here; callers pass
// the file contents in and write the result out. Keeps it trivially testable.

export type EnvMap = Record<string, string>;

/**
 * Parse a dotenv-style string into a key->value map. Ignores blank lines and
 * `#` comments. Strips matching surrounding single/double quotes from values.
 * Does NOT do variable interpolation (compose handles that at runtime).
 */
export function parseEnv(content: string): EnvMap {
  const out: EnvMap = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Produce the contents of a fresh `.env` from the example template, filling in
 * the supplied values for the named keys. Lines whose key is in `values` get
 * their value replaced in place (comments + ordering preserved); keys not
 * present in the template are appended at the end.
 */
export function fillEnv(template: string, values: EnvMap): string {
  const seen = new Set<string>();
  const lines = template.split(/\r?\n/).map((raw) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return raw;
    const eq = raw.indexOf('=');
    if (eq === -1) return raw;
    const key = raw.slice(0, eq).trim();
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      seen.add(key);
      return `${key}=${values[key]}`;
    }
    return raw;
  });
  const extra = Object.keys(values)
    .filter((k) => !seen.has(k))
    .map((k) => `${k}=${values[k]}`);
  let result = lines.join('\n');
  if (extra.length) {
    if (!result.endsWith('\n')) result += '\n';
    result += extra.join('\n') + '\n';
  }
  return result;
}

/**
 * Derive a Postgres DATABASE_URL (superuser) from an env map. The compose stack
 * does not publish 5432 by default, so the CLI connects to localhost on the
 * host where Postgres has been exposed (or via override). Host/port are
 * configurable through PGHOST/PGPORT in .env; defaults match a locally exposed db.
 */
export function databaseUrl(env: EnvMap): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const user = env.POSTGRES_USER || 'laetoli';
  const pass = env.POSTGRES_PASSWORD || '';
  const host = env.PGHOST || '127.0.0.1';
  const port = env.PGPORT || '5432';
  const db = env.POSTGRES_DB || 'laetoli';
  const auth = pass ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}` : encodeURIComponent(user);
  return `postgres://${auth}@${host}:${port}/${db}`;
}
