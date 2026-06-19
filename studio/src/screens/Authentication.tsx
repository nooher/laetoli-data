import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { AdminApi, ApiError } from '../api';
import type { AuthUser } from '../types';
import { formatDate } from '../lib';
import { Loading, ErrorBanner, OkBanner, Empty } from '../components/ui';
import { IconTrash } from '../icons';

const PAGE = 50;

export function Authentication({ api }: { api: AdminApi }): JSX.Element {
  const [users, setUsers] = useState<AuthUser[] | null>(null);
  const [count, setCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  function load() {
    let active = true;
    setLoading(true);
    setError(null);
    api.authUsers({ limit: PAGE, offset }).then(
      (r) => {
        if (!active) return;
        setUsers(r.users);
        setCount(r.count ?? r.users.length);
        setLoading(false);
      },
      (e: unknown) => active && (setError(e instanceof ApiError ? e.message : 'Failed to load users.'), setLoading(false)),
    );
    return () => {
      active = false;
    };
  }

  useEffect(load, [api, offset]);

  async function remove(u: AuthUser) {
    if (!confirm(`Delete user "${u.username ?? u.id}"? This cannot be undone.`)) return;
    try {
      await api.deleteAuthUser(u.id);
      setOk('User deleted.');
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Delete failed.');
    }
  }

  if (loading) return <Loading label="Loading users…" />;
  if (error) return <ErrorBanner message={error} />;

  const showingTo = Math.min(offset + PAGE, count);

  return (
    <>
      {ok ? <OkBanner message={ok} /> : null}
      {!users || users.length === 0 ? (
        <Empty title="No users" hint="No accounts have signed up to this backend yet." />
      ) : (
        <>
          <div className="table-scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>ID</th>
                  <th>Role</th>
                  <th>Anonymous</th>
                  <th>Created</th>
                  <th>Last sign-in</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.username ?? <span className="muted">—</span>}</td>
                    <td className="cell-val">{u.id}</td>
                    <td><span className="pill pill-type">{u.role ?? 'authenticated'}</span></td>
                    <td>{u.is_anonymous ? <span className="pill pill-warn">yes</span> : 'no'}</td>
                    <td>{formatDate(u.created_at)}</td>
                    <td>{formatDate(u.last_sign_in_at)}</td>
                    <td>
                      <button className="btn btn-danger btn-sm" onClick={() => remove(u)} aria-label={`Delete ${u.username ?? u.id}`}>
                        <IconTrash className="nav-ico" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <button className="btn btn-ghost btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              ← Prev
            </button>
            <span>
              {count === 0 ? 0 : offset + 1}–{showingTo} of {count.toLocaleString()}
            </span>
            <button className="btn btn-ghost btn-sm" disabled={showingTo >= count} onClick={() => setOffset(offset + PAGE)}>
              Next →
            </button>
          </div>
        </>
      )}
    </>
  );
}
