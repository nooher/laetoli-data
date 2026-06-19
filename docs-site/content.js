/* content.js — page content for the Laetoli Data docs. Each entry:
   { file, title, desc, body(HTML string) }. Helpers keep code blocks +
   callouts consistent. Plain HTML; consumed by build.js. */
'use strict';

let codeSeq = 0;

/** A copy-able code card. `file` is the little filename label. */
function code(file, body) {
  const id = `code-${++codeSeq}`;
  return `        <div class="code-card">
          <div class="code-head">
            <span class="code-dot"></span><span class="code-dot"></span><span class="code-dot"></span>
            <span class="code-file">${file}</span>
            <button class="copy-btn" type="button" data-copy-target="${id}" aria-label="Nakili msimbo">Nakili</button>
          </div>
<pre class="code-block"><code id="${id}">${body}</code></pre>
        </div>`;
}

function note(html, kind) {
  const cls = kind === 'warn' ? 'note warn' : 'note';
  const icon = kind === 'warn'
    ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>`
    : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>`;
  return `        <div class="${cls}"><span class="note-icon" aria-hidden="true">${icon}</span><div>${html}</div></div>`;
}

// Tiny escaper for code bodies (so `<` / `&` render literally).
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =====================================================================
//  HOME / INTRO
// =====================================================================
const home = {
  file: 'index.html',
  title: 'Laetoli Data',
  desc: 'Laetoli Data — a sovereign, self-hostable backend (a Supabase alternative). Postgres + PostgREST + auth + storage + realtime + a drop-in SDK. Runs on a Tanzanian VPS or a Raspberry Pi.',
  body: `        <p class="eyebrow">Sehemu ya stack sovereign ya Laetoli</p>
        <h1>Laetoli Data</h1>
        <p class="lede">A sovereign, self-hostable backend — your own database, auto REST API, auth, storage, realtime, and edge functions. Own your data on Tanzanian soil, or on a Raspberry Pi in a classroom with no internet. <strong>Apache-2.0.</strong></p>

        <ul class="badges">
          <li>Apache-2.0</li>
          <li>Zero-dependency SDK</li>
          <li>Postgres + RLS</li>
          <li>Runs on a Raspberry Pi</li>
          <li>Swahili-aware</li>
        </ul>

        <div class="btn-row">
          <a class="btn btn-primary" href="quick-start.html">Quick start</a>
          <a class="btn btn-ghost" href="https://github.com/nooher/laetoli-data" rel="noopener">GitHub</a>
        </div>

        <h2>What it is</h2>
        <p>Laetoli Data assembles a complete backend out of the proven open stack plus a few lean sovereign services, packaged to run anywhere with a single <code>docker compose up</code>. From an app you talk to it through <strong>@laetoli/data</strong>, a drop-in for the supabase-js subset our apps use — so existing code and RLS migrations port across with a one-line import change.</p>
        <p>Ten things ship in the box:</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Service</th><th>What it does</th></tr></thead>
            <tbody>
              <tr><td><strong>PostgreSQL</strong></td><td>The database. Roles <code>anon</code>, <code>authenticated</code>, <code>laetoli_admin</code>; Row-Level Security via the JWT <code>sub</code> + <code>role</code> claims — the same model as Supabase.</td></tr>
              <tr><td><strong>PostgREST</strong></td><td>Auto REST API over Postgres. Verifies JWTs with the shared secret.</td></tr>
              <tr><td><strong>Auth</strong></td><td>Lean GoTrue-equivalent: sign-up / login (username + password) / anonymous sign-in. Issues HS256 JWTs.</td></tr>
              <tr><td><strong>Storage</strong></td><td>Sovereign object storage — buckets + metadata in Postgres, bytes on a filesystem volume. Public &amp; private buckets, signed URLs.</td></tr>
              <tr><td><strong>Realtime</strong></td><td>Postgres <code>LISTEN/NOTIFY</code> → WebSocket fan-out of row changes.</td></tr>
              <tr><td><strong>Edge Functions</strong></td><td>Operator-provided serverless handlers at <code>/functions/&lt;name&gt;</code>.</td></tr>
              <tr><td><strong>Admin API + Studio</strong></td><td>Schema introspection, SQL console, auth/storage/RLS browsing, and a Vite+React dashboard at <code>/studio/</code>.</td></tr>
              <tr><td><strong>Backups + PITR</strong></td><td>Scheduled <code>pg_dump</code> + retention; optional WAL archiving for point-in-time recovery.</td></tr>
              <tr><td><strong>Observability</strong></td><td>Each service exposes Prometheus <code>/metrics</code> (internal).</td></tr>
              <tr><td><strong>Caddy</strong></td><td>One TLS edge that routes every path to the right service.</td></tr>
            </tbody>
          </table>
        </div>

        <h2>Three reasons it exists</h2>
        <div class="cards">
          <div class="card">
            <div class="card-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v6l9 4 9-4V7"/></svg></div>
            <h3>Sovereignty</h3>
            <p>Your database sits on your server, on your soil. No third party holds the keys — you do. <em>Data yako, ardhi yako.</em></p>
          </div>
          <div class="card">
            <div class="card-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div>
            <h3>Cost saving</h3>
            <p>Run many apps on one server. Pay for the box, not for every project. No per-project SaaS fees.</p>
          </div>
          <div class="card">
            <div class="card-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg></div>
            <h3>The Pi story</h3>
            <p>The whole stack fits on a Raspberry Pi on a classroom LAN, with no internet — <em>"shule ndani ya kisanduku,"</em> a school in a box.</p>
          </div>
        </div>

        ${note(`<p><strong>Not a Supabase rewrite.</strong> We do not reinvent Supabase. Laetoli Data assembles the proven open stack (PostgreSQL + PostgREST) plus a lean sovereign auth/storage/realtime layer and a drop-in client SDK. Because the data model is the same, your Supabase RLS migrations and app code port directly.</p>`)}

        <h2>Where to next</h2>
        <div class="cards">
          <a class="card" href="quick-start.html"><h3>Quick start →</h3><p>From zero to a running backend with the CLI or <code>docker compose up</code>, then <code>createClient</code>.</p></a>
          <a class="card" href="architecture.html"><h3>Architecture →</h3><p>The service map, roles, ports, and the JWT/RLS contract every component targets.</p></a>
          <a class="card" href="database.html"><h3>Database →</h3><p>Query and write through PostgREST with the supabase-shaped query builder.</p></a>
          <a class="card" href="self-hosting.html"><h3>Self-hosting →</h3><p>Deploy on a VPS or a Raspberry Pi; backups, PITR, and observability.</p></a>
        </div>`,
};

