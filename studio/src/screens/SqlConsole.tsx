import { useState } from 'react';
import type { JSX } from 'react';
import { AdminApi, ApiError } from '../api';
import type { SqlResult } from '../types';
import { formatCell, isNullish } from '../lib';
import { ErrorBanner } from '../components/ui';

const HISTORY_KEY = 'laetoli.studio.sqlHistory';
const MAX_HISTORY = 20;

function loadHistory(): string[] {
  try {
    const raw = sessionStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function pushHistory(q: string): string[] {
  const prev = loadHistory().filter((h) => h !== q);
  const next = [q, ...prev].slice(0, MAX_HISTORY);
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  return next;
}

export function SqlConsole({ api }: { api: AdminApi }): JSX.Element {
  const [query, setQuery] = useState('select now();');
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>(loadHistory);

  async function run() {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.sql(q);
      setResult(r);
      setHistory(pushHistory(q));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Query failed.');
    } finally {
      setBusy(false);
    }
  }

  const fields =
    result?.fields && result.fields.length
      ? result.fields
      : result && result.rows.length
        ? Object.keys(result.rows[0])
        : [];

  return (
    <div className="spread" style={{ alignItems: 'flex-start', gap: 24 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <label htmlFor="sql">Query</label>
        <textarea
          id="sql"
          className="sql-editor"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              run();
            }
          }}
          spellCheck={false}
          aria-label="SQL query"
        />
        <div className="spread" style={{ marginTop: 10 }}>
          <span className="hint" style={{ margin: 0 }}>
            Press <kbd>Ctrl/⌘ + Enter</kbd> to run. Runs against the database with admin
            privileges — be careful.
          </span>
          <button className="btn btn-primary" onClick={run} disabled={busy}>
            {busy ? 'Running…' : 'Run'}
          </button>
        </div>

        {error ? <div style={{ marginTop: 16 }}><ErrorBanner message={error} /></div> : null}

        {result ? (
          <div style={{ marginTop: 18 }}>
            <p className="muted" style={{ fontSize: '0.86rem' }}>
              {result.rowCount.toLocaleString()} row{result.rowCount === 1 ? '' : 's'}
              {result.rows.length < result.rowCount ? ` · showing ${result.rows.length}` : ''}
            </p>
            {result.rows.length === 0 ? (
              <div className="card card-pad muted">Statement executed. No rows returned.</div>
            ) : (
              <div className="table-scroll">
                <table className="grid">
                  <thead>
                    <tr>
                      {fields.map((f) => (
                        <th key={f}>{f}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i}>
                        {fields.map((f) => (
                          <td key={f} className={`cell-val${isNullish(row[f]) ? ' null' : ''}`}>
                            {formatCell(row[f])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </div>

      <aside style={{ width: 240, flexShrink: 0 }}>
        <div className="section-title" style={{ marginTop: 0 }}>History</div>
        {history.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.84rem' }}>No statements yet.</p>
        ) : (
          <ul className="history">
            {history.map((h, i) => (
              <li key={i} title={h} onClick={() => setQuery(h)} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') setQuery(h); }}>
                {h}
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
