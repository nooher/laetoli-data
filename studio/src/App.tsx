import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import {
  AdminApi,
  clearCredentials,
  loadCredentials,
  type Credentials,
} from './api';
import type { ScreenId } from './types';
import { Login } from './screens/Login';
import { Dashboard } from './screens/Dashboard';
import { TableEditor } from './screens/TableEditor';
import { SqlConsole } from './screens/SqlConsole';
import { Authentication } from './screens/Authentication';
import { Storage } from './screens/Storage';
import { Policies } from './screens/Policies';
import { ApiKeys } from './screens/ApiKeys';
import {
  BrandMark,
  IconDashboard,
  IconTable,
  IconSql,
  IconUsers,
  IconStorage,
  IconShield,
  IconKey,
  IconSignOut,
} from './icons';

interface NavEntry {
  id: ScreenId;
  label: string;
  crumb: string;
  Icon: (p: { className?: string }) => JSX.Element;
}

const NAV: NavEntry[] = [
  { id: 'dashboard', label: 'Dashboard', crumb: 'Overview', Icon: IconDashboard },
  { id: 'tables', label: 'Table Editor', crumb: 'Database', Icon: IconTable },
  { id: 'sql', label: 'SQL Console', crumb: 'Database', Icon: IconSql },
  { id: 'auth', label: 'Authentication', crumb: 'Users', Icon: IconUsers },
  { id: 'storage', label: 'Storage', crumb: 'Files', Icon: IconStorage },
  { id: 'policies', label: 'Policies', crumb: 'Security', Icon: IconShield },
  { id: 'apikeys', label: 'API Keys & Projects', crumb: 'Access', Icon: IconKey },
];

function screenFromHash(): ScreenId {
  const h = window.location.hash.replace(/^#\/?/, '');
  const found = NAV.find((n) => n.id === h);
  return found ? found.id : 'dashboard';
}

/** Friendly node label from a base URL: host for absolute, "same origin" for /admin. */
function nodeLabel(baseUrl: string): string {
  if (baseUrl.startsWith('/')) return 'This node';
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Live edge reachability, polled gently, so the shell always shows node status. */
function useHealth(api: AdminApi | null): 'up' | 'down' | 'unknown' {
  const [state, setState] = useState<'up' | 'down' | 'unknown'>('unknown');
  useEffect(() => {
    if (!api) return;
    let active = true;
    const ping = () =>
      api.health().then(
        () => active && setState('up'),
        () => active && setState('down'),
      );
    ping();
    const id = window.setInterval(ping, 20000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [api]);
  return state;
}

export function App(): JSX.Element {
  const [creds, setCreds] = useState<Credentials | null>(loadCredentials);
  const [screen, setScreen] = useState<ScreenId>(screenFromHash);

  useEffect(() => {
    const onHash = () => setScreen(screenFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const api = useMemo(() => (creds ? new AdminApi(creds) : null), [creds]);
  const health = useHealth(api);

  if (!creds || !api) {
    return <Login onSignedIn={setCreds} />;
  }

  function go(id: ScreenId) {
    window.location.hash = `/${id}`;
    setScreen(id);
  }

  function signOut() {
    clearCredentials();
    setCreds(null);
    window.location.hash = '';
  }

  const active = NAV.find((n) => n.id === screen) ?? NAV[0];

  return (
    <div className="app">
      <nav className="nav" aria-label="Studio sections">
        <div className="nav-brand">
          <BrandMark size={30} />
          <div>
            <div className="brand-name">Laetoli Data</div>
            <div className="brand-sub">Admin Studio</div>
          </div>
        </div>
        <ul className="nav-list">
          {NAV.map((n) => (
            <li key={n.id}>
              <button
                className={`nav-item${screen === n.id ? ' active' : ''}`}
                aria-current={screen === n.id ? 'page' : undefined}
                onClick={() => go(n.id)}
              >
                <n.Icon className="nav-ico" />
                {n.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="nav-foot">
          <div className="node" title={creds.baseUrl}>
            <span
              className={`node-dot ${health === 'up' ? 'is-up' : health === 'down' ? 'is-down' : 'is-unknown'}`}
              aria-hidden="true"
            />
            <div className="node-body">
              <div className="node-name">{nodeLabel(creds.baseUrl)}</div>
              <div className="node-state">
                {health === 'up'
                  ? 'Connected'
                  : health === 'down'
                    ? 'Unreachable'
                    : 'Connecting…'}
              </div>
            </div>
          </div>
          <button
            className="btn btn-ghost btn-sm nav-signout"
            onClick={signOut}
          >
            <IconSignOut className="nav-ico" /> Sign out
          </button>
        </div>
      </nav>

      <main className="main">
        <div className="topbar">
          <h1>{active.label}</h1>
          <span className="crumb">{active.crumb}</span>
        </div>
        <div className="content">
          {screen === 'dashboard' && <Dashboard api={api} />}
          {screen === 'tables' && <TableEditor api={api} />}
          {screen === 'sql' && <SqlConsole api={api} />}
          {screen === 'auth' && <Authentication api={api} />}
          {screen === 'storage' && <Storage api={api} />}
          {screen === 'policies' && <Policies api={api} />}
          {screen === 'apikeys' && <ApiKeys api={api} />}
        </div>
      </main>
    </div>
  );
}