// =====================================================================
//  QUICK START
// =====================================================================
const quickStart = {
  file: 'quick-start.html',
  title: 'Quick start',
  desc: 'Get Laetoli Data running with the laetoli-data CLI or docker compose, then connect an app with createClient.',
  body: `        <p class="eyebrow">Anza hapa</p>
        <h1>Quick start</h1>
        <p class="lede">Two ways to a running backend, then one import to use it from an app.</p>

        <h2>Option A — the CLI does the setup</h2>
        <p>The <code>laetoli-data</code> CLI writes a fresh <code>.env</code> (with strong secrets) and starts the stack for you.</p>
        ${code('bash', esc(`# Build the CLI once, then init + up
cd cli && npm install && npm run build
node dist/index.js init      # writes .env with a fresh POSTGRES_PASSWORD + JWT_SECRET
node dist/index.js up         # docker compose up -d`))}
        ${note(`<p><code>init</code> never overwrites an existing <code>.env</code>. See the <a class="inline" href="cli.html">CLI reference</a> for <code>migrate</code>, <code>seed</code>, <code>backup</code>, and more.</p>`)}

        <h2>Option B — by hand</h2>
        ${code('bash', esc(`cp .env.example .env
# Set strong secrets — POSTGRES_PASSWORD and a long JWT_SECRET:
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24)"
echo "JWT_SECRET=$(openssl rand -base64 48)"

docker compose up -d         # Postgres + PostgREST + Auth + Storage + Realtime + Caddy`))}
        <p>A fresh boot ships the full schema (auth, storage, realtime — including a <code>notes</code> example with realtime enabled). On an <em>existing</em> database, apply new schema with <code>node cli/dist/index.js migrate</code>. Enable realtime on your own tables with <code>SELECT realtime.enable('public.my_table');</code>.</p>

        <h2>Connect an app</h2>
        <p>Install the SDK and point <code>createClient</code> at your Caddy endpoint (a VPS or a Pi).</p>
        ${code('app.ts', `<span class="tok-k">import</span> { createClient } <span class="tok-k">from</span> <span class="tok-s">'@laetoli/data'</span>;

<span class="tok-c">// Point at your Laetoli Data endpoint.</span>
<span class="tok-k">const</span> db = <span class="tok-f">createClient</span>(<span class="tok-s">'https://data.yangu.tz'</span>, { apikey: <span class="tok-s">'optional-anon-key'</span> });

<span class="tok-c">// Auth, query, storage, realtime, functions — all from one client:</span>
<span class="tok-k">await</span> db.auth.<span class="tok-f">signUp</span>({ username, password });
<span class="tok-k">await</span> db.<span class="tok-f">from</span>(<span class="tok-s">'notes'</span>).<span class="tok-f">insert</span>({ body: <span class="tok-s">'habari'</span> });
<span class="tok-k">await</span> db.storage.<span class="tok-f">from</span>(<span class="tok-s">'media'</span>).<span class="tok-f">upload</span>(<span class="tok-s">'a.png'</span>, file);
db.<span class="tok-f">channel</span>(<span class="tok-s">'notes'</span>).<span class="tok-f">on</span>(<span class="tok-s">'INSERT'</span>, (e) =&gt; console.<span class="tok-f">log</span>(e.record)).<span class="tok-f">subscribe</span>();
<span class="tok-k">await</span> db.functions.<span class="tok-f">invoke</span>(<span class="tok-s">'hello'</span>, { body: { jina: <span class="tok-s">'Asha'</span> } });`)}

        <h2>Migrating from Supabase</h2>
        <p>The client mirrors the supabase-js subset our apps use, so migration is usually a one-line import swap.</p>
        ${code('migration.diff', `<span class="diff-del">- import { createClient } from '@supabase/supabase-js';</span>
<span class="diff-add">+ import { createClient } from '@laetoli/data';</span>

<span class="diff-del">- const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);</span>
<span class="diff-add">+ const db = createClient(LAETOLI_DATA_URL, { apikey: ANON_KEY });</span>`)}
        ${note(`<p><strong>One difference:</strong> the identifier is <code>username</code>, not <code>email</code>. Result envelopes (<code>{ data, error }</code>) and the <code>from().select/insert/update/delete/eq/order/limit/single</code> chain are otherwise the same.</p>`)}

        <p>Then open the <a class="inline" href="admin.html">Admin Studio</a> at <code>http://localhost:8088/studio/</code> and sign in with your <code>ADMIN_API_KEY</code> to browse tables, run SQL, and manage auth/storage/RLS.</p>`,
};

