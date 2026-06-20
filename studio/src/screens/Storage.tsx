import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { AdminApi, ApiError } from '../api';
import type { Bucket, StorageObject } from '../types';
import { formatBytes, formatDate } from '../lib';
import { Loading, TableSkeleton, ErrorBanner, Empty } from '../components/ui';
import { IconStorage } from '../icons';

export function Storage({ api }: { api: AdminApi }): JSX.Element {
  const [buckets, setBuckets] = useState<Bucket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.storageBuckets().then(
      (r) => {
        if (!active) return;
        setBuckets(r.buckets);
        if (r.buckets.length) setSelected(r.buckets[0].name);
      },
      (e: unknown) => active && setError(e instanceof ApiError ? e.message : 'Failed to load buckets.'),
    );
    return () => {
      active = false;
    };
  }, [api]);

  if (error) return <ErrorBanner message={error} />;
  if (!buckets) return <Loading label="Loading buckets…" />;
  if (buckets.length === 0)
    return (
      <Empty
        title="No buckets"
        hint="Create a storage bucket to start uploading files."
        icon={<IconStorage className="empty-ico" />}
      />
    );

  return (
    <div className="spread" style={{ alignItems: 'flex-start', gap: 24 }}>
      <aside style={{ width: 220, flexShrink: 0 }}>
        <div className="section-title" style={{ marginTop: 0 }}>Buckets</div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {buckets.map((b) => (
            <li key={b.name}>
              <button
                className={`nav-item${selected === b.name ? ' active' : ''}`}
                style={{ color: selected === b.name ? '#fff' : 'var(--charcoal)', background: selected === b.name ? 'var(--green-deep)' : 'var(--paper)', border: '1px solid var(--line)', marginBottom: 6 }}
                onClick={() => setSelected(b.name)}
              >
                <span>{b.name}</span>
                {b.public ? <span className="pill pill-ok" style={{ marginLeft: 'auto' }}>public</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div style={{ flex: 1, minWidth: 0 }}>
        {selected ? <ObjectList key={selected} api={api} bucket={selected} /> : null}
      </div>
    </div>
  );
}

function ObjectList({ api, bucket }: { api: AdminApi; bucket: string }): JSX.Element {
  const [objects, setObjects] = useState<StorageObject[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api.storageObjects(bucket, { limit: 200 }).then(
      (r) => active && (setObjects(r.objects), setLoading(false)),
      (e: unknown) => active && (setError(e instanceof ApiError ? e.message : 'Failed to load objects.'), setLoading(false)),
    );
    return () => {
      active = false;
    };
  }, [api, bucket]);

  if (loading) return <TableSkeleton columns={5} label="Loading objects…" />;
  if (error) return <ErrorBanner message={error} />;
  if (!objects || objects.length === 0)
    return (
      <Empty
        title="Empty bucket"
        hint={`No objects in “${bucket}”.`}
        icon={<IconStorage className="empty-ico" />}
      />
    );

  return (
    <div className="table-scroll">
      <table className="grid">
        <thead>
          <tr>
            <th>Path</th>
            <th>Size</th>
            <th>MIME</th>
            <th>Owner</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {objects.map((o, i) => (
            <tr key={i}>
              <td className="cell-val">{o.path ?? o.name}</td>
              <td>{formatBytes(o.size)}</td>
              <td><span className="pill pill-type">{o.mime ?? o.mime_type ?? '—'}</span></td>
              <td className="cell-val">{o.owner ?? <span className="muted">—</span>}</td>
              <td>{formatDate(o.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
