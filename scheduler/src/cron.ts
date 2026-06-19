// cron.ts — a tiny, dependency-free 5-field cron parser + next-run calculator.
//
// VENDORED VERBATIM from backup/src/cron.ts (the canonical Laetoli Data cron
// module). Kept as a self-contained copy so the scheduler worker has no
// cross-package import; if the canonical module changes, re-copy it here.
//
// Supports the standard 5 fields: minute hour day-of-month month day-of-week.
// Each field accepts: "*", a list "a,b,c", a range "a-b", a step "*/n" or
// "a-b/n", and combinations thereof. Day-of-week is 0-6 (Sun=0; 7 also = Sun).
//
// This is deliberately pure (no Date.now() inside) so nextRun() is fully
// deterministic given a `from` instant — which makes it exhaustively testable.

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Whether DOM / DOW were restricted (affects the OR semantics below). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const RANGES: Record<string, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
};

function parseField(raw: string, name: keyof typeof RANGES): Set<number> {
  const [lo, hi] = RANGES[name];
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const seg = part.trim();
    if (seg.length === 0) throw new Error(`Empty cron segment in "${name}"`);
    let step = 1;
    let rangePart = seg;
    const slash = seg.indexOf('/');
    if (slash !== -1) {
      step = Number.parseInt(seg.slice(slash + 1), 10);
      if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`Invalid step in cron "${name}": ${seg}`);
      }
      rangePart = seg.slice(0, slash);
    }
    let start = lo;
    let end = hi;
    if (rangePart !== '*') {
      const dash = rangePart.indexOf('-');
      if (dash !== -1) {
        start = Number.parseInt(rangePart.slice(0, dash), 10);
        end = Number.parseInt(rangePart.slice(dash + 1), 10);
      } else {
        start = Number.parseInt(rangePart, 10);
        end = start;
      }
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`Invalid cron value in "${name}": ${seg}`);
    }
    for (let v = start; v <= end; v += step) {
      let nv = v;
      if (name === 'dow' && nv === 7) nv = 0; // 7 == Sunday
      if (nv < lo || nv > hi) {
        throw new Error(`Cron value out of range in "${name}": ${nv}`);
      }
      out.add(nv);
    }
  }
  return out;
}

/** Parse a 5-field cron string into resolved value sets. Throws on garbage. */
export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Cron must have exactly 5 fields (got ${parts.length}): "${expr}"`
    );
  }
  const [minute, hour, dom, month, dow] = parts;
  return {
    minute: parseField(minute, 'minute'),
    hour: parseField(hour, 'hour'),
    dom: parseField(dom, 'dom'),
    month: parseField(month, 'month'),
    dow: parseField(dow, 'dow'),
    domRestricted: dom.trim() !== '*',
    dowRestricted: dow.trim() !== '*',
  };
}

/**
 * Compute the next instant at or after `from` (exclusive of `from` itself)
 * that matches the cron fields. Works in UTC. Returns a Date.
 *
 * Standard Vixie-cron day semantics: if BOTH day-of-month and day-of-week are
 * restricted, a day matches if EITHER matches (OR). If only one is restricted,
 * only that one must match.
 */
export function nextRun(fields: CronFields, from: Date): Date {
  // Start at the next whole minute after `from`.
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);

  // Cap the search to ~5 years of minutes to avoid an infinite loop on an
  // impossible spec (e.g. Feb 30). 5y is generous for any sane cron.
  const limit = 5 * 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    const month = t.getUTCMonth() + 1; // 1-12
    if (fields.month.has(month)) {
      if (dayMatches(fields, t)) {
        if (fields.hour.has(t.getUTCHours())) {
          if (fields.minute.has(t.getUTCMinutes())) {
            return new Date(t.getTime());
          }
        }
      }
    }
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  throw new Error('Could not find a matching cron time within 5 years.');
}

function dayMatches(fields: CronFields, t: Date): boolean {
  const dom = t.getUTCDate();
  const dow = t.getUTCDay(); // 0-6, Sun=0
  if (fields.domRestricted && fields.dowRestricted) {
    return fields.dom.has(dom) || fields.dow.has(dow);
  }
  if (fields.domRestricted) return fields.dom.has(dom);
  if (fields.dowRestricted) return fields.dow.has(dow);
  return true; // both "*"
}