// =====================================================================
//  ARCHITECTURE
// =====================================================================
const architecture = {
  file: 'architecture.html',
  title: 'Architecture',
  desc: 'The Laetoli Data service map — Caddy routes to PostgREST, auth, storage, realtime, admin, and functions, all backed by one PostgreSQL with a shared JWT secret.',
  body: `        <p class="eyebrow">Anza hapa</p>
        <h1>Architecture</h1>
        <p class="lede">One TLS edge, a handful of small services, one database. A shared HS256 JWT secret ties them together; RLS enforces who sees what.</p>

        <div class="diagram" role="img" aria-label="Service map: a client calls Caddy on ports 80 and 443. Caddy routes /rest to PostgREST, /auth to the auth service, /storage to storage, /realtime to realtime, /admin to the admin API, /functions to functions, and /studio to the Studio dashboard. Every service shares one JWT secret and is backed by PostgreSQL on port 5432, where RLS is enforced via the JWT sub and role claims.">
          <svg viewBox="0 0 640 430" xmlns="http://www.w3.org/2000/svg" class="diagram-svg" aria-hidden="true" focusable="false">
            <rect x="260" y="12" width="120" height="40" rx="9" fill="#0F2A1D"/>
            <text x="320" y="37" text-anchor="middle" class="d-label-light">client / app</text>
            <line x1="320" y1="52" x2="320" y2="74" stroke="#7C8B7E" stroke-width="2"/>
            <polygon points="320,80 315,70 325,70" fill="#7C8B7E"/>
            <rect x="40" y="80" width="560" height="52" rx="11" fill="#E0A93B"/>
            <text x="320" y="103" text-anchor="middle" class="d-label-dark d-strong">Caddy · 80 / 443 · TLS edge</text>
            <text x="320" y="121" text-anchor="middle" class="d-label-dark d-small">/rest · /auth · /storage · /realtime · /admin · /functions · /studio</text>
            <g>
              <rect x="24" y="176" width="118" height="56" rx="9" fill="#1C4332"/>
              <text x="83" y="199" text-anchor="middle" class="d-label-light d-strong">PostgREST</text>
              <text x="83" y="216" text-anchor="middle" class="d-label-light d-small">:3000 · REST</text>
              <rect x="150" y="176" width="118" height="56" rx="9" fill="#1C4332"/>
              <text x="209" y="199" text-anchor="middle" class="d-label-light d-strong">Auth</text>
              <text x="209" y="216" text-anchor="middle" class="d-label-light d-small">:9999 · JWT</text>
              <rect x="276" y="176" width="118" height="56" rx="9" fill="#1C4332"/>
              <text x="335" y="199" text-anchor="middle" class="d-label-light d-strong">Storage</text>
              <text x="335" y="216" text-anchor="middle" class="d-label-light d-small">:9998 · files</text>
              <rect x="402" y="176" width="100" height="56" rx="9" fill="#1C4332"/>
              <text x="452" y="199" text-anchor="middle" class="d-label-light d-strong">Realtime</text>
              <text x="452" y="216" text-anchor="middle" class="d-label-light d-small">:9997 · WS</text>
              <rect x="510" y="176" width="106" height="56" rx="9" fill="#1C4332"/>
              <text x="563" y="195" text-anchor="middle" class="d-label-light d-strong">Admin</text>
              <text x="563" y="210" text-anchor="middle" class="d-label-light d-small">:9996</text>
              <text x="563" y="224" text-anchor="middle" class="d-label-light d-small">Functions :9995</text>
            </g>
            <line x1="320" y1="132" x2="320" y2="160" stroke="#7C8B7E" stroke-width="2"/>
            <polygon points="320,166 315,156 325,156" fill="#7C8B7E"/>
            <text x="320" y="270" text-anchor="middle" class="d-note">shared JWT secret (HS256)</text>
            <line x1="320" y1="232" x2="320" y2="296" stroke="#7C8B7E" stroke-width="2"/>
            <polygon points="320,302 315,292 325,292" fill="#7C8B7E"/>
            <rect x="40" y="302" width="560" height="64" rx="11" fill="#0F2A1D"/>
            <text x="320" y="328" text-anchor="middle" class="d-label-light d-strong">PostgreSQL · :5432</text>
            <text x="320" y="348" text-anchor="middle" class="d-label-light d-small">roles: anon · authenticated · laetoli_admin · laetoli_storage · laetoli_realtime · RLS via JWT sub + role</text>
            <text x="320" y="392" text-anchor="middle" class="d-note">backup + PITR :9994 · /metrics (internal)</text>
          </svg>
        </div>

        <h2>The contract</h2>
        <p>Every component targets the same shape: <strong>PostgreSQL is the source of truth</strong>, and a single <strong>HS256 JWT secret</strong> is shared by the services. PostgREST verifies tokens with it; the auth service signs with it. RLS reads the JWT <code>sub</code> (user id) and <code>role</code> claims, so the security model is identical to Supabase and migrations port directly.</p>

        <h2>The services</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Service</th><th>Port</th><th>Path via Caddy</th><th>Notes</th></tr></thead>
            <tbody>
              <tr><td>PostgreSQL</td><td>5432</td><td>—</td><td>Database. Don't publish 5432 to the internet.</td></tr>
              <tr><td>PostgREST</td><td>3000</td><td><code>/rest/*</code></td><td>Auto REST API; anon role <code>anon</code>.</td></tr>
              <tr><td>Auth (Node/Express)</td><td>9999</td><td><code>/auth/*</code></td><td>signup / login / anonymous; HS256 JWTs.</td></tr>
              <tr><td>Storage (Node/Express)</td><td>9998</td><td><code>/storage/*</code></td><td>Buckets in Postgres, bytes on a filesystem volume.</td></tr>
              <tr><td>Realtime (Node/ws)</td><td>9997</td><td><code>/realtime</code></td><td><code>LISTEN/NOTIFY</code> → WebSocket fan-out.</td></tr>
              <tr><td>Admin API (Node/Express)</td><td>9996</td><td><code>/admin/*</code></td><td>Connects as <code>laetoli_admin_login</code> (BYPASSRLS); gated by <code>ADMIN_API_KEY</code>.</td></tr>
              <tr><td>Functions (Node)</td><td>9995</td><td><code>/functions/*</code></td><td>Operator-provided handlers; per-invocation timeout.</td></tr>
              <tr><td>Admin Studio (Vite+React)</td><td>—</td><td><code>/studio/*</code></td><td>The dashboard; paste <code>ADMIN_API_KEY</code> to sign in.</td></tr>
              <tr><td>Backup + PITR</td><td>9994</td><td>—</td><td>Scheduled <code>pg_dump</code> + retention; <code>/status</code> + <code>/health</code>.</td></tr>
              <tr><td>Caddy</td><td>80 / 443</td><td>—</td><td>Single TLS endpoint; auto Let's Encrypt with a domain.</td></tr>
            </tbody>
          </table>
        </div>

        <h2>Roles</h2>
        <ul>
          <li><code>anon</code> — the unauthenticated role PostgREST uses when there's no (or an anon) token.</li>
          <li><code>authenticated</code> — the role a signed-in user's JWT carries.</li>
          <li><code>laetoli_admin</code> — the elevated, <code>BYPASSRLS</code> capability role. It is <code>NOLOGIN</code> by design; the admin service connects as the dedicated <code>laetoli_admin_login</code> account which inherits its privileges and adds <code>BYPASSRLS</code>.</li>
          <li><code>laetoli_storage</code> · <code>laetoli_realtime</code> — dedicated login roles the storage and realtime services connect as.</li>
        </ul>
        ${note(`<p><strong>Why a separate <code>laetoli_admin_login</code>?</strong> Keeping the powerful <code>laetoli_admin</code> role <code>NOLOGIN</code> is good hygiene — it stays a pure capability role. The login account inherits its object privileges; <code>BYPASSRLS</code> is an attribute (not inherited via membership), so it's set explicitly on the login role. Only the admin service holds its credentials, and that service is itself gated by <code>ADMIN_API_KEY</code>.</p>`)}`,
};

