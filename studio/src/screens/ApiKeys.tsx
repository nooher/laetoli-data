import { useEffect, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { AdminApi, ApiError } from '../api';
import type {
  ApiKey,
  ApiKeyRole,
  CreatedApiKey,
  KeyUsage,
  Project,
} from '../types';
import { formatDate, formatCount, maskKey } from '../lib';
import { Loading, TableSkeleton, ErrorBanner, Toast, Empty, Modal } from '../components/ui';
import { IconPlus, IconTrash, IconKey, IconCopy } from '../icons';

export function ApiKeys({ api }: { api: AdminApi }): JSX.Element {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    let active = true;
    setLoading(true);
    setError(null);
    api.projects().then(
      (list) => {
        if (!active) return;
        setProjects(list);
        setSelected((cur) => cur ?? (list.length ? list[0].id : null));
        setLoading(false);
      },
      (e: unknown) =>
        active &&
        (setError(e instanceof ApiError ? e.message : 'Failed to load projects.'),
        setLoading(false)),
    );
    return () => {
      active = false;
    };
  }

  useEffect(load, [api]);

  async function addProject(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProject(name);
      setOk(`Project “${p.name}” created.`);
      setNewName('');
      setCreating(false);
      setSelected(p.id);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create project.');
    } finally {
      setBusy(false);
    }
  }

  async function removeProject(p: Project) {
    if (
      !confirm(
        `Delete project “${p.name}” and all of its API keys? This cannot be undone.`,
      )
    )
      return;
    setError(null);
    try {
      await api.deleteProject(p.id);
      setOk(`Project “${p.name}” deleted.`);
      setSelected((cur) => (cur === p.id ? null : cur));
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Delete failed.');
    }
  }

  if (loading) return <Loading label="Loading projects…" />;
  if (error && !projects) return <ErrorBanner message={error} />;

  return (
    <>
      {ok ? <Toast message={ok} onClose={() => setOk(null)} /> : null}
      {error ? <ErrorBanner message={error} /> : null}

      <div className="toolbar">
        <div className="grow">
          <p className="muted" style={{ margin: 0, fontSize: '0.9rem' }}>
            Projects scope your API keys. Each key authorises client apps to reach
            this backend — keep service-role keys secret.
          </p>
        </div>
        <button className="btn btn-green btn-sm" onClick={() => setCreating(true)}>
          <IconPlus className="nav-ico" /> New project
        </button>
      </div>

      {!projects || projects.length === 0 ? (
        <Empty
          title="No projects yet"
          hint="Create a project to start issuing API keys for your client apps."
          icon={<IconKey className="empty-ico" />}
          action={
            <button className="btn btn-green btn-sm" onClick={() => setCreating(true)}>
              <IconPlus className="nav-ico" /> New project
            </button>
          }
        />
      ) : (
        <div className="spread" style={{ alignItems: 'flex-start', gap: 24 }}>
          <aside style={{ width: 230, flexShrink: 0 }}>
            <div className="section-title" style={{ marginTop: 0 }}>
              Projects
            </div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {projects.map((p) => {
                const isSel = selected === p.id;
                return (
                  <li
                    key={p.id}
                    style={{ display: 'flex', alignItems: 'stretch', gap: 6, marginBottom: 6 }}
                  >
                    <button
                      className={`nav-item${isSel ? ' active' : ''}`}
                      aria-current={isSel ? 'true' : undefined}
                      style={{
                        color: isSel ? '#fff' : 'var(--charcoal)',
                        background: isSel ? 'var(--green-deep)' : 'var(--paper)',
                        border: '1px solid var(--line)',
                        flex: 1,
                        minWidth: 0,
                      }}
                      onClick={() => setSelected(p.id)}
                    >
                      <IconKey className="nav-ico" />
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {p.name}
                      </span>
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => removeProject(p)}
                      aria-label={`Delete project ${p.name}`}
                      title="Delete project"
                    >
                      <IconTrash className="nav-ico" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
          <div style={{ flex: 1, minWidth: 0 }}>
            {selected ? (
              <ProjectDetail
                key={selected}
                api={api}
                project={projects.find((p) => p.id === selected) ?? null}
                onMessage={setOk}
                onError={setError}
              />
            ) : (
              <Empty title="Select a project" hint="Choose a project to see its API keys." />
            )}
          </div>
        </div>
      )}

      {creating ? (
        <Modal
          title="New project"
          onClose={() => !busy && setCreating(false)}
          footer={
            <>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setCreating(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="btn btn-green btn-sm"
                onClick={addProject}
                disabled={busy || !newName.trim()}
              >
                {busy ? 'Creating…' : 'Create project'}
              </button>
            </>
          }
        >
          <form onSubmit={addProject}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="projName">Project name</label>
              <input
                id="projName"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Mobile app — production"
                autoFocus
              />
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}

function ProjectDetail({
  api,
  project,
  onMessage,
  onError,
}: {
  api: AdminApi;
  project: Project | null;
  onMessage: (m: string) => void;
  onError: (m: string) => void;
}): JSX.Element {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [usage, setUsage] = useState<KeyUsage[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [revealed, setRevealed] = useState<CreatedApiKey | null>(null);

  // create-key form
  const [name, setName] = useState('');
  const [role, setRole] = useState<ApiKeyRole>('anon');
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    if (!project) return;
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([
      api.projectKeys(project.id),
      api.usage(project.id).then(
        (r) => r.usage,
        () => [] as KeyUsage[], // usage is best-effort; don't fail the whole view
      ),
    ]).then(
      ([k, u]) => {
        if (!active) return;
        setKeys(k);
        setUsage(u);
        setLoading(false);
      },
      (e: unknown) => {
        if (!active) return;
        setError(e instanceof ApiError ? e.message : 'Failed to load API keys.');
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }

  useEffect(load, [api, project]);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!project) return;
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      const rateNum = rate.trim() ? Number(rate) : undefined;
      const created = await api.createKey(project.id, {
        name: n,
        role,
        ...(rateNum != null && !Number.isNaN(rateNum) ? { rate_limit_per_min: rateNum } : {}),
      });
      setRevealed(created);
      setShowCreate(false);
      setName('');
      setRole('anon');
      setRate('');
      onMessage('API key created. Copy the secret now — it will not be shown again.');
      load();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not create key.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: ApiKey) {
    if (!confirm(`Revoke key “${k.name}”? Apps using it will stop working immediately.`))
      return;
    try {
      await api.revokeKey(k.id);
      onMessage(`Key “${k.name}” revoked.`);
      load();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Revoke failed.');
    }
  }

  if (!project) return <Empty title="No project selected" />;
  if (loading) return <TableSkeleton columns={8} label="Loading API keys…" />;
  if (error) return <ErrorBanner message={error} />;

  const usageById = new Map((usage ?? []).map((u) => [u.key_id, u]));

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <h3 style={{ fontSize: '1.15rem', marginBottom: 2 }}>{project.name}</h3>
          <p className="muted" style={{ margin: 0, fontSize: '0.84rem' }}>
            Created {formatDate(project.created_at)}
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
          <IconKey className="nav-ico" /> Create key
        </button>
      </div>

      {!keys || keys.length === 0 ? (
        <Empty
          title="No API keys"
          hint="Create an anon key for public clients or a service key for trusted servers."
        />
      ) : (
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Key</th>
                <th>Rate limit</th>
                <th>Requests</th>
                <th>Created</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const u = usageById.get(k.id);
                const revoked = !!k.revoked_at;
                return (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td>
                      <span
                        className={`pill ${k.role === 'service' ? 'pill-cmd' : 'pill-type'}`}
                      >
                        {k.role}
                      </span>
                    </td>
                    <td className="cell-val">{maskKey(k.key_prefix)}</td>
                    <td>
                      {k.rate_limit_per_min != null ? (
                        `${k.rate_limit_per_min}/min`
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{formatCount(u?.requests)}</td>
                    <td>{formatDate(k.created_at)}</td>
                    <td>
                      {revoked ? (
                        <span className="pill pill-warn" title={`Revoked ${formatDate(k.revoked_at)}`}>
                          revoked
                        </span>
                      ) : (
                        <span className="pill pill-ok">
                          <span className="dot dot-ok" /> active
                        </span>
                      )}
                    </td>
                    <td>
                      {revoked ? (
                        <span className="muted">—</span>
                      ) : (
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => revoke(k)}
                          aria-label={`Revoke key ${k.name}`}
                          title="Revoke key"
                        >
                          <IconTrash className="nav-ico" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreate ? (
        <Modal
          title="Create API key"
          onClose={() => !busy && setShowCreate(false)}
          footer={
            <>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setShowCreate(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={create}
                disabled={busy || !name.trim()}
              >
                {busy ? 'Creating…' : 'Create key'}
              </button>
            </>
          }
        >
          <form onSubmit={create}>
            <div className="field">
              <label htmlFor="keyName">Key name</label>
              <input
                id="keyName"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. iOS client"
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="keyRole">Role</label>
              <select
                id="keyRole"
                value={role}
                onChange={(e) => setRole(e.target.value as ApiKeyRole)}
              >
                <option value="anon">anon — public client (RLS-restricted)</option>
                <option value="service">service — trusted server (full access)</option>
              </select>
              {role === 'service' ? (
                <p className="hint">
                  Service keys bypass row-level security. Use only on a trusted server,
                  never in a browser or mobile app.
                </p>
              ) : null}
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="keyRate">Rate limit (requests / minute)</label>
              <input
                id="keyRate"
                type="number"
                min="1"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="optional"
              />
            </div>
          </form>
        </Modal>
      ) : null}

      {revealed ? (
        <RevealKeyModal created={revealed} onClose={() => setRevealed(null)} />
      ) : null}
    </>
  );
}

function RevealKeyModal({
  created,
  onClose,
}: {
  created: CreatedApiKey;
  onClose: () => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.apikey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Modal
      title="Copy your new API key"
      onClose={onClose}
      footer={
        <button className="btn btn-green btn-sm" onClick={onClose}>
          Done — I’ve saved it
        </button>
      }
    >
      <div
        className="error-banner"
        role="alert"
        style={{
          background: 'var(--sand-card)',
          borderColor: 'var(--gold)',
          borderLeftColor: 'var(--gold-deep)',
          color: 'var(--charcoal)',
        }}
      >
        This is the only time the full secret is shown. Copy it now and store it
        securely — you will not be able to see it again.
      </div>

      <div className="field">
        <label htmlFor="newKeyValue">{created.name}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
          <input
            id="newKeyValue"
            type="text"
            readOnly
            value={created.apikey}
            onFocus={(e) => e.currentTarget.select()}
            style={{ fontFamily: 'var(--font-mono)', fontSize: '0.84rem' }}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={copy}
            style={{ flexShrink: 0 }}
            aria-label="Copy API key to clipboard"
          >
            <IconCopy className="nav-ico" /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="hint">
          Role <strong>{created.role}</strong>
          {created.rate_limit_per_min != null
            ? ` · ${created.rate_limit_per_min} requests/min`
            : ''}
          .
        </p>
      </div>
    </Modal>
  );
}
