/* build.js — assemble the static docs pages from a shared layout + per-page
   content. Run with `node build.js`. Zero dependencies; emits .html in place.
   This keeps the sidebar / header / footer identical across every page. */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = __dirname;

const BRAND_SVG = `<svg class="brand-mark" width="28" height="28" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="7" fill="#0F2A1D"/><path d="M9 22 L16 8 L23 22" fill="none" stroke="#E0A93B" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="22" r="2.1" fill="#E0A93B"/></svg>`;
const FAVICON = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230F2A1D'/%3E%3Cpath d='M9 22 L16 8 L23 22' fill='none' stroke='%23E0A93B' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='16' cy='22' r='2.1' fill='%23E0A93B'/%3E%3C/svg%3E`;

// Sidebar structure — { group, items:[{href,label}] }
const NAV = [
  { group: 'Anza hapa · Get started', items: [
    { href: 'index.html', label: 'Utangulizi · Intro' },
    { href: 'quick-start.html', label: 'Quick start' },
    { href: 'architecture.html', label: 'Architecture' },
  ]},
  { group: 'SDK · @laetoli/data', items: [
    { href: 'auth.html', label: 'Auth' },
    { href: 'database.html', label: 'Database / PostgREST' },
    { href: 'storage.html', label: 'Storage' },
    { href: 'realtime.html', label: 'Realtime' },
    { href: 'functions.html', label: 'Edge Functions' },
  ]},
  { group: 'Operate · Endesha', items: [
    { href: 'admin.html', label: 'Admin & Studio' },
    { href: 'cli.html', label: 'CLI' },
    { href: 'self-hosting.html', label: 'Self-hosting' },
  ]},
];

// Flat order for prev/next pagers.
const ORDER = NAV.flatMap((g) => g.items);

function sidebar() {
  const groups = NAV.map((g) => {
    const links = g.items
      .map((it) => `<a class="side-link" href="${it.href}">${it.label}</a>`)
      .join('\n          ');
    return `        <div class="side-group">\n          <h4>${g.group}</h4>\n          ${links}\n        </div>`;
  }).join('\n');
  return groups;
}

function pager(file) {
  const i = ORDER.findIndex((x) => x.href === file);
  const prev = i > 0 ? ORDER[i - 1] : null;
  const next = i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1] : null;
  if (!prev && !next) return '';
  const p = prev
    ? `<a class="prev" href="${prev.href}"><span class="dir">← Iliyotangulia</span><span class="ttl">${prev.label}</span></a>`
    : '<span></span>';
  const n = next
    ? `<a class="next" href="${next.href}"><span class="dir">Inayofuata →</span><span class="ttl">${next.label}</span></a>`
    : '';
  return `\n        <nav class="pager" aria-label="Kurasa">\n          ${p}\n          ${n}\n        </nav>`;
}

function page({ file, title, desc, body }) {
  const pg = pager(file);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} · Laetoli Data docs</title>
  <meta name="description" content="${desc}" />
  <meta name="theme-color" content="#0F2A1D" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" />
  <link rel="stylesheet" href="styles.css" />
  <link rel="icon" href="${FAVICON}" />
</head>
<body>
  <a class="skip-link" href="#main">Ruka hadi yaliyomo</a>

  <header class="topbar">
    <button class="menu-toggle" type="button" aria-label="Fungua menyu ya urambazaji" aria-controls="sidebar">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
    </button>
    <a class="brand" href="index.html" aria-label="Laetoli Data docs — nyumbani">
      ${BRAND_SVG}
      <span class="brand-name">Laetoli&nbsp;Data</span>
    </a>
    <span class="topbar-spacer"></span>
    <a class="topbar-link" href="https://github.com/nooher/laetoli-data" rel="noopener">GitHub</a>
  </header>

  <div class="scrim" aria-hidden="true"></div>

  <div class="layout">
    <aside class="sidebar" id="sidebar">
      <nav aria-label="Urambazaji wa nyaraka">
${sidebar()}
      </nav>
    </aside>

    <main class="content" id="main">
      <article class="content-inner">
${body}
${pg}
        <footer class="docs-footer">
          <span>Laetoli Data · sehemu ya stack sovereign ya Laetoli</span>
          <span class="sep">·</span>
          <a href="https://github.com/nooher/laetoli-data" rel="noopener">GitHub</a>
          <span class="sep">·</span>
          <a href="https://laetoli.tz" rel="noopener">laetoli.tz</a>
          <span class="sep">·</span>
          <span>Apache-2.0 · © 2026 Laetoli Ltd</span>
        </footer>
      </article>
    </main>
  </div>

  <script src="docs.js" defer></script>
</body>
</html>
`;
}

// ---- Load page content modules ----------------------------------------
const pages = require('./content.js');

let n = 0;
for (const p of pages) {
  fs.writeFileSync(path.join(OUT, p.file), page(p), 'utf8');
  n++;
}
console.log(`Built ${n} pages.`);