// =====================================================================
//  AUTH
// =====================================================================
const auth = {
  file: 'auth.html',
  title: 'Auth',
  desc: 'Laetoli Data auth — signUp, signInWithPassword, signInAnonymously, getUser, signOut. HS256 JWTs and the RLS model.',
  body: `        <p class="eyebrow">SDK · @laetoli/data</p>
        <h1>Auth</h1>
        <p class="lede">A lean, sovereign auth service: username + password, plus anonymous sign-in. It issues HS256 JWTs whose claims drive Row-Level Security.</p>

        <h2>Sign up &amp; sign in</h2>
        <p>Every method returns a supabase-shaped envelope — <code>{ data: { user, session }, error }</code>. The token is persisted automatically (localStorage in the browser, in-memory in Node) and attached to subsequent REST/storage/realtime calls.</p>
        ${code('auth.ts', `<span class="tok-k">const</span> db = <span class="tok-f">createClient</span>(URL, { apikey: ANON });

<span class="tok-c">// Create an account (identifier is username, not email).</span>
<span class="tok-k">await</span> db.auth.<span class="tok-f">signUp</span>({ username: <span class="tok-s">'naim'</span>, password: <span class="tok-s">'••••••••'</span> });

<span class="tok-c">// Log in with username + password.</span>
<span class="tok-k">await</span> db.auth.<span class="tok-f">signInWithPassword</span>({ username: <span class="tok-s">'naim'</span>, password: <span class="tok-s">'••••••••'</span> });

<span class="tok-c">// Anonymous session — a real JWT, no credentials. Great for the Pi/classroom.</span>
<span class="tok-k">await</span> db.auth.<span class="tok-f">signInAnonymously</span>();`)}

        <h2>The current user &amp; sign-out</h2>
        ${code('session.ts', `<span class="tok-c">// Resolve the signed-in user from the stored token (null if signed out).</span>
<span class="tok-k">const</span> { data: { user } } = <span class="tok-k">await</span> db.auth.<span class="tok-f">getUser</span>();
<span class="tok-c">// user => { id, username?, role?, is_anonymous? }</span>

<span class="tok-c">// Clear the local session (best-effort server-side revoke).</span>
<span class="tok-k">await</span> db.auth.<span class="tok-f">signOut</span>();

<span class="tok-c">// React to sign-in / sign-out, supabase-style.</span>
<span class="tok-k">const</span> { data: { subscription } } = db.auth.<span class="tok-f">onAuthStateChange</span>((event, session) =&gt; {
  <span class="tok-c">// event: 'INITIAL_SESSION' | 'SIGNED_IN' | 'SIGNED_OUT'</span>
  console.<span class="tok-f">log</span>(event, session?.user);
});
<span class="tok-c">// later: subscription.unsubscribe();</span>`)}

        <h2>The JWT &amp; RLS model</h2>
        <p>The auth service signs HS256 tokens with the shared <code>JWT_SECRET</code>, carrying claims <code>{ sub, role, exp }</code>. PostgREST verifies the same secret, so the token a user holds <em>is</em> their database identity:</p>
        <ul>
          <li><strong><code>sub</code></strong> — the user id. RLS policies compare it against an owner column (e.g. <code>user_id = auth.uid()</code>).</li>
          <li><strong><code>role</code></strong> — <code>authenticated</code> for a signed-in user, <code>anon</code> for anonymous.</li>
          <li><strong><code>exp</code></strong> — expiry; <code>JWT_EXPIRY</code> (default 3600s) controls token lifetime.</li>
        </ul>
        ${code('policy.sql', esc(`-- The owner-scoped pattern (from the demo public.notes table):
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY notes_owner ON public.notes
  USING       (user_id = auth.uid())   -- can read own rows
  WITH CHECK  (user_id = auth.uid());  -- can only write own rows`))}
        ${note(`<p>Because the model matches Supabase exactly, existing RLS migrations port across unchanged. <code>auth.uid()</code> reads the <code>sub</code> claim from the request's verified JWT.</p>`)}
        ${note(`<p><strong>Keep the secret safe.</strong> <code>JWT_SECRET</code> must be identical across the auth service and PostgREST and at least 32 characters. Losing it means you can't verify already-issued tokens; rotating it invalidates every live session.</p>`, 'warn')}`,
};

// =====================================================================
//  DATABASE / POSTGREST
// =====================================================================
const database = {
  file: 'database.html',
  title: 'Database / PostgREST',
  desc: 'Query and write through PostgREST with the supabase-shaped query builder — select, insert, update, delete, eq, order, limit, single.',
  body: `        <p class="eyebrow">SDK · @laetoli/data</p>
        <h1>Database / PostgREST</h1>
        <p class="lede">Talk to your tables and views through PostgREST with a chainable, thenable query builder that mirrors the supabase-js subset.</p>

        <h2>Reading</h2>
        <p>Start with <code>db.from(table)</code>, then chain projection, filters, ordering, and limits. The builder is awaitable — it resolves <code>{ data, error, status, statusText }</code>.</p>
        ${code('select.ts', `<span class="tok-k">const</span> { data, error } = <span class="tok-k">await</span> db
  .<span class="tok-f">from</span>(<span class="tok-s">'works'</span>)
  .<span class="tok-f">select</span>(<span class="tok-s">'id, title, author_id'</span>)
  .<span class="tok-f">eq</span>(<span class="tok-s">'type'</span>, <span class="tok-s">'pulse'</span>)
  .<span class="tok-f">order</span>(<span class="tok-s">'created_at'</span>, { ascending: <span class="tok-k">false</span> })
  .<span class="tok-f">limit</span>(<span class="tok-s">20</span>);

<span class="tok-c">// Exactly one row (errors if not exactly 1):</span>
<span class="tok-k">const</span> one = <span class="tok-k">await</span> db.<span class="tok-f">from</span>(<span class="tok-s">'works'</span>).<span class="tok-f">select</span>().<span class="tok-f">eq</span>(<span class="tok-s">'id'</span>, id).<span class="tok-f">single</span>();
<span class="tok-c">// Zero-or-one (no error on 0 rows):</span>
<span class="tok-k">const</span> maybe = <span class="tok-k">await</span> db.<span class="tok-f">from</span>(<span class="tok-s">'works'</span>).<span class="tok-f">select</span>().<span class="tok-f">eq</span>(<span class="tok-s">'id'</span>, id).<span class="tok-f">maybeSingle</span>();`)}

        <h2>Writing</h2>
        <p>Insert / update / delete return the affected rows (PostgREST <code>Prefer: return=representation</code> is set for you). Chain <code>.select()</code> to shape what comes back.</p>
        ${code('write.ts', `<span class="tok-c">// Insert (one row or an array of rows)</span>
<span class="tok-k">await</span> db.<span class="tok-f">from</span>(<span class="tok-s">'notes'</span>).<span class="tok-f">insert</span>({ body: <span class="tok-s">'habari'</span> });

<span class="tok-c">// Update matching rows</span>
<span class="tok-k">await</span> db.<span class="tok-f">from</span>(<span class="tok-s">'notes'</span>).<span class="tok-f">update</span>({ body: <span class="tok-s">'mpya'</span> }).<span class="tok-f">eq</span>(<span class="tok-s">'id'</span>, id);

<span class="tok-c">// Delete matching rows</span>
<span class="tok-k">await</span> db.<span class="tok-f">from</span>(<span class="tok-s">'notes'</span>).<span class="tok-f">delete</span>().<span class="tok-f">eq</span>(<span class="tok-s">'id'</span>, id);`)}

        <h2>Filters &amp; shaping</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Method</th><th>Meaning</th></tr></thead>
            <tbody>
              <tr><td><code>eq / neq</code></td><td>equals / not equals</td></tr>
              <tr><td><code>gt / gte / lt / lte</code></td><td>greater/less than (or equal)</td></tr>
              <tr><td><code>like / ilike</code></td><td>pattern match (case-sensitive / insensitive)</td></tr>
              <tr><td><code>is(col, null|true|false)</code></td><td><code>IS</code> null / boolean</td></tr>
              <tr><td><code>in(col, [a, b])</code></td><td>value in a set</td></tr>
              <tr><td><code>order(col, { ascending, nullsFirst })</code></td><td>sort</td></tr>
              <tr><td><code>limit(n)</code> · <code>range(from, to)</code></td><td>page (range is inclusive)</td></tr>
              <tr><td><code>single()</code> · <code>maybeSingle()</code></td><td>return one object instead of an array</td></tr>
            </tbody>
          </table>
        </div>
        ${code('filters.ts', `<span class="tok-k">await</span> db.<span class="tok-f">from</span>(<span class="tok-s">'works'</span>)
  .<span class="tok-f">select</span>(<span class="tok-s">'id, title'</span>)
  .<span class="tok-f">ilike</span>(<span class="tok-s">'title'</span>, <span class="tok-s">'%samaki%'</span>)
  .<span class="tok-f">in</span>(<span class="tok-s">'status'</span>, [<span class="tok-s">'published'</span>, <span class="tok-s">'review'</span>])
  .<span class="tok-f">order</span>(<span class="tok-s">'created_at'</span>, { ascending: <span class="tok-k">false</span> })
  .<span class="tok-f">range</span>(<span class="tok-s">0</span>, <span class="tok-s">9</span>);   <span class="tok-c">// first 10 rows</span>`)}

        <h2>The result envelope &amp; errors</h2>
        ${code('errors.ts', `<span class="tok-k">const</span> { data, error, status } = <span class="tok-k">await</span> db.<span class="tok-f">from</span>(<span class="tok-s">'works'</span>).<span class="tok-f">select</span>();
<span class="tok-k">if</span> (error) {
  <span class="tok-c">// error => { message, details?, hint?, code? }</span>
  console.<span class="tok-f">error</span>(error.message, error.code);
} <span class="tok-k">else</span> {
  <span class="tok-c">// data => rows (or a single object after .single())</span>
}`)}

        <h2>RLS in practice</h2>
        <p>Every request carries the signed-in user's bearer (or the anon apikey). PostgREST runs the query under that identity, so <strong>RLS is your authorization layer</strong> — policies decide which rows the query can touch. See <a class="inline" href="auth.html">Auth</a> for the owner-scoped policy pattern.</p>
        ${note(`<p>Need more schemas exposed? <code>PGRST_DB_SCHEMAS</code> defaults to <code>public</code>; comma-separate to expose more.</p>`)}`,
};

// =====================================================================
//  STORAGE
// =====================================================================
const storage = {
  file: 'storage.html',
  title: 'Storage',
  desc: 'Sovereign object storage — upload, download, list, signed URLs. Public vs private buckets, filesystem-backed.',
  body: `        <p class="eyebrow">SDK · @laetoli/data</p>
        <h1>Storage</h1>
        <p class="lede">Sovereign object storage: bucket + object metadata live in Postgres (with RLS), the bytes live on a filesystem volume — no MinIO/S3, lighter on a Pi.</p>

        <h2>Working with files</h2>
        <p>Get a bucket handle with <code>db.storage.from(bucket)</code>, then upload, download, list, or remove. All methods return the <code>{ data, error }</code> envelope.</p>
        ${code('storage.ts', `<span class="tok-k">const</span> bucket = db.storage.<span class="tok-f">from</span>(<span class="tok-s">'media'</span>);

<span class="tok-c">// Upload bytes (Blob | ArrayBuffer | Uint8Array | string).</span>
<span class="tok-k">await</span> bucket.<span class="tok-f">upload</span>(<span class="tok-s">'covers/a.png'</span>, file, { contentType: <span class="tok-s">'image/png'</span> });

<span class="tok-c">// Download an object's bytes as a Blob.</span>
<span class="tok-k">const</span> { data: blob } = <span class="tok-k">await</span> bucket.<span class="tok-f">download</span>(<span class="tok-s">'covers/a.png'</span>);

<span class="tok-c">// List objects (optional path prefix).</span>
<span class="tok-k">const</span> { data: objects } = <span class="tok-k">await</span> bucket.<span class="tok-f">list</span>(<span class="tok-s">'covers/'</span>);

<span class="tok-c">// Remove one or more objects.</span>
<span class="tok-k">await</span> bucket.<span class="tok-f">remove</span>([<span class="tok-s">'covers/a.png'</span>]);`)}

        <h2>Public vs private</h2>
        <p>A <strong>public</strong> bucket serves objects by URL with no auth — build the link synchronously. A <strong>private</strong> bucket requires a time-limited signed URL.</p>
        ${code('urls.ts', `<span class="tok-c">// PUBLIC bucket — synchronous, no network call, no auth.</span>
<span class="tok-k">const</span> { publicUrl } = db.storage.<span class="tok-f">from</span>(<span class="tok-s">'public-media'</span>).<span class="tok-f">getPublicUrl</span>(<span class="tok-s">'logo.png'</span>);

<span class="tok-c">// PRIVATE bucket — a signed URL valid for N seconds.</span>
<span class="tok-k">const</span> { data } = <span class="tok-k">await</span> db.storage
  .<span class="tok-f">from</span>(<span class="tok-s">'receipts'</span>)
  .<span class="tok-f">createSignedUrl</span>(<span class="tok-s">'2026/06/r-1.pdf'</span>, <span class="tok-s">3600</span>); <span class="tok-c">// data.signedUrl</span>`)}

        <h2>Managing buckets</h2>
        ${code('buckets.ts', `<span class="tok-k">await</span> db.storage.<span class="tok-f">createBucket</span>(<span class="tok-s">'media'</span>, { public: <span class="tok-k">true</span> });
<span class="tok-k">const</span> { data: buckets } = <span class="tok-k">await</span> db.storage.<span class="tok-f">listBuckets</span>();
<span class="tok-k">await</span> db.storage.<span class="tok-f">deleteBucket</span>(<span class="tok-s">'media'</span>);`)}

        <h2>Object metadata</h2>
        <p>Uploads and listings return <code>ObjectMeta</code> rows:</p>
        ${code('meta.ts', `<span class="tok-k">interface</span> <span class="tok-f">ObjectMeta</span> {
  name: <span class="tok-f">string</span>; bucket: <span class="tok-f">string</span>; path: <span class="tok-f">string</span>;
  size: <span class="tok-f">number</span>; mime: <span class="tok-f">string</span>; owner: <span class="tok-f">string</span>;
  created_at: <span class="tok-f">string</span>; updated_at: <span class="tok-f">string</span>;
}`)}
        ${note(`<p>Writes are owner-scoped and metadata is governed by RLS in the <code>storage</code> schema, so signed-in users only touch their own objects unless a policy says otherwise.</p>`)}`,
};

// =====================================================================
//  REALTIME
// =====================================================================
const realtime = {
  file: 'realtime.html',
  title: 'Realtime',
  desc: 'Subscribe to row changes over WebSocket — channel(table).on(event, cb).subscribe(). Enable per table with realtime.enable(). Read the table-level RLS caveat.',
  body: `        <p class="eyebrow">SDK · @laetoli/data</p>
        <h1>Realtime</h1>
        <p class="lede">Postgres <code>LISTEN/NOTIFY</code> fanned out over a single multiplexed WebSocket. Subscribe by table, optionally with an equality filter; the socket auto-reconnects.</p>

        <h2>Subscribe</h2>
        ${code('realtime.ts', `<span class="tok-k">const</span> channel = db
  .<span class="tok-f">channel</span>(<span class="tok-s">'notes'</span>)
  .<span class="tok-f">on</span>(<span class="tok-s">'INSERT'</span>, (p) =&gt; console.<span class="tok-f">log</span>(<span class="tok-s">'new'</span>, p.record))
  .<span class="tok-f">on</span>(<span class="tok-s">'UPDATE'</span>, (p) =&gt; console.<span class="tok-f">log</span>(<span class="tok-s">'changed'</span>, p.record, p.old))
  .<span class="tok-f">on</span>(<span class="tok-s">'DELETE'</span>, (p) =&gt; console.<span class="tok-f">log</span>(<span class="tok-s">'gone'</span>, p.old))
  .<span class="tok-f">subscribe</span>();

<span class="tok-c">// With a server-side equality filter (only my rows):</span>
db.<span class="tok-f">channel</span>(<span class="tok-s">'notes'</span>)
  .<span class="tok-f">on</span>(<span class="tok-s">'*'</span>, (p) =&gt; render(p), { column: <span class="tok-s">'user_id'</span>, value: me })
  .<span class="tok-f">subscribe</span>();

<span class="tok-c">// later:</span>
channel.<span class="tok-f">unsubscribe</span>();`)}
        <p>Each callback receives a <code>RealtimeChange</code>:</p>
        ${code('payload.ts', `<span class="tok-k">interface</span> <span class="tok-f">RealtimeChange</span> {
  channel: <span class="tok-f">string</span>;
  event: <span class="tok-s">'INSERT'</span> | <span class="tok-s">'UPDATE'</span> | <span class="tok-s">'DELETE'</span>;
  record: <span class="tok-f">Record</span>&lt;string, unknown&gt; | <span class="tok-k">null</span>;  <span class="tok-c">// the new row (INSERT/UPDATE)</span>
  old: <span class="tok-f">Record</span>&lt;string, unknown&gt; | <span class="tok-k">null</span>;     <span class="tok-c">// the prior row (UPDATE/DELETE)</span>
  truncated?: <span class="tok-f">boolean</span>;  <span class="tok-c">// payload exceeded the 8KB NOTIFY cap — re-fetch the row</span>
}`)}

        <h2>Enable realtime on a table</h2>
        <p>A fresh boot enables realtime on the demo <code>public.notes</code>. For your own tables, attach the trigger once (operator step):</p>
        ${code('enable.sql', esc(`SELECT realtime.enable('public.my_table');   -- attach the change trigger
SELECT realtime.disable('public.my_table');  -- detach it`))}

        ${note(`<p><strong>RLS caveat — read this (v1 scope).</strong> Fan-out is <strong>table-level, not per-subscriber row-level</strong>. The service broadcasts a table's changes to every client subscribed to that table; it does not re-evaluate each table's RLS policy per connected user. Only enable realtime on tables whose rows are safe for any subscriber to see, or use the equality <code>filter</code> — but note a filter is a convenience, not a security boundary.</p><p>For owner-private tables, treat the stream as a "something changed" hint and re-fetch the actual rows over PostgREST, which <em>does</em> enforce RLS. Per-subscriber RLS is a v2 item.</p>`, 'warn')}

        ${note(`<p><strong>The 8KB cap.</strong> Postgres aborts <code>NOTIFY</code> payloads over 8000 bytes. When a change would exceed a safe budget the service drops the heavy <code>record</code>/<code>old</code> bodies, sends just the id plus <code>truncated: true</code>, and you re-fetch the row via PostgREST (subject to RLS).</p>`)}`,
};

// =====================================================================
//  EDGE FUNCTIONS
// =====================================================================
const functions = {
  file: 'functions.html',
  title: 'Edge Functions',
  desc: 'Author serverless handlers, invoke them with functions.invoke(name, { body }), and the ctx shape.',
  body: `        <p class="eyebrow">SDK · @laetoli/data</p>
        <h1>Edge Functions</h1>
        <p class="lede">Operator-provided serverless handlers, served behind Caddy at <code>/functions/&lt;name&gt;</code>. A function default-exports an async handler that takes a <code>ctx</code> and returns JSON (or a Response-like object).</p>

        <h2>Author a handler</h2>
        <p>Drop a <code>.ts</code>/<code>.js</code> file into the functions root. The filename becomes the route. Return a bare value for a <code>200</code> JSON response, or a <code>{ status, headers, body }</code> envelope for full control.</p>
        ${code('functions/src/hello.ts', `<span class="tok-c">// GET /functions/hello?jina=Asha</span>
<span class="tok-k">export default async function</span> <span class="tok-f">hello</span>(ctx) {
  <span class="tok-k">const</span> jina = <span class="tok-k">typeof</span> ctx.query.jina === <span class="tok-s">'string'</span> ? ctx.query.jina : <span class="tok-s">'Dunia'</span>;
  <span class="tok-k">return</span> { message: <span class="tok-s">'Habari, '</span> + jina };   <span class="tok-c">// bare value → 200 application/json</span>
}`)}
        ${code('functions/src/whoami.ts', `<span class="tok-c">// GET /functions/whoami  (needs a valid Bearer token)</span>
<span class="tok-k">export default async function</span> <span class="tok-f">whoami</span>(ctx) {
  <span class="tok-k">if</span> (!ctx.user) <span class="tok-k">return</span> { status: <span class="tok-s">401</span>, body: { error: <span class="tok-s">'Hujaingia.'</span> } };
  <span class="tok-k">return</span> ctx.user;                          <span class="tok-c">// { sub, role }</span>
}`)}

        <h2>Invoke from an app</h2>
        ${code('invoke.ts', `<span class="tok-k">const</span> { data, error } = <span class="tok-k">await</span> db.functions.<span class="tok-f">invoke</span>(<span class="tok-s">'hello'</span>, {
  body: { jina: <span class="tok-s">'Asha'</span> },   <span class="tok-c">// objects are JSON-encoded; strings sent as-is</span>
  method: <span class="tok-s">'POST'</span>,           <span class="tok-c">// defaults to POST</span>
});
<span class="tok-c">// The signed-in bearer is attached automatically when present.</span>`)}

        <h2>The context (<code>ctx</code>)</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Field</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td><code>ctx.method</code></td><td>HTTP method (<code>GET</code>, <code>POST</code>, …)</td></tr>
              <tr><td><code>ctx.headers</code></td><td>lower-cased request headers</td></tr>
              <tr><td><code>ctx.query</code></td><td>parsed query string (<code>{ jina: 'Asha' }</code>)</td></tr>
              <tr><td><code>ctx.body</code></td><td>parsed JSON body (or raw text for non-JSON)</td></tr>
              <tr><td><code>ctx.env</code></td><td>environment bag (<code>ctx.env.MY_SETTING</code>)</td></tr>
              <tr><td><code>ctx.user</code></td><td><code>{ sub, role }</code> if a valid Bearer is present, else <code>null</code></td></tr>
              <tr><td><code>ctx.path</code></td><td>trailing path after <code>/&lt;name&gt;</code> (e.g. <code>/a/b</code>), or <code>""</code></td></tr>
              <tr><td><code>ctx.signal</code></td><td>an <code>AbortSignal</code> that fires when the timeout is reached</td></tr>
            </tbody>
          </table>
        </div>
        <p>For editor types: <code>import type { FunctionContext, FunctionResult } from '@laetoli/functions';</code></p>

        <h2>Return shapes &amp; behaviour</h2>
        <ul>
          <li><strong>Bare JSON value</strong> (object, array, string, number…) → <code>200</code> JSON.</li>
          <li><strong><code>{ status?, headers?, body }</code></strong> → that exact status/headers/body.</li>
          <li><strong><code>undefined</code></strong> → <code>204 No Content</code>.</li>
          <li>Exceeding <code>FUNCTION_TIMEOUT_MS</code> (default 10000) → <code>504</code>; a thrown error → a clean <code>500</code>.</li>
        </ul>

        ${note(`<p><strong>Trust model.</strong> Functions are operator-provided and <em>trusted</em> — they run in the same Node process as the runner (no sandbox). Only deploy code you wrote or audited. Today's guarantees are a per-invocation timeout and a request body-size cap, not isolation; stronger isolation is a planned v2 option.</p>`, 'warn')}`,
};

// =====================================================================
//  ADMIN & STUDIO
// =====================================================================
const admin = {
  file: 'admin.html',
  title: 'Admin & Studio',
  desc: 'The admin API and the /studio/ dashboard — table editor, SQL console, auth/storage/RLS browsing, gated by ADMIN_API_KEY.',
  body: `        <p class="eyebrow">Operate · Endesha</p>
        <h1>Admin &amp; Studio</h1>
        <p class="lede">A sovereign dashboard for your backend — browse tables, run SQL, manage auth and storage, and read RLS policies. No SaaS console, no telemetry leaving your box.</p>

        <h2>The Admin Studio</h2>
        <p>The Studio is a Vite+React app served behind Caddy at <code>/studio/</code>. Open it and paste your <code>ADMIN_API_KEY</code> to sign in.</p>
        ${code('open-studio', `http://localhost:8088/studio/`)}
        <p>It gives you:</p>
        <ul>
          <li><strong>Table Editor</strong> — browse and edit rows.</li>
          <li><strong>SQL Console</strong> — run arbitrary SQL.</li>
          <li><strong>Auth</strong> — view users in <code>auth.users</code>.</li>
          <li><strong>Storage browser</strong> — buckets and objects.</li>
          <li><strong>RLS Policies viewer</strong> — see the policies on each table.</li>
          <li><strong>Stats</strong> — at-a-glance counts and sizes.</li>
        </ul>

        <h2>The admin API</h2>
        <p>Behind the Studio is the admin service (<code>/admin/*</code>, port 9996): schema introspection, table CRUD, the SQL console, RLS-policy / roles / users / storage browsing, and <code>/stats</code>. Every request is gated by the <code>ADMIN_API_KEY</code> "service-role key".</p>
        ${code('admin-api.sh', esc(`# All admin calls carry the service-role key.
curl https://data.yourorg.tz/admin/stats \\
  -H "Authorization: Bearer $ADMIN_API_KEY"

curl -X POST https://data.yourorg.tz/admin/sql \\
  -H "Authorization: Bearer $ADMIN_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"sql":"select count(*) from public.notes"}'`))}

        ${note(`<p><strong>The keys to the kingdom.</strong> The admin service connects to Postgres as <code>laetoli_admin_login</code>, which <code>BYPASSRLS</code> — it sees every row. Guard <code>ADMIN_API_KEY</code> like a root password: keep it server-side, never ship it to a browser app, and rotate it if exposed.</p>`, 'warn')}`,
};

// =====================================================================
//  CLI
// =====================================================================
const cli = {
  file: 'cli.html',
  title: 'CLI',
  desc: 'The laetoli-data CLI — init, up, down, status, migrate, seed, backup, restore, secret.',
  body: `        <p class="eyebrow">Operate · Endesha</p>
        <h1>CLI · <code>laetoli-data</code></h1>
        <p class="lede">A small, dependency-light command line that handles setup, the stack lifecycle, migrations, seeds, and backups.</p>

        <h2>Build it once</h2>
        ${code('bash', esc(`cd cli && npm install && npm run build
node dist/index.js <command>     # (symlink dist/index.js as "laetoli-data" for the short form)`))}

        <h2>Commands</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Command</th><th>What it does</th></tr></thead>
            <tbody>
              <tr><td><code>init</code></td><td>Create <code>.env</code> with a fresh <code>POSTGRES_PASSWORD</code> + <code>JWT_SECRET</code> (never overwrites an existing one).</td></tr>
              <tr><td><code>up</code> / <code>down</code></td><td>Start / stop the stack. <code>down -- -v</code> also wipes the data volume.</td></tr>
              <tr><td><code>status</code></td><td>Container status, plus a health probe of the public URL (<code>/rest/</code> and <code>/auth/health</code>).</td></tr>
              <tr><td><code>migrate</code> / <code>migrate --status</code></td><td>Apply pending <code>db/migrations/*.sql</code> — transactional and checksum-guarded.</td></tr>
              <tr><td><code>seed</code></td><td>Run <code>db/seed/*.sql</code>.</td></tr>
              <tr><td><code>backup [--out f]</code></td><td><code>pg_dump</code> via Docker (timestamped file under <code>backups/</code> by default).</td></tr>
              <tr><td><code>restore &lt;f&gt; --force</code></td><td>Restore a dump (requires <code>--force</code> — it overwrites existing data).</td></tr>
              <tr><td><code>secret</code></td><td>Print a strong random secret (<code>--bytes N</code> to size it).</td></tr>
            </tbody>
          </table>
        </div>

        <h2>A typical session</h2>
        ${code('bash', esc(`laetoli-data init          # fresh .env with secrets
laetoli-data up            # docker compose up -d
laetoli-data status        # everything healthy?
laetoli-data migrate       # apply pending migrations
laetoli-data backup        # pg_dump -> backups/laetoli_2026-06-19_02-30-00.sql`))}

        ${note(`<p>Migrations are <strong>checksum-guarded</strong>: an already-applied file that later changes is rejected (you must add a <em>new</em> migration instead of editing a shipped one). <code>migrate --status</code> shows applied vs pending without changing anything.</p>`)}

        <p>The CLI speaks Swahili first (with English in parentheses) in its output — consistent with the rest of the stack.</p>`,
};

// =====================================================================
//  SELF-HOSTING
// =====================================================================
const selfHosting = {
  file: 'self-hosting.html',
  title: 'Self-hosting',
  desc: 'Deploy Laetoli Data on a Tanzanian VPS or a Raspberry Pi; backups, point-in-time recovery, and observability.',
  body: `        <p class="eyebrow">Operate · Endesha</p>
        <h1>Self-hosting</h1>
        <p class="lede">The same stack runs on a national-scale VPS and on a Raspberry Pi in a classroom. Same compose file, same <code>.env</code>, same data model — a Pi pilot ports straight to a server with a <code>pg_dump</code>/restore.</p>

        <h2>On a Tanzanian VPS</h2>
        <p>Take a fresh 64-bit Linux VPS (Ubuntu 22.04/24.04, 1 GB RAM minimum) to a TLS-secured backend:</p>
        ${code('vps.sh', esc(`# 1. Install Docker + the Compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"     # log out/in to apply
sudo ufw allow 80,443/tcp && sudo ufw enable

# 2. Get the code + configure secrets
git clone <your-laetoli-data-repo> laetoli-data && cd laetoli-data
cp .env.example .env
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24)"
echo "JWT_SECRET=$(openssl rand -base64 48)"   # paste both into .env

# 3. Bring it up
docker compose up -d
docker compose ps`))}
        <p>For public HTTPS, set a DNS <strong>A record</strong> to the VPS IP, then in <code>.env</code> set <code>CADDY_DOMAIN=data.yourorg.tz</code> with <code>CADDY_HTTP=80</code> and <code>CADDY_HTTPS=443</code>. Caddy obtains and renews a Let's Encrypt certificate automatically. Key variables:</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Variable</th><th>Purpose</th></tr></thead>
            <tbody>
              <tr><td><code>POSTGRES_PASSWORD</code></td><td>DB password; also the secret for the PostgREST + auth login roles.</td></tr>
              <tr><td><code>JWT_SECRET</code></td><td>Shared HS256 secret — auth signs, PostgREST verifies. Must be identical, ≥ 32 chars.</td></tr>
              <tr><td><code>JWT_EXPIRY</code></td><td>Token lifetime in seconds (default 3600).</td></tr>
              <tr><td><code>CADDY_DOMAIN</code></td><td>Your domain → enables automatic HTTPS. Leave blank for local/LAN HTTP.</td></tr>
              <tr><td><code>LAETOLI_DATA_URL</code></td><td>The public base URL apps point at.</td></tr>
              <tr><td><code>ADMIN_API_KEY</code></td><td>Service-role key for the admin API + Studio.</td></tr>
            </tbody>
          </table>
        </div>

        <h2>On a Raspberry Pi — "shule ndani ya kisanduku"</h2>
        <p>A Pi 4 (4 GB+) or Pi 5 on a 64-bit OS runs the whole stack on a classroom LAN with no internet. All images are multi-arch (<code>linux/arm64</code>).</p>
        ${code('pi.sh', esc(`cp .env.example .env
# Leave CADDY_DOMAIN blank (no public TLS on a LAN box).
# Set POSTGRES_PASSWORD + JWT_SECRET. Optionally CADDY_HTTP=80.

# One-time, with internet, cache the images:
docker compose pull && docker compose build

# Then it starts fully offline:
docker compose up -d
hostname -I            # find the Pi's LAN IP, e.g. 192.168.1.50`))}
        <p>Apps on the same network point at <code>http://192.168.1.50:8088</code> (or <code>raspberrypi.local:8088</code> via mDNS). Services use <code>restart: unless-stopped</code>, so the backend comes back automatically after a power cycle.</p>
        ${note(`<p><strong>microSD cards fail.</strong> Prefer booting from a USB SSD, back up regularly (the VPS <code>pg_dump</code> script works verbatim), copy dumps off the Pi, and use the official PSU — brownouts corrupt data. Treat the card as disposable and the backups as the source of truth.</p>`, 'warn')}

        <h2>Backups &amp; point-in-time recovery</h2>
        <p>A nightly <code>pg_dump</code> (the <code>backup</code> service, or a cron one-liner) gives a daily restore point. <strong>PITR</strong> adds continuous WAL archiving so you can restore to any second between base backups — the difference between "lose up to a day" and "lose up to ~5 minutes". PITR is opt-in: the default <code>docker compose up</code> leaves WAL archiving off until you enable it.</p>
        ${code('backup.sh', esc(`# Daily logical backup, keep 14 days (cron @ 02:30):
docker compose exec -T db \\
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \\
  | gzip > "backups/${'$'}{POSTGRES_DB}_$(date +%F_%H%M).sql.gz"

# Restore:
gunzip -c backups/<file>.sql.gz \\
  | docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"`))}
        <p>PITR needs <code>wal_level=replica</code> + <code>archive_mode=on</code> (provided in <code>db/postgres.conf</code>), a <code>wal_archive</code> volume, and a base backup taken after archiving is on. Restore = base backup + WAL replay up to a <code>recovery_target_time</code>. The full runbook is in <code>docs/PITR.md</code>.</p>

        <h2>Observability</h2>
        <p>Every Node service exposes Prometheus-format metrics on its own internal port (not proxied through Caddy). No external dependency — each ships a tiny metrics registry and renders the text format itself.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Service</th><th>Endpoint</th><th>Service-specific metric</th></tr></thead>
            <tbody>
              <tr><td>auth (9999)</td><td><code>/metrics</code></td><td><code>auth_tokens_issued_total</code></td></tr>
              <tr><td>storage (9998)</td><td><code>/metrics</code></td><td><code>storage_objects_served_total</code></td></tr>
              <tr><td>realtime (9997)</td><td><code>/metrics</code></td><td><code>realtime_active_connections</code>, <code>realtime_active_subscriptions</code></td></tr>
              <tr><td>backup (9994)</td><td><code>/status</code>, <code>/health</code></td><td>JSON status snapshot (last run / success / size / next run)</td></tr>
            </tbody>
          </table>
        </div>
        <p>auth / storage / realtime also expose <code>process_uptime_seconds</code>, <code>http_requests_total{route,status}</code>, and an <code>http_request_duration_seconds</code> histogram. Point a Prometheus on the same Docker network at the service names. Details and a sample <code>prometheus.yml</code> are in <code>docs/OBSERVABILITY.md</code>.</p>
        ${note(`<p><strong>Keep <code>/metrics</code> internal.</strong> It is not authenticated and not proxied through Caddy. If you must reach it from outside, put it behind the edge with auth or an allow-list — don't expose it raw on the internet.</p>`, 'warn')}`,
};

module.exports = [
  home, quickStart, architecture,
  auth, database, storage, realtime, functions,
  admin, cli, selfHosting,
];
