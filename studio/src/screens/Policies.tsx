import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { AdminApi, ApiError } from '../api';
import type { Policy, PoliciesResponse } from '../types';
import { groupBy } from '../lib';
import { Loading, ErrorBanner, Empty } from '../components/ui';

export function Policies({ api }: { api: AdminApi }): JSX.Element {
  const [data, setData] = useState<PoliciesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.policies().then(
      (r) => active && (setData(r), setLoading(false)),
      (e: unknown) => active && (setError(e instanceof ApiError ? e.message : 'Failed to load policies.'), setLoading(false)),
    );
    return () => {
      active = false;
    };
  }, [api]);

  if (loading) return <Loading label="Loading RLS policies…" />;
  if (error) return <ErrorBanner message={error} />;
  if (!data || data.policies.length === 0)
    return <Empty title="No RLS policies" hint="No row-level security policies are defined on this database." />;

  const grouped = groupBy(data.policies, (p) => `${p.schema}.${p.table}`);
  const rlsMap = new Map(
    (data.rls_enabled ?? []).map((r) => [`${r.schema}.${r.table}`, r.enabled]),
  );

  return (
    <>
      {Array.from(grouped.entries()).map(([table, policies]) => {
        const rls = rlsMap.get(table);
        return (
          <div className="card card-pad" key={table} style={{ marginBottom: 18 }}>
            <div className="spread" style={{ marginBottom: 12 }}>
              <h3 style={{ fontSize: '1.05rem' }} className="mono">{table}</h3>
              {rls === undefined ? null : (
                <span className={`pill ${rls ? 'pill-ok' : 'pill-warn'}`}>
                  RLS {rls ? 'enabled' : 'disabled'}
                </span>
              )}
            </div>
            <div className="table-scroll" style={{ boxShadow: 'none' }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th>Policy</th>
                    <th>Command</th>
                    <th>Roles</th>
                    <th>USING</th>
                    <th>WITH CHECK</th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((p: Policy) => (
                    <tr key={p.name}>
                      <td>{p.name}</td>
                      <td><span className="pill pill-cmd">{p.command}</span></td>
                      <td>{p.roles.length ? p.roles.join(', ') : <span className="muted">—</span>}</td>
                      <td className="cell-val">{p.using ?? <span className="muted">—</span>}</td>
                      <td className="cell-val">{p.with_check ?? <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </>
  );
}
