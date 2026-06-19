import { describe, it, expect } from 'vitest';
import { Registry, DEFAULT_BUCKETS } from '../metrics.js';

describe('metrics registry', () => {
  it('renders process_uptime_seconds as a gauge', () => {
    const reg = new Registry();
    const out = reg.render();
    expect(out).toContain('# TYPE process_uptime_seconds gauge');
    // Uptime is a non-negative number of seconds.
    const m = out.match(/process_uptime_seconds ([\d.]+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(0);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('counter starts at zero series and accumulates', () => {
    const reg = new Registry();
    const c = reg.counter('http_requests_total', 'total http requests');
    expect(reg.render()).toContain('http_requests_total 0');
    c.inc({ route: '/health', status: '200' });
    c.inc({ route: '/health', status: '200' });
    c.inc({ route: '/token', status: '401' });
    const out = reg.render();
    expect(out).toContain('http_requests_total{route="/health",status="200"} 2');
    expect(out).toContain('http_requests_total{route="/token",status="401"} 1');
    expect(c.get({ route: '/health', status: '200' })).toBe(2);
  });

  it('collapses label order into a single series', () => {
    const reg = new Registry();
    const c = reg.counter('x_total', 'x');
    c.inc({ a: '1', b: '2' });
    c.inc({ b: '2', a: '1' });
    expect(c.get({ a: '1', b: '2' })).toBe(2);
  });

  it('gauge set/inc/dec', () => {
    const reg = new Registry();
    const g = reg.gauge('active_connections', 'active');
    g.set(5);
    g.inc();
    g.dec(2);
    expect(g.get()).toBe(4);
    expect(reg.render()).toContain('active_connections 4');
  });

  it('histogram produces cumulative buckets, _sum and _count', () => {
    const reg = new Registry();
    const h = reg.histogram('dur_seconds', 'durations');
    h.observe(0.003);
    h.observe(0.2);
    h.observe(3);
    const out = reg.render();
    // 0.003 <= 0.005 bucket
    expect(out).toContain('dur_seconds_bucket{le="0.005"} 1');
    // +Inf == total count
    expect(out).toContain('dur_seconds_bucket{le="+Inf"} 3');
    expect(out).toContain('dur_seconds_count 3');
    expect(out).toMatch(/dur_seconds_sum 3\.203\d*/);
    expect(DEFAULT_BUCKETS.length).toBeGreaterThan(0);
  });

  it('escapes label values', () => {
    const reg = new Registry();
    const c = reg.counter('y_total', 'y');
    c.inc({ path: 'a"b\\c' });
    expect(reg.render()).toContain('y_total{path="a\\"b\\\\c"} 1');
  });
});
