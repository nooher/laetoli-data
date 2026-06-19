import { useState } from 'react';
import type { FormEvent, JSX } from 'react';
import {
  ApiError,
  defaultBaseUrl,
  saveCredentials,
  validateCredentials,
  type Credentials,
} from '../api';
import { normalizeBaseUrl } from '../lib';
import { BrandMark } from '../icons';
import { ErrorBanner } from '../components/ui';

export function Login({ onSignedIn }: { onSignedIn: (c: Credentials) => void }): JSX.Element {
  const [key, setKey] = useState('');
  const [baseInput, setBaseInput] = useState(defaultBaseUrl());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const creds: Credentials = { baseUrl: normalizeBaseUrl(baseInput), key: key.trim() };
    if (!creds.key) {
      setError('Paste your admin key to continue.');
      return;
    }
    setBusy(true);
    try {
      await validateCredentials(creds);
      saveCredentials(creds);
      onSignedIn(creds);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.status === 401 || err.status === 403
            ? 'That admin key was rejected. Check the key and try again.'
            : err.message,
        );
      } else {
        setError(err instanceof Error ? err.message : 'Sign-in failed.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <BrandMark size={30} />
          <span className="brand-name">Laetoli&nbsp;Data</span>
        </div>
        <p className="eyebrow">Admin Studio</p>
        <h1>Sign in</h1>
        <p className="sub">
          Paste your <strong>admin key</strong> (the service-role key) to manage this
          backend. It is kept only for this browser session.
        </p>

        {error ? <ErrorBanner message={error} /> : null}

        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="adminKey">Admin key</label>
            <input
              id="adminKey"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="ADMIN_API_KEY"
              autoFocus
            />
            <p className="hint">
              This is a <strong>service-role key</strong> — keep it secret. It grants
              full admin access and is stored only in this browser tab&rsquo;s session.
            </p>
          </div>
          <div className="field">
            <label htmlFor="baseUrl">API base URL</label>
            <input
              id="baseUrl"
              type="text"
              value={baseInput}
              onChange={(e) => setBaseInput(e.target.value)}
              placeholder="/admin"
            />
            <p className="hint">
              Default <code>/admin</code> (same origin, behind Caddy). Override for a
              remote backend, e.g. <code>https://data.example.tz/admin</code>.
            </p>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Verifying…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
