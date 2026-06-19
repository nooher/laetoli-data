// args.ts — tiny hand-rolled arg parser (no commander/yargs). Splits argv into
// positionals, boolean/value flags. Flags taking a value are declared so we know
// to consume the next token; everything else is a boolean flag.

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** raw passthrough tokens after a literal `--` (forwarded to docker, etc.) */
  passthrough: string[];
}

/**
 * @param argv          tokens after the subcommand
 * @param valueFlags    flag names (without leading --) that take a value
 */
export function parseArgs(argv: string[], valueFlags: string[] = []): ParsedArgs {
  const valueSet = new Set(valueFlags);
  const out: ParsedArgs = { positionals: [], flags: {}, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      out.passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) {
        out.flags[tok.slice(2, eq)] = tok.slice(eq + 1);
        continue;
      }
      const name = tok.slice(2);
      if (valueSet.has(name)) {
        out.flags[name] = argv[i + 1] ?? '';
        i++;
      } else {
        out.flags[name] = true;
      }
    } else if (tok.startsWith('-') && tok.length > 1) {
      // short flags: treat as boolean (e.g. -v). Pass-through handled by callers.
      out.flags[tok.slice(1)] = true;
    } else {
      out.positionals.push(tok);
    }
  }
  return out;
}

/** Read a flag as string regardless of boolean/string storage. */
export function flagStr(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : '';
}

export function hasFlag(args: ParsedArgs, ...names: string[]): boolean {
  return names.some((n) => args.flags[n] !== undefined);
}
