import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { AdminApi, ApiError } from '../api';
import type { Stats } from '../types';
import { Loading, ErrorBanner } from '../components/ui';

export function Dashboard({ api }: { api: AdminApi }): JSX.Element {
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<'up' | 'down' | 'unknown'>('unknown');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([
      api.stats(),
      api.health().then(
        () => 'up' as const,
        () => 'down' as const,
      ),
    ])
      .then(([s, h]) => {
        if (!active) return;
        setStats(s);
        setHealth(h);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError(e instanceof ApiError ? e.message : 'Failed to load dashboard.');
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [api]);

  if (loading) return <Loading label="Reading backend stats…" />;
  if (error) return <ErrorBanner message={error} />;

  const tiles: { label: string; value: string; foot?: string }[] = [
    { label: 'Auth users', value: fmt(stats?.users), foot: 'rows in auth.users' },
    { label: 'Tables', value: fmt(stats?.tables), foot: 'across exposed schemas' },
    { label: 'Buckets', value: fmt(stats?.buckets), foot: 'storage buckets' },
    { label: 'Objects', value: fmt(stats?.objects), foot: 'stored files' },
    { label: 'Database size', value: stats?.db_size_pretty ?? '—', foot: 'on disk' },
  ];

  return (
    <>
      <div className="tiles">
        {tiles.map((t) => (
          <div className="tile" key={t.label}>
            <div className="tile-label">{t.label}</div>
            <div className="tile-val">{t.value}</div>
            {t.foot ? <div className="tile-foot">{t.foot}</div> : null}
          </div>
        ))}
      </div>

      <div className="card card-pad">
        <div className="spread">
          <div>
            <h3 style={{ fontSize: '1.05rem', marginBottom: 4 }}>Service health</h3>
            <p className="muted" style={{ margin: 0, fontSize: '0.88rem' }}>
              Edge reachability via <code>/health</code>.
            </p>
          </div>
          <span
            className={`pill ${health === 'up' ? 'pill-ok' : health === 'down' ? 'pill-warn' : 'pill-type'}`}
          >
            <span className={`dot ${health === 'up' ? 'dot-ok' : 'dot-bad'}`} />
            {health === 'up' ? 'Operational' : health === 'down' ? 'Unreachable' : 'Unknown'}
          </span>
        </div>
      </div>
    </>
  );
}

function fmt(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString();
}
