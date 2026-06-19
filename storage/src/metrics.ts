// metrics.ts — a tiny, dependency-free Prometheus metrics registry.
//
// This is the SAME file copied into auth/, storage/, and realtime/ (each is a
// separate npm package, so we duplicate rather than share a module). It provides:
//   * Counter   — monotonically increasing, optional label sets.
//   * Gauge     — set/inc/dec arbitrary value.
//   * Histogram — bucketed observations -> _bucket/_sum/_count series.
//   * Registry  — holds metrics + renders the Prometheus text exposition format.
//
// Pure logic, no I/O — render() returns a string the /metrics route writes out.
// Designed to be unit-tested in isolation (see __tests__/metrics.test.ts).

export type Labels = Record<string, string>;

// Default histogram buckets (seconds) — good for sub-second HTTP latencies.
export const DEFAULT_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

function labelKey(labels: Labels): string {
  // Stable key: sort label names so {a,b} and {b,a} collapse to one series.
  const names = Object.keys(labels).sort();
  return names.map((n) => `${n}=${labels[n]}`).join(',');
}

function renderLabels(labels: Labels): string {
  const names = Object.keys(labels).sort();
  if (names.length === 0) return '';
  const inner = names
    .map((n) => `${n}="${escapeLabelValue(labels[n])}"`)
    .join(',');
  return `{${inner}}`;
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

interface MetricBase {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  render(): string[];
}

export class Counter implements MetricBase {
  readonly type = 'counter' as const;
  private values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string
  ) {}

  inc(labels: Labels = {}, delta = 1): void {
    const key = labelKey(labels);
    const cur = this.values.get(key);
    if (cur) cur.value += delta;
    else this.values.set(key, { labels, value: delta });
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels))?.value ?? 0;
  }

  render(): string[] {
    const lines: string[] = [];
    if (this.values.size === 0) {
      // Emit a zero series so the metric is always present.
      lines.push(`${this.name} 0`);
      return lines;
    }
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines;
  }
}

export class Gauge implements MetricBase {
  readonly type = 'gauge' as const;
  private values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string
  ) {}

  set(value: number, labels: Labels = {}): void {
    this.values.set(labelKey(labels), { labels, value });
  }
  inc(delta = 1, labels: Labels = {}): void {
    const key = labelKey(labels);
    const cur = this.values.get(key);
    if (cur) cur.value += delta;
    else this.values.set(key, { labels, value: delta });
  }
  dec(delta = 1, labels: Labels = {}): void {
    this.inc(-delta, labels);
  }
  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels))?.value ?? 0;
  }

  render(): string[] {
    const lines: string[] = [];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
      return lines;
    }
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines;
  }
}

export class Histogram implements MetricBase {
  readonly type = 'histogram' as const;
  private readonly buckets: number[];
  private series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();
  constructor(
    readonly name: string,
    readonly help: string,
    buckets: number[] = DEFAULT_BUCKETS
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) s.counts[i] += 1;
    }
  }

  render(): string[] {
    const lines: string[] = [];
    for (const s of this.series.values()) {
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative = s.counts[i];
        const le = String(this.buckets[i]);
        lines.push(
          `${this.name}_bucket${renderLabels({ ...s.labels, le })} ${cumulative}`
        );
      }
      lines.push(
        `${this.name}_bucket${renderLabels({ ...s.labels, le: '+Inf' })} ${s.count}`
      );
      lines.push(`${this.name}_sum${renderLabels(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
    return lines;
  }
}

export class Registry {
  private metrics: MetricBase[] = [];
  /** Injectable clock for deterministic uptime tests. */
  now: () => number = () => Date.now();
  private startedAt = this.now();

  counter(name: string, help: string): Counter {
    const c = new Counter(name, help);
    this.metrics.push(c);
    return c;
  }
  gauge(name: string, help: string): Gauge {
    const g = new Gauge(name, help);
    this.metrics.push(g);
    return g;
  }
  histogram(name: string, help: string, buckets?: number[]): Histogram {
    const h = new Histogram(name, help, buckets);
    this.metrics.push(h);
    return h;
  }

  /** Render the full registry in Prometheus text exposition format. */
  render(): string {
    const out: string[] = [];
    // process_uptime_seconds is computed fresh on each scrape.
    const uptime = (this.now() - this.startedAt) / 1000;
    out.push('# HELP process_uptime_seconds Seconds since the process started.');
    out.push('# TYPE process_uptime_seconds gauge');
    out.push(`process_uptime_seconds ${uptime}`);

    for (const m of this.metrics) {
      out.push(`# HELP ${m.name} ${m.help}`);
      out.push(`# TYPE ${m.name} ${m.type}`);
      out.push(...m.render());
    }
    return out.join('\n') + '\n';
  }

  /** The exposition Content-Type Prometheus expects. */
  static contentType = 'text/plain; version=0.0.4; charset=utf-8';
}
